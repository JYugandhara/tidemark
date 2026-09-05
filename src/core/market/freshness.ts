/**
 * Freshness classification.
 *
 * The product rule this encodes: never render a number without also rendering
 * how old it is, and never render a number we cannot vouch for at all. A blank
 * cell that says "no data since 14:02" is more useful to someone about to make
 * a decision than a confident-looking stale price.
 */

import type { Freshness, Millis, SessionPhase } from "../types";

export interface FreshnessThresholds {
  /** Beyond this, an open-market quote stops being "LIVE". */
  liveMs: number;
  delayedMs: number;
  staleMs: number;
}

export const DEFAULT_THRESHOLDS: FreshnessThresholds = {
  liveMs: 20_000,
  delayedMs: 120_000,
  staleMs: 900_000,
};

export function classifyFreshness(
  /**
   * The phase of the session the reader is actually looking at. Taking this as
   * an argument rather than deriving it from the wall clock is what keeps
   * freshness honest under the simulator: a generated session that is open
   * must not report its prices as settled closing values.
   */
  phase: SessionPhase,
  asOf: Millis | null,
  now: Millis,
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): { freshness: Freshness; ageMs: number } {
  if (asOf === null || !Number.isFinite(asOf)) {
    return { freshness: "UNAVAILABLE", ageMs: Number.POSITIVE_INFINITY };
  }
  const ageMs = Math.max(0, now - asOf);

  if (phase !== "OPEN" && phase !== "PRE_OPEN" && phase !== "CLOSING_AUCTION") {
    // Outside the session nothing is expected to tick. An hours-old price is
    // the correct, settled answer; only a multi-day-old one is a problem.
    return { freshness: ageMs > 4 * 86_400_000 ? "STALE" : "AT_CLOSE", ageMs };
  }
  if (ageMs <= thresholds.liveMs) return { freshness: "LIVE", ageMs };
  if (ageMs <= thresholds.delayedMs) return { freshness: "DELAYED", ageMs };
  if (ageMs <= thresholds.staleMs) return { freshness: "STALE", ageMs };
  return { freshness: "UNAVAILABLE", ageMs };
}

/** Whether a quote in this state may be used to raise an alert. */
export function isActionable(freshness: Freshness): boolean {
  return freshness === "LIVE" || freshness === "DELAYED" || freshness === "AT_CLOSE";
}

export function describeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "no data";
  const s = Math.floor(ageMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
