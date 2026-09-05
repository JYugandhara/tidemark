/**
 * The provider pool: one place where every rule about talking to upstreams is
 * applied, so no individual provider has to remember them.
 *
 * Order of defence for a single batch of symbols:
 *
 *   1. Circuit breaker — if this provider is known-bad, skip it instantly
 *      rather than spending the poll budget discovering that again.
 *   2. Token bucket — never exceed the rate we are entitled to. Waiting is
 *      cheaper than being banned mid-session.
 *   3. Timeout — an upstream that never answers is worse than one that errors,
 *      because it holds the loop.
 *   4. Retry with full jitter — only for errors that can plausibly succeed on
 *      a second attempt.
 *   5. Failover — symbols the primary could not answer for are re-asked of the
 *      next provider, so a partial outage degrades to partial data rather than
 *      to none.
 *   6. Sanity filter — anything that survives all of that still has to look
 *      like a price before it is allowed into the database.
 */

import type { DailyBar, Quote } from "@/core/types";
import { config } from "../config";
import { execute } from "../db/client";
import {
  CircuitBreaker,
  ProviderError,
  TokenBucket,
  retry,
  systemClock,
  withTimeout,
  type Clock,
} from "./resilience";
import type { MarketDataProvider, ProviderAttempt, QuoteResult } from "./types";
import { SimulatedProvider } from "./simulated";
import { FinnhubProvider } from "./finnhub";
import { YahooProvider } from "./yahoo";

export interface PoolQuoteResult extends QuoteResult {
  attempts: ProviderAttempt[];
  /** Which provider each symbol's quote actually came from. */
  sources: Record<string, string>;
  rejected: Array<{ symbol: string; reason: string; provider: string }>;
}

interface Entry {
  provider: MarketDataProvider;
  breaker: CircuitBreaker;
  bucket: TokenBucket;
}

export class ProviderPool {
  private readonly entries: Entry[];
  private readonly clock: Clock;

  constructor(providers: readonly MarketDataProvider[], clock: Clock = systemClock) {
    this.clock = clock;
    this.entries = providers
      .filter((p) => p.isConfigured())
      .map((provider) => ({
        provider,
        breaker: new CircuitBreaker(provider.name, {
          failureThreshold: config.BREAKER_FAILURE_THRESHOLD,
          openMs: config.BREAKER_OPEN_MS,
          clock,
        }),
        bucket: new TokenBucket(
          Math.max(1, provider.capabilities.requestsPerSecond),
          provider.capabilities.requestsPerSecond,
          clock,
        ),
      }));
  }

  get providerNames(): string[] {
    return this.entries.map((e) => e.provider.name);
  }

  /** Health snapshot for /api/health and the Feed Room panel. */
  snapshot() {
    return this.entries.map((e) => ({
      ...e.breaker.snapshot(),
      tokensAvailable: Number(e.bucket.available.toFixed(2)),
      capabilities: e.provider.capabilities,
    }));
  }

  /** Ops hook used by the scenario injector to force a provider down. */
  forceOpen(providerName: string): boolean {
    const e = this.entries.find((x) => x.provider.name === providerName);
    if (!e) return false;
    e.breaker.forceOpen();
    return true;
  }

  private async callWithGuards<T>(entry: Entry, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!entry.breaker.canAttempt()) {
      throw new ProviderError(`${entry.provider.name} circuit open`, false, 503);
    }
    const wait = entry.bucket.delayFor(1);
    if (wait > 0) await sleep(Math.min(wait, 2_000));
    if (!entry.bucket.tryTake(1)) {
      throw new ProviderError(`${entry.provider.name} rate limited locally`, true, 429);
    }

    try {
      const out = await retry(
        () => withTimeout(config.PROVIDER_TIMEOUT_MS, (signal) => fn(signal)),
        { retries: config.PROVIDER_MAX_RETRIES },
      );
      entry.breaker.onSuccess();
      return out;
    } catch (err) {
      entry.breaker.onFailure();
      throw err;
    }
  }

  /**
   * Fetch quotes, falling through providers for whatever is still missing.
   * `lastKnown` is used only for the plausibility check, never as a value.
   */
  async getQuotes(
    symbols: readonly string[],
    lastKnown: ReadonlyMap<string, { price: number; tolerance: number }> = new Map(),
  ): Promise<PoolQuoteResult> {
    const attempts: ProviderAttempt[] = [];
    const sources: Record<string, string> = {};
    const rejected: PoolQuoteResult["rejected"] = [];
    const collected = new Map<string, Quote>();
    const reasons = new Map<string, string>();
    let outstanding = [...new Set(symbols)];

    for (const entry of this.entries) {
      if (outstanding.length === 0) break;
      const batchSize = Math.min(
        config.QUOTE_BATCH_SIZE,
        entry.provider.capabilities.maxBatchSize,
      );

      for (const batch of chunk(outstanding, batchSize)) {
        const started = this.clock();
        try {
          const res = await this.callWithGuards(entry, (signal) =>
            entry.provider.getQuotes(batch, signal),
          );
          attempts.push({
            provider: entry.provider.name,
            ok: true,
            latencyMs: this.clock() - started,
            breakerState: entry.breaker.snapshot().state,
          });

          for (const q of res.quotes) {
            const verdict = validateQuote(q, lastKnown.get(q.symbol), this.clock());
            if (!verdict.ok) {
              rejected.push({
                symbol: q.symbol,
                reason: verdict.reason,
                provider: entry.provider.name,
              });
              reasons.set(q.symbol, verdict.reason);
              continue;
            }
            collected.set(q.symbol, q);
            sources[q.symbol] = entry.provider.name;
          }
          for (const m of res.missing) reasons.set(m.symbol, m.reason);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          attempts.push({
            provider: entry.provider.name,
            ok: false,
            latencyMs: this.clock() - started,
            error: message,
            breakerState: entry.breaker.snapshot().state,
          });
          for (const s of batch) reasons.set(s, message);
        }
      }
      outstanding = outstanding.filter((s) => !collected.has(s));
    }

    void this.persistHealth(attempts);

    return {
      quotes: [...collected.values()],
      missing: outstanding.map((s) => ({ symbol: s, reason: reasons.get(s) ?? "no provider answered" })),
      attempts,
      sources,
      rejected,
    };
  }

  async getDailyBars(symbol: string, days: number): Promise<{ bars: DailyBar[]; provider: string | null }> {
    for (const entry of this.entries) {
      if (!entry.provider.capabilities.dailyHistory) continue;
      try {
        const bars = await this.callWithGuards(entry, (signal) =>
          entry.provider.getDailyBars(symbol, days, signal),
        );
        if (bars.length > 0) return { bars, provider: entry.provider.name };
      } catch {
        // Try the next provider; history is not urgent enough to fail the caller.
      }
    }
    return { bars: [], provider: null };
  }

  private async persistHealth(attempts: readonly ProviderAttempt[]): Promise<void> {
    if (attempts.length === 0) return;
    const byProvider = new Map<string, { calls: number; failures: number; lastError?: string }>();
    for (const a of attempts) {
      const cur = byProvider.get(a.provider) ?? { calls: 0, failures: 0 };
      cur.calls += 1;
      if (!a.ok) {
        cur.failures += 1;
        cur.lastError = a.error;
      }
      byProvider.set(a.provider, cur);
    }

    for (const [name, stats] of byProvider) {
      const snap = this.entries.find((e) => e.provider.name === name)?.breaker.snapshot();
      try {
        await execute(
          `INSERT INTO provider_health
             (provider, state, consecutive_failures, opened_at, last_success_at, last_error, calls, failures, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (provider) DO UPDATE SET
             state = EXCLUDED.state,
             consecutive_failures = EXCLUDED.consecutive_failures,
             opened_at = EXCLUDED.opened_at,
             last_success_at = COALESCE(EXCLUDED.last_success_at, provider_health.last_success_at),
             last_error = COALESCE(EXCLUDED.last_error, provider_health.last_error),
             calls = provider_health.calls + EXCLUDED.calls,
             failures = provider_health.failures + EXCLUDED.failures,
             updated_at = now()`,
          [
            name,
            snap?.state ?? "closed",
            snap?.failures ?? 0,
            snap?.openedAt ? new Date(snap.openedAt) : null,
            stats.failures < stats.calls ? new Date() : null,
            stats.lastError ?? null,
            stats.calls,
            stats.failures,
          ],
        );
      } catch {
        // Health telemetry must never be able to break ingestion.
      }
    }
  }
}

/**
 * The last line of defence before bad data becomes a user-visible event.
 *
 * Rejecting is deliberately conservative: a real 20% circuit move must get
 * through, while a decimal-point error must not. The tolerance comes from the
 * instrument's own volatility, computed by the caller.
 */
export function validateQuote(
  q: Quote,
  last: { price: number; tolerance: number } | undefined,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(q.price) || q.price <= 0) return { ok: false, reason: "non-positive price" };
  if (!Number.isFinite(q.previousClose) || q.previousClose <= 0)
    return { ok: false, reason: "missing previous close" };
  if (!Number.isFinite(q.asOf)) return { ok: false, reason: "missing timestamp" };
  // Allow a little clock skew, reject a timestamp from next week.
  if (q.asOf > now + 120_000) return { ok: false, reason: "timestamp in the future" };
  if (q.asOf < now - 30 * 86_400_000) return { ok: false, reason: "timestamp older than 30 days" };
  if (q.volume !== null && q.volume !== undefined && q.volume < 0)
    return { ok: false, reason: "negative volume" };
  if (q.dayHigh !== null && q.dayLow !== null && q.dayHigh < q.dayLow)
    return { ok: false, reason: "high below low" };

  if (last) {
    const move = Math.abs(Math.log(q.price / last.price));
    if (Number.isFinite(move) && move > last.tolerance) {
      const change = ((q.price - last.price) / last.price) * 100;
      return {
        ok: false,
        reason:
          `implausible ${change >= 0 ? "+" : ""}${change.toFixed(1)}% jump ` +
          `(${last.price.toFixed(2)} -> ${q.price.toFixed(2)}) vs last known`,
      };
    }
  }
  return { ok: true };
}

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, size)) out.push(xs.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------- singleton -- */

let poolInstance: ProviderPool | null = null;

export function buildProviders(): MarketDataProvider[] {
  const registry: Record<string, () => MarketDataProvider> = {
    simulated: () => new SimulatedProvider(),
    finnhub: () => new FinnhubProvider(),
    yahoo: () => new YahooProvider(),
  };
  const chosen = config.MARKET_PROVIDERS.map((n) => registry[n]?.()).filter(
    (p): p is MarketDataProvider => Boolean(p),
  );
  // The simulator is always available as a last resort so the product degrades
  // to "clearly labelled synthetic data" rather than to a blank screen.
  if (!chosen.some((p) => p.name === "simulated")) chosen.push(new SimulatedProvider());
  return chosen;
}

export function getProviderPool(): ProviderPool {
  poolInstance ??= new ProviderPool(buildProviders());
  return poolInstance;
}
