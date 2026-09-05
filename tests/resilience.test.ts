import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  ProviderError,
  TimeoutError,
  TokenBucket,
  isRetryable,
  retry,
  withTimeout,
} from "@/server/providers/resilience";
import { validateQuote } from "@/server/providers/pool";
import type { Quote } from "@/core/types";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("token bucket", () => {
  it("allows a burst up to capacity then throttles", () => {
    const c = fakeClock();
    const b = new TokenBucket(5, 5, c.now);
    for (let i = 0; i < 5; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.delayFor(1)).toBeGreaterThan(0);
  });

  it("refills over time and never exceeds capacity", () => {
    const c = fakeClock();
    const b = new TokenBucket(5, 5, c.now);
    for (let i = 0; i < 5; i++) b.tryTake();
    c.advance(400);
    expect(b.tryTake()).toBe(true); // 2 tokens refilled
    c.advance(60_000);
    expect(b.available).toBeLessThanOrEqual(5);
  });
});

describe("circuit breaker", () => {
  it("opens after the threshold and fails fast", () => {
    const c = fakeClock();
    const b = new CircuitBreaker("p", { failureThreshold: 3, openMs: 1000, clock: c.now });
    expect(b.canAttempt()).toBe(true);
    b.onFailure();
    b.onFailure();
    expect(b.canAttempt()).toBe(true);
    b.onFailure();
    expect(b.canAttempt()).toBe(false);
    expect(b.snapshot().state).toBe("open");
  });

  it("half-opens after the cooldown and needs consecutive successes to close", () => {
    const c = fakeClock();
    const b = new CircuitBreaker("p", {
      failureThreshold: 1,
      openMs: 1000,
      halfOpenSuccesses: 2,
      clock: c.now,
    });
    b.onFailure();
    expect(b.canAttempt()).toBe(false);
    c.advance(1001);
    expect(b.canAttempt()).toBe(true);
    expect(b.snapshot().state).toBe("half_open");
    b.onSuccess();
    expect(b.snapshot().state).toBe("half_open");
    b.onSuccess();
    expect(b.snapshot().state).toBe("closed");
  });

  it("returns to open immediately if the probe fails", () => {
    const c = fakeClock();
    const b = new CircuitBreaker("p", { failureThreshold: 2, openMs: 500, clock: c.now });
    b.onFailure();
    b.onFailure();
    c.advance(501);
    expect(b.canAttempt()).toBe(true);
    b.onFailure();
    expect(b.canAttempt()).toBe(false);
  });

  it("can be forced open by the scenario injector", () => {
    const b = new CircuitBreaker("p", { failureThreshold: 99, openMs: 1000 });
    b.forceOpen();
    expect(b.canAttempt()).toBe(false);
  });
});

describe("timeout and retry", () => {
  it("aborts a hanging call and reports a TimeoutError", async () => {
    await expect(
      withTimeout(20, (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("retries retryable failures with jittered backoff and gives up eventually", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const out = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ProviderError("upstream 503", true, 503);
        return "ok";
      },
      { retries: 3, sleep, random: () => 0.5 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // Full jitter: delay is a random fraction of an exponentially growing cap.
    expect(sleep.mock.calls.map((c) => (c as unknown as number[])[0])).toEqual([75, 150]);
  });

  it("does not retry a non-retryable failure", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new ProviderError("bad api key", false, 401);
        },
        { retries: 5, sleep },
      ),
    ).rejects.toThrow("bad api key");
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("classifies network errors as retryable", () => {
    expect(isRetryable(new Error("fetch failed"))).toBe(true);
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryable(new Error("something else"))).toBe(false);
    expect(isRetryable(new TimeoutError(10))).toBe(true);
  });
});

describe("quote sanity filter", () => {
  const base: Quote = {
    symbol: "X",
    price: 100,
    previousClose: 99,
    open: 99.5,
    dayHigh: 101,
    dayLow: 98,
    volume: 1000,
    asOf: 1_000_000,
  };
  const now = 1_000_000;

  it("accepts a normal quote", () => {
    expect(validateQuote(base, undefined, now).ok).toBe(true);
  });

  it("rejects structurally impossible quotes", () => {
    expect(validateQuote({ ...base, price: 0 }, undefined, now).ok).toBe(false);
    expect(validateQuote({ ...base, previousClose: 0 }, undefined, now).ok).toBe(false);
    expect(validateQuote({ ...base, volume: -5 }, undefined, now).ok).toBe(false);
    expect(validateQuote({ ...base, dayHigh: 90, dayLow: 95 }, undefined, now).ok).toBe(false);
    expect(validateQuote({ ...base, asOf: now + 10 * 60_000 }, undefined, now).ok).toBe(false);
    expect(validateQuote({ ...base, asOf: now - 60 * 86_400_000 }, undefined, now).ok).toBe(false);
  });

  it("rejects a decimal-point error but keeps a real circuit move", () => {
    const last = { price: 100, tolerance: 0.35 };
    expect(validateQuote({ ...base, price: 10 }, last, now).ok).toBe(false);
    expect(validateQuote({ ...base, price: 120 }, last, now).ok).toBe(true);
  });
});
