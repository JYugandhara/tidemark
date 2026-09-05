/**
 * The provider seam.
 *
 * Everything above this interface — detection, scoring, the digest, the UI —
 * is written against `Quote` and `DailyBar` and has no idea whether the bytes
 * came from a paid feed, a free API, or the simulator. That is what makes it
 * possible to demonstrate a circuit breaker opening on stage without waiting
 * for a real vendor to have a bad day.
 */

import type { DailyBar, Quote } from "@/core/types";

export interface ProviderCapabilities {
  /** Does this provider expose bid/ask? Drives the liquidity signal. */
  quotesIncludeBook: boolean;
  /** Can it serve daily history for baselines? */
  dailyHistory: boolean;
  /** Symbols per request the provider will accept. */
  maxBatchSize: number;
  /** Sustained requests per second we are allowed. */
  requestsPerSecond: number;
}

export interface QuoteResult {
  quotes: Quote[];
  /** Symbols the provider could not answer for, with a reason. */
  missing: Array<{ symbol: string; reason: string }>;
}

export interface MarketDataProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** True when the provider is configured well enough to be used at all. */
  isConfigured(): boolean;
  getQuotes(symbols: readonly string[], signal?: AbortSignal): Promise<QuoteResult>;
  getDailyBars(symbol: string, days: number, signal?: AbortSignal): Promise<DailyBar[]>;
}

export interface ProviderAttempt {
  provider: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  breakerState?: string;
}
