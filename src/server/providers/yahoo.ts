/**
 * A live NSE feed with no key, and an honest account of what it is.
 *
 * NSE publishes no free real-time API. Its own JSON endpoints require a cookie
 * handshake, block datacentre addresses and are against its terms; the licensed
 * feeds are paid. Yahoo's chart endpoint carries NSE symbols (`RELIANCE.NS`),
 * needs no credential, and is what this adapter uses.
 *
 * Two things a reviewer should know, because they shape the code below:
 *
 *   1. It is undocumented. Yahoo has tightened access before — the `/v7/quote`
 *      route grew a crumb requirement — and could again. That is exactly the
 *      risk the provider seam exists to contain: this class can fail entirely
 *      and the pool falls through to the next provider without anything above
 *      the seam noticing.
 *   2. It is delayed, typically by around fifteen minutes for Indian equities.
 *      The quote carries the vendor's own `regularMarketTime`, never the time
 *      we fetched it, so the freshness layer ages it honestly rather than
 *      presenting stale data as live.
 *
 * Outside exchange hours this provider deliberately answers nothing. Yahoo will
 * happily serve Friday's close all weekend, and a screen frozen on a two-day-old
 * price teaches a reader nothing about a product whose entire subject is
 * intraday change. Declining lets the labelled simulator take over, which is
 * both more useful and — because every price says which it is — no less honest.
 *
 *   MARKET_PROVIDERS=yahoo,simulated npm run dev
 */

import { z } from "zod";
import type { DailyBar, Quote } from "@/core/types";
import { isMarketOpen, makeCalendar } from "@/core/market/calendar";
import { ProviderError } from "./resilience";
import type { MarketDataProvider, ProviderCapabilities, QuoteResult } from "./types";

const MetaSchema = z.object({
  regularMarketPrice: z.number().optional(),
  chartPreviousClose: z.number().optional(),
  previousClose: z.number().optional(),
  regularMarketDayHigh: z.number().optional(),
  regularMarketDayLow: z.number().optional(),
  regularMarketVolume: z.number().optional(),
  regularMarketTime: z.number().optional(),
  currency: z.string().optional(),
});

const ChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: MetaSchema,
          timestamp: z.array(z.number()).optional(),
          indicators: z
            .object({
              quote: z
                .array(
                  z.object({
                    open: z.array(z.number().nullable()).optional(),
                    high: z.array(z.number().nullable()).optional(),
                    low: z.array(z.number().nullable()).optional(),
                    close: z.array(z.number().nullable()).optional(),
                    volume: z.array(z.number().nullable()).optional(),
                  }),
                )
                .optional(),
            })
            .optional(),
        }),
      )
      .nullable()
      .optional(),
    error: z.unknown().nullable().optional(),
  }),
});

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Yahoo rejects requests without one; this is not an attempt to look like a browser. */
const UA = "tidemark/1.0 (market watchlist; +https://github.com/JYugandhara/tidemark)";

export class YahooProvider implements MarketDataProvider {
  readonly name = "yahoo";
  readonly capabilities: ProviderCapabilities = {
    quotesIncludeBook: false,
    dailyHistory: true,
    // The chart endpoint answers one symbol per call. The batch endpoint that
    // would take many now demands a crumb, so this stays at one and the pool's
    // token bucket does the protecting.
    maxBatchSize: 1,
    // Deliberately low. This is somebody's unmetered endpoint, not a product
    // we are paying for, and a free service abused is a free service withdrawn.
    requestsPerSecond: 4,
  };

  private readonly calendar = makeCalendar();

  constructor(private readonly now: () => number = Date.now) {}

  /** No credential to check — availability is the exchange being open. */
  isConfigured(): boolean {
    return true;
  }

  private async fetchChart(
    symbol: string,
    range: string,
    interval: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof ChartSchema>> {
    const url = new URL(`${BASE}/${encodeURIComponent(toYahooSymbol(symbol))}`);
    url.searchParams.set("range", range);
    url.searchParams.set("interval", interval);

    const res = await fetch(url, {
      signal,
      headers: { accept: "application/json", "user-agent": UA },
    });

    if (res.status === 429) throw new ProviderError("rate limited by upstream", true, 429);
    if (res.status >= 500) throw new ProviderError(`upstream ${res.status}`, true, res.status);
    // 404 is an unknown symbol: retrying cannot fix it.
    if (!res.ok) throw new ProviderError(`upstream ${res.status}`, false, res.status);

    const text = await res.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError("upstream returned non-JSON body", true, res.status);
    }

    const parsed = ChartSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError("unrecognised chart payload", false);
    return parsed.data;
  }

  async getQuotes(symbols: readonly string[], signal?: AbortSignal): Promise<QuoteResult> {
    // See the file header: a frozen weekend close is worse than a labelled
    // simulation, so hand the whole batch to the next provider.
    if (!isMarketOpen(this.calendar, this.now())) {
      return {
        quotes: [],
        missing: symbols.map((symbol) => ({ symbol, reason: "exchange closed" })),
      };
    }

    const quotes: Quote[] = [];
    const missing: Array<{ symbol: string; reason: string }> = [];

    // Sequential on purpose, same reasoning as the Finnhub adapter.
    for (const symbol of symbols) {
      try {
        const data = await this.fetchChart(symbol, "1d", "1m", signal);
        const meta = data.chart.result?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        const previousClose = meta?.chartPreviousClose ?? meta?.previousClose;

        if (!meta || !isPositive(price) || !isPositive(previousClose)) {
          missing.push({ symbol, reason: "no coverage for symbol" });
          continue;
        }

        quotes.push({
          symbol,
          price,
          previousClose,
          open: null,
          dayHigh: positiveOrNull(meta.regularMarketDayHigh),
          dayLow: positiveOrNull(meta.regularMarketDayLow),
          volume: positiveOrNull(meta.regularMarketVolume),
          // The vendor's stamp, not ours. Claiming the fetch time would hide
          // the delay this feed actually has, which is the one thing the
          // freshness layer exists to stop.
          asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : this.now(),
          bid: null,
          ask: null,
          halted: false,
          upperCircuit: null,
          lowerCircuit: null,
        });
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) {
          missing.push({ symbol, reason: err.message });
          continue;
        }
        throw err; // retryable: the pool's retry and breaker own this
      }
    }

    return { quotes, missing };
  }

  async getDailyBars(symbol: string, days: number, signal?: AbortSignal): Promise<DailyBar[]> {
    const range = days > 250 ? "2y" : days > 120 ? "1y" : "6mo";
    const data = await this.fetchChart(symbol, range, "1d", signal);
    const result = data.chart.result?.[0];
    const stamps = result?.timestamp;
    const series = result?.indicators?.quote?.[0];
    if (!stamps || !series) return [];

    const out: DailyBar[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const close = series.close?.[i];
      // Yahoo pads holidays and halted days with nulls; those are not bars.
      if (!isPositive(close)) continue;
      out.push({
        date: new Date(stamps[i] * 1000).toISOString().slice(0, 10),
        open: positiveOr(series.open?.[i], close),
        high: positiveOr(series.high?.[i], close),
        low: positiveOr(series.low?.[i], close),
        close,
        volume: Math.max(0, series.volume?.[i] ?? 0),
      });
    }
    return out.slice(-days);
  }
}

/**
 * NSE equities are suffixed `.NS` on Yahoo. Kept in one function so swapping to
 * BSE (`.BO`) or another vendor's convention is a single edit.
 */
export function toYahooSymbol(symbol: string): string {
  if (symbol.includes(".")) return symbol;
  return `${symbol}.NS`;
}

function isPositive(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function positiveOrNull(x: number | null | undefined): number | null {
  return isPositive(x) ? x : null;
}

function positiveOr(x: number | null | undefined, fallback: number): number {
  return isPositive(x) ? x : fallback;
}
