/**
 * Core domain types.
 *
 * Everything in `src/core` is pure: no I/O, no clocks read from the ambient
 * environment, no database. Time always arrives as an explicit argument so the
 * whole significance engine is deterministic and unit-testable.
 */

/** Epoch milliseconds. Aliased so signatures read unambiguously. */
export type Millis = number;

/** ISO-8601 calendar date in the exchange's local timezone, e.g. "2026-09-04". */
export type SessionDate = string;

export type Direction = "up" | "down" | "flat";

/**
 * How trustworthy the price we are about to show a user is.
 *
 * A watchlist that renders a stale number as if it were live is worse than one
 * that renders nothing, so freshness is part of the domain model rather than a
 * presentation detail.
 */
export type Freshness =
  | "LIVE" // inside the tolerance window for an open market
  | "DELAYED" // late, but still useful
  | "STALE" // old enough that we must say so loudly
  | "AT_CLOSE" // market is shut; this is the settled closing state
  | "UNAVAILABLE"; // we have nothing we are willing to show

export type SessionPhase =
  | "CLOSED"
  | "PRE_OPEN"
  | "OPEN"
  | "CLOSING_AUCTION"
  | "POST_CLOSE";

export interface Quote {
  symbol: string;
  /** Last traded price. */
  price: number;
  /** Previous session's official close, the anchor for "today's change". */
  previousClose: number;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  /** Cumulative traded volume for the session. */
  volume: number | null;
  /** Exchange timestamp for this observation. */
  asOf: Millis;
  /** Best bid/ask when the provider exposes them; used for a liquidity signal. */
  bid?: number | null;
  ask?: number | null;
  /** Provider-reported trading state. */
  halted?: boolean;
  /** Upper/lower circuit bands when known. */
  upperCircuit?: number | null;
  lowerCircuit?: number | null;
}

export interface DailyBar {
  date: SessionDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Pre-computed, per-instrument statistical baseline.
 *
 * This is what makes a 2% move meaningful for one name and noise for another.
 * Recomputed from daily bars on a slow cadence and cached; never recomputed
 * per user or per request.
 */
export interface InstrumentBaseline {
  instrumentId: string;
  /** EWMA daily volatility of log returns, as a fraction (0.018 == 1.8%/day). */
  dailySigma: number;
  /** Number of daily observations behind `dailySigma`. Low counts widen priors. */
  sampleSize: number;
  /** Mean of ln(daily volume) and its stdev, for the volume-surge z-score. */
  logVolumeMean: number;
  logVolumeSigma: number;
  /** Fraction of a normal day's volume expected to have traded by bucket i. */
  volumeProfile: number[];
  /** Rolling extremes used for range-break detection. */
  high52w: number | null;
  low52w: number | null;
  high20d: number | null;
  low20d: number | null;
  /** Median absolute daily return, used to sanity-check absurd provider prints. */
  medianAbsReturn: number;
  computedAt: Millis;
}

export type SignalKind =
  | "PRICE_MOVE"
  | "GAP"
  | "VOLUME_SURGE"
  | "RANGE_BREAK"
  | "TREND_REVERSAL"
  | "LEVEL_CROSS"
  | "CIRCUIT"
  | "HALT"
  | "LIQUIDITY_DROP"
  | "DATA_STALE"
  | "CORPORATE_ACTION";

/**
 * A detector's output before scoring and persistence.
 *
 * `dedupBucket` is the crux of not nagging: two observations of the same
 * developing move collapse onto the same bucket and update one event, while a
 * genuine escalation (1.9σ becoming 3.1σ) lands in a new bucket and is allowed
 * to interrupt the user again.
 */
export interface Signal {
  kind: SignalKind;
  direction: Direction;
  /** Comparable strength within a kind. For σ-based signals this is |z|. */
  magnitude: number;
  /** Discrete escalation bucket; identity of the event within (instrument, kind, day). */
  dedupBucket: string;
  /** Human-facing one-liner; rendered verbatim, so it must already read well. */
  headline: string;
  /** Machine-readable supporting numbers, surfaced in the "why" drawer. */
  evidence: Record<string, number | string | null>;
  /**
   * True when this came out of `change_events` rather than being measured on
   * this request. A stored headline froze its numbers at detection time — a
   * different reference price, a different variance horizon — so it is a
   * historical claim, and anywhere it sits next to a freshly computed figure
   * the two can legitimately disagree. Knowing which is which is what lets the
   * UI avoid putting them side by side as if they were the same measurement.
   */
  stored?: boolean;
}

export interface ScoreContribution {
  kind: SignalKind;
  /** Points this signal added to the final 0-100 score. */
  points: number;
  /** Bounded 0-1 strength before weighting. */
  strength: number;
  weight: number;
  detail: string;
  /** Carried from the signal: was this measured now, or replayed? */
  stored?: boolean;
}

export interface Significance {
  /** 0-100. Not a probability: a ranking device with a stable interpretation. */
  score: number;
  band: "critical" | "high" | "moderate" | "low" | "noise";
  contributions: ScoreContribution[];
  /** Multiplier from the user's stated conviction in this instrument. */
  relevanceMultiplier: number;
  /** Multiplier from repetition suppression and time-since-last-check. */
  noveltyMultiplier: number;
  headline: string;
}

/** How much the user cares about a name; set in the UI, never inferred. */
export type Conviction = "core" | "tracking" | "background";

export interface UserWeighting {
  conviction: Conviction;
  /** User's global "how easily should I be interrupted" dial, 0-100. */
  attentionThreshold: number;
  /** Instrument-level mute until this instant. */
  mutedUntil: Millis | null;
}
