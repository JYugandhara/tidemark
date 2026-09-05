/**
 * Resilience primitives for talking to feeds we do not control.
 *
 * Market data providers rate-limit, time out, return HTML error pages with a
 * 200 status, occasionally serve a price with the decimal in the wrong place,
 * and go down entirely during the exact hour they matter most. Everything in
 * this file exists because one of those will happen during the demo.
 *
 * These are deliberately small and dependency-free so they can be unit tested
 * with a fake clock rather than by waiting in real time.
 */

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

/* ------------------------------------------------------------ rate limit -- */

/**
 * Token bucket. Smooths bursts instead of rejecting them: a caller that would
 * exceed the rate waits for a token rather than failing, because a quote that
 * arrives 200ms late is worth far more than a quote that never arrives.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = capacity;
    this.lastRefill = clock();
  }

  private refill(): void {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Milliseconds a caller must wait before `cost` tokens are available. */
  delayFor(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    return Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
  }

  tryTake(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}

/* -------------------------------------------------------- circuit breaker -- */

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  failureThreshold: number;
  openMs: number;
  /** Successes needed in half-open before closing again. */
  halfOpenSuccesses?: number;
  clock?: Clock;
}

/**
 * A breaker that fails fast instead of queueing 400 requests against a dead
 * provider and blowing the poll budget for every healthy one.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private successesInHalfOpen = 0;
  private openedAt = 0;
  private readonly clock: Clock;
  private readonly halfOpenSuccesses: number;

  constructor(
    private readonly name: string,
    private readonly opts: BreakerOptions,
  ) {
    this.clock = opts.clock ?? systemClock;
    this.halfOpenSuccesses = opts.halfOpenSuccesses ?? 2;
  }

  /** Transition open -> half_open once the cooldown has elapsed. */
  private tick(): void {
    if (this.state === "open" && this.clock() - this.openedAt >= this.opts.openMs) {
      this.state = "half_open";
      this.successesInHalfOpen = 0;
    }
  }

  canAttempt(): boolean {
    this.tick();
    return this.state !== "open";
  }

  onSuccess(): void {
    this.tick();
    this.failures = 0;
    if (this.state === "half_open") {
      this.successesInHalfOpen += 1;
      if (this.successesInHalfOpen >= this.halfOpenSuccesses) this.state = "closed";
    } else {
      this.state = "closed";
    }
  }

  onFailure(): void {
    this.tick();
    this.failures += 1;
    // A single failure in half-open sends us straight back to open: the probe
    // told us what we needed to know.
    if (this.state === "half_open" || this.failures >= this.opts.failureThreshold) {
      this.state = "open";
      this.openedAt = this.clock();
    }
  }

  snapshot(): { name: string; state: BreakerState; failures: number; openedAt: number | null } {
    this.tick();
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      openedAt: this.state === "open" ? this.openedAt : null,
    };
  }

  /** Test/ops hook: force the breaker open, e.g. from the scenario injector. */
  forceOpen(): void {
    this.state = "open";
    this.openedAt = this.clock();
  }
}

/* ----------------------------------------------------------------- retry -- */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof Error) {
    // Network-level failures from undici/node.
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|fetch failed/i.test(
      err.message,
    );
  }
  return false;
}

export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) throw new TimeoutError(ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries: number;
  baseMs?: number;
  maxMs?: number;
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Exponential backoff with *full* jitter.
 *
 * Full jitter rather than fixed backoff because every instance polls on the
 * same cadence: without randomisation, a provider blip synchronises all of
 * them and the recovery attempt becomes a second outage.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseMs ?? 150;
  const max = opts.maxMs ?? 4_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.retries || !isRetryable(err)) break;
      const ceiling = Math.min(max, base * 2 ** attempt);
      const delay = Math.floor(random() * ceiling);
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}
