/**
 * Turning observed cumulative volume into a per-instrument intraday shape.
 *
 * Pure, because the arithmetic here is the part that can be quietly wrong: a
 * missing bucket, a session that stopped early, or a provider that resets its
 * volume counter mid-day all produce a plausible-looking but useless profile
 * unless they are handled explicitly.
 */

import { VOLUME_BUCKETS } from "./baseline";

export interface ObservedProfile {
  /** Mean share of daily volume per bucket; sums to 1. */
  shares: number[];
  /** How many completed sessions the mean is built from. */
  samples: number;
}

/**
 * Convert one session's cumulative-volume readings into per-bucket shares.
 *
 * Returns null when the session is not usable: too few observations, or no
 * volume at all. Half a session's data is worse than none, because it would
 * teach the model that the afternoon does not exist.
 */
export function sessionShares(
  cumulative: ReadonlyArray<number | null>,
  minBuckets = 18,
): number[] | null {
  if (cumulative.length !== VOLUME_BUCKETS) return null;

  const observed = cumulative.filter((c) => c !== null && Number.isFinite(c)).length;
  if (observed < minBuckets) return null;

  // Carry the last known reading forward across gaps, and force monotonicity:
  // a cumulative counter that goes down means the feed reset, not that shares
  // were negative.
  const filled: number[] = [];
  let last = 0;
  for (let i = 0; i < VOLUME_BUCKETS; i++) {
    const v = cumulative[i];
    last = v !== null && Number.isFinite(v) ? Math.max(last, v) : last;
    filled.push(last);
  }

  const total = filled[VOLUME_BUCKETS - 1];
  if (!(total > 0)) return null;

  const shares: number[] = [];
  let prev = 0;
  for (let i = 0; i < VOLUME_BUCKETS; i++) {
    shares.push(Math.max(0, filled[i] - prev) / total);
    prev = filled[i];
  }
  return shares;
}

/**
 * Fold a new session into the running mean.
 *
 * A plain incremental mean rather than an EWMA: intraday shape is a structural
 * property of how an instrument trades, and unlike volatility it does not
 * cluster. A single unusual day — an index rebalance, an expiry — should move
 * it by 1/n, not by a decay factor.
 */
export function foldObservedProfile(
  existing: ObservedProfile | null,
  session: readonly number[],
): ObservedProfile {
  if (session.length !== VOLUME_BUCKETS) return existing ?? { shares: [], samples: 0 };

  if (!existing || existing.samples <= 0 || existing.shares.length !== VOLUME_BUCKETS) {
    return { shares: [...session], samples: 1 };
  }

  const n = existing.samples + 1;
  const shares = existing.shares.map((mean, i) => mean + (session[i] - mean) / n);

  // Renormalise: floating-point drift over hundreds of folds is small, but a
  // profile that does not sum to 1 silently biases every volume comparison.
  const total = shares.reduce((a, b) => a + b, 0) || 1;
  return { shares: shares.map((s) => s / total), samples: Math.min(n, 500) };
}

/** Which 15-minute bucket a given fraction through the session falls in. */
export function bucketFor(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const b = Math.floor(progress * VOLUME_BUCKETS);
  return Math.max(0, Math.min(VOLUME_BUCKETS - 1, b));
}
