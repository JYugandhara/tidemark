import { afterEach, describe, expect, it, vi } from "vitest";
import { istInstant } from "@/core/market/calendar";
import { YahooProvider, toYahooSymbol } from "@/server/providers/yahoo";
import { ProviderError } from "@/server/providers/resilience";

/** 2026-09-07 is a Monday; 2026-09-05 a Saturday. */
const OPEN = istInstant("2026-09-07", 12 * 60);
const WEEKEND = istInstant("2026-09-05", 12 * 60);

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function chart(meta: Record<string, unknown>) {
  return { chart: { result: [{ meta }], error: null } };
}

afterEach(() => vi.unstubAllGlobals());

describe("the Yahoo adapter defends its boundary", () => {
  it("maps NSE tickers to the vendor's suffix", () => {
    expect(toYahooSymbol("RELIANCE")).toBe("RELIANCE.NS");
    // Already-qualified symbols pass through, so BSE or an index still works.
    expect(toYahooSymbol("RELIANCE.BO")).toBe("RELIANCE.BO");
  });

  it("declines the whole batch when the exchange is shut", async () => {
    const spy = stubFetch(200, chart({ regularMarketPrice: 1, chartPreviousClose: 1 }));
    const res = await new YahooProvider(() => WEEKEND).getQuotes(["RELIANCE", "TCS"]);

    // Nothing was even asked for: a frozen Friday close is worse than the
    // labelled simulator, so the pool is handed both symbols to fall through.
    expect(spy).not.toHaveBeenCalled();
    expect(res.quotes).toEqual([]);
    expect(res.missing.map((m) => m.symbol)).toEqual(["RELIANCE", "TCS"]);
    expect(res.missing[0].reason).toBe("exchange closed");
  });

  it("reports the vendor's timestamp, not the time we fetched", async () => {
    const vendorSeconds = Math.floor((OPEN - 15 * 60_000) / 1000);
    stubFetch(
      200,
      chart({
        regularMarketPrice: 1421.5,
        chartPreviousClose: 1400,
        regularMarketDayHigh: 1430,
        regularMarketDayLow: 1398,
        regularMarketVolume: 812_000,
        regularMarketTime: vendorSeconds,
      }),
    );
    const res = await new YahooProvider(() => OPEN).getQuotes(["RELIANCE"]);

    expect(res.quotes).toHaveLength(1);
    const q = res.quotes[0];
    expect(q.price).toBe(1421.5);
    expect(q.previousClose).toBe(1400);
    // A quarter-hour behind, and it says so. Stamping the fetch time here would
    // hide the delay this feed actually has.
    expect(q.asOf).toBe(vendorSeconds * 1000);
    expect(q.asOf).toBeLessThan(OPEN);
  });

  it("treats a symbol with no usable price as missing, not as a zero", async () => {
    stubFetch(200, chart({ regularMarketPrice: 0, chartPreviousClose: 0 }));
    const res = await new YahooProvider(() => OPEN).getQuotes(["NOTREAL"]);

    expect(res.quotes).toEqual([]);
    expect(res.missing[0].reason).toBe("no coverage for symbol");
  });

  it("survives a payload that is valid JSON but the wrong shape", async () => {
    stubFetch(200, { unexpected: true });
    const res = await new YahooProvider(() => OPEN).getQuotes(["RELIANCE"]);
    // Parsed, rejected, reported — never allowed to become a Quote.
    expect(res.quotes).toEqual([]);
    expect(res.missing).toHaveLength(1);
  });

  it("classifies upstream failures so the breaker sees only the retryable ones", async () => {
    stubFetch(429, {});
    await expect(new YahooProvider(() => OPEN).getDailyBars("RELIANCE", 5)).rejects.toMatchObject({
      retryable: true,
    });

    stubFetch(503, {});
    await expect(new YahooProvider(() => OPEN).getDailyBars("RELIANCE", 5)).rejects.toMatchObject({
      retryable: true,
    });

    // A 404 is an unknown ticker. Retrying cannot fix it and would burn the
    // budget the symbols that do exist need.
    stubFetch(404, {});
    const err = await new YahooProvider(() => OPEN)
      .getDailyBars("NOPE", 5)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("drops the null rows Yahoo pads holidays with", async () => {
    stubFetch(200, {
      chart: {
        result: [
          {
            meta: {},
            timestamp: [1_756_000_000, 1_756_086_400, 1_756_172_800],
            indicators: {
              quote: [
                {
                  open: [100, null, 104],
                  high: [102, null, 106],
                  low: [99, null, 103],
                  close: [101, null, 105],
                  volume: [5000, null, 7000],
                },
              ],
            },
          },
        ],
      },
    });
    const bars = await new YahooProvider(() => OPEN).getDailyBars("RELIANCE", 10);

    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.close)).toEqual([101, 105]);
    expect(bars[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
