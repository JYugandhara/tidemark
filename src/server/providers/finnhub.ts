/**
 * A real upstream, wired the way a real upstream has to be wired.
 *
 * Finnhub is used because it has a free tier that covers NSE symbols. The
 * point of this file is not the vendor: it is that the boundary is defended.
 * Every response is parsed through a schema before it is allowed to become a
 * `Quote`, because "the JSON had the right shape" is an assumption that fails
 * in production far more often than the network does.
 *
 * Set FINNHUB_API_KEY and MARKET_PROVIDERS=finnhub,simulated to run against it
 * with the simulator as a fallback.
 */

import { z } from "zod";
import type { DailyBar, Quote } from "@/core/types";
import { config } from "../config";
import { ProviderError } from "./resilience";
import type { MarketDataProvider, ProviderCapabilities, QuoteResult } from "./types";

const QuoteSchema = z.object({
  c: z.number(), // current
  h: z.number(), // high
  l: z.number(), // low
  o: z.number(), // open
  pc: z.number(), // previous close
  t: z.number(), // unix seconds
});

const CandleSchema = z.object({
  s: z.string(),
  t: z.array(z.number()).optional(),
  o: z.array(z.number()).optional(),
  h: z.array(z.number()).optional(),
  l: z.array(z.number()).optional(),
  c: z.array(z.number()).optional(),
  v: z.array(z.number()).optional(),
});

const BASE = "https://finnhub.io/api/v1";

export class FinnhubProvider implements MarketDataProvider {
  readonly name = "finnhub";
  readonly capabilities: ProviderCapabilities = {
    quotesIncludeBook: false,
    dailyHistory: true,
    // Finnhub's quote endpoint is one symbol per call; the pool fans out and
    // the rate limiter is what actually protects us.
    maxBatchSize: 1,
    requestsPerSecond: 25,
  };

  constructor(private readonly apiKey: string | undefined = config.FINNHUB_API_KEY) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 8);
  }

  private url(path: string, params: Record<string, string>): string {
    const u = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("token", this.apiKey ?? "");
    return u.toString();
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(url, { signal, headers: { accept: "application/json" } });
    if (res.status === 429) {
      throw new ProviderError("rate limited by upstream", true, 429);
    }
    if (res.status >= 500) {
      throw new ProviderError(`upstream ${res.status}`, true, res.status);
    }
    if (!res.ok) {
      // 4xx other than 429 is our bug (bad symbol, bad key). Retrying will not
      // help and would burn quota we need for the symbols that do work.
      throw new ProviderError(`upstream ${res.status}`, false, res.status);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError("upstream returned non-JSON body", true, res.status);
    }
  }

  async getQuotes(symbols: readonly string[], signal?: AbortSignal): Promise<QuoteResult> {
    if (!this.isConfigured()) throw new ProviderError("FINNHUB_API_KEY not set", false);

    const quotes: Quote[] = [];
    const missing: Array<{ symbol: string; reason: string }> = [];

    // Sequential rather than Promise.all: the shared token bucket in the pool
    // has already sized this batch, and hammering a free tier in parallel is
    // how a key gets banned mid-demo.
    for (const symbol of symbols) {
      try {
        const raw = await this.fetchJson(
          this.url("/quote", { symbol: toVendorSymbol(symbol) }),
          signal,
        );
        const parsed = QuoteSchema.safeParse(raw);
        if (!parsed.success) {
          missing.push({ symbol, reason: "unparseable quote payload" });
          continue;
        }
        const q = parsed.data;
        // Finnhub answers with all zeroes for symbols it does not carry.
        if (q.c <= 0 || q.pc <= 0) {
          missing.push({ symbol, reason: "no coverage for symbol" });
          continue;
        }
        quotes.push({
          symbol,
          price: q.c,
          previousClose: q.pc,
          open: q.o || null,
          dayHigh: q.h || null,
          dayLow: q.l || null,
          volume: null,
          asOf: q.t > 0 ? q.t * 1000 : Date.now(),
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
        throw err; // retryable: let the pool's retry/breaker handle it
      }
    }
    return { quotes, missing };
  }

  async getDailyBars(symbol: string, days: number, signal?: AbortSignal): Promise<DailyBar[]> {
    if (!this.isConfigured()) throw new ProviderError("FINNHUB_API_KEY not set", false);
    const to = Math.floor(Date.now() / 1000);
    const from = to - Math.ceil(days * 1.6) * 86_400;
    const raw = await this.fetchJson(
      this.url("/stock/candle", {
        symbol: toVendorSymbol(symbol),
        resolution: "D",
        from: String(from),
        to: String(to),
      }),
      signal,
    );
    const parsed = CandleSchema.safeParse(raw);
    if (!parsed.success || parsed.data.s !== "ok") return [];
    const d = parsed.data;
    const stamps = d.t;
    if (!stamps) return [];
    const out: DailyBar[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const close = d.c?.[i];
      if (!close || close <= 0) continue;
      out.push({
        date: new Date(stamps[i] * 1000).toISOString().slice(0, 10),
        open: d.o?.[i] ?? close,
        high: d.h?.[i] ?? close,
        low: d.l?.[i] ?? close,
        close,
        volume: d.v?.[i] ?? 0,
      });
    }
    return out.slice(-days);
  }
}

/** NSE tickers are namespaced upstream. Kept in one place so it is easy to swap. */
export function toVendorSymbol(symbol: string): string {
  return symbol.includes(":") ? symbol : `NSE:${symbol}`;
}
