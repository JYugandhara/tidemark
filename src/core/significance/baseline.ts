/**
 * Baseline construction: everything we need to know about "normal" for one
 * instrument, derived from its own history.
 *
 * Computed on a slow cadence (daily, plus on first subscription) and cached on
 * the instrument row. Nothing here is per-user, so the cost is O(instruments)
 * no matter how many people are watching.
 */

import type { DailyBar, InstrumentBaseline, Millis } from "../types";
import {
  MIN_SIGMA,
  RunningStats,
  clamp,
  ewmaVolatility,
  isFinitePositive,
  logReturn,
  median,
} from "../stats";

/** Number of intraday buckets in a volume profile (15 minutes each, 375/25). */
export const VOLUME_BUCKETS = 25;

/**
 * Default intraday volume shape: heavy at the open, a midday trough, a bump
 * into the close. Used until an instrument has accumulated enough of its own
 * intraday observations to replace it. Normalised to sum to 1.
 */
export function defaultVolumeProfile(buckets = VOLUME_BUCKETS): number[] {
  const raw: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const t = (i + 0.5) / buckets; // 0..1 through the session
    // U-shape: a decaying open burst plus a rising close burst plus a floor.
    const open = 2.4 * Math.exp(-t * 6);
    const close = 1.5 * Math.exp(-(1 - t) * 7);
    raw.push(open + close + 0.55);
  }
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / total);
}

export interface BaselineInput {
  instrumentId: string;
  bars: readonly DailyBar[];
  /** Optional observed profile; blended with the default by sample weight. */
  observedProfile?: { shares: readonly number[]; samples: number } | null;
  now: Millis;
}

export function buildBaseline(input: BaselineInput): InstrumentBaseline {
  const bars = [...input.bars]
    .filter((b) => isFinitePositive(b.close))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    returns.push(logReturn(bars[i - 1].close, bars[i].close));
  }

  const dailySigma = returns.length ? ewmaVolatility(returns) : MIN_SIGMA * 6;

  const volStats = new RunningStats();
  for (const b of bars) {
    if (isFinitePositive(b.volume)) volStats.push(Math.log(b.volume));
  }

  const last252 = bars.slice(-252);
  const last20 = bars.slice(-20);

  return {
    instrumentId: input.instrumentId,
    dailySigma,
    sampleSize: returns.length,
    logVolumeMean: volStats.count ? volStats.mean : 0,
    logVolumeSigma: volStats.count > 2 ? Math.max(volStats.stdev, 0.12) : 0.45,
    volumeProfile: blendProfile(input.observedProfile),
    high52w: extreme(last252, "high", Math.max),
    low52w: extreme(last252, "low", Math.min),
    high20d: extreme(last20, "high", Math.max),
    low20d: extreme(last20, "low", Math.min),
    medianAbsReturn: returns.length ? median(returns.map(Math.abs)) : 0.01,
    computedAt: input.now,
  };
}

function extreme(
  bars: readonly DailyBar[],
  field: "high" | "low",
  pick: (a: number, b: number) => number,
): number | null {
  let out: number | null = null;
  for (const b of bars) {
    const v = b[field];
    if (!isFinitePositive(v)) continue;
    out = out === null ? v : pick(out, v);
  }
  return out;
}

/**
 * Blend the instrument's own observed intraday shape with the generic one,
 * weighted by how many sessions we have observed. With three days of data the
 * generic shape still dominates; after thirty the instrument's own shape does.
 */
function blendProfile(
  observed: BaselineInput["observedProfile"],
): number[] {
  const base = defaultVolumeProfile();
  if (!observed || observed.samples <= 0 || observed.shares.length !== base.length) {
    return base;
  }
  const w = clamp(observed.samples / (observed.samples + 20), 0, 0.9);
  const blended = base.map((b, i) => (1 - w) * b + w * (observed.shares[i] ?? b));
  const total = blended.reduce((a, b) => a + b, 0) || 1;
  return blended.map((x) => x / total);
}

/** Typical full-day volume implied by the baseline, or null if unknown. */
export function typicalDailyVolume(b: InstrumentBaseline): number | null {
  if (!b.logVolumeMean) return null;
  const v = Math.exp(b.logVolumeMean);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Sanity filter for provider prints.
 *
 * Feeds send bad data: a decimal in the wrong place, a stale symbol mapping, a
 * zero. A tick that implies a move many multiples beyond anything the
 * instrument has ever done in a day is rejected rather than allowed to define
 * a new 52-week high and page the user at 2am.
 */
export function isPlausiblePrice(
  price: number,
  reference: number,
  baseline: InstrumentBaseline,
): boolean {
  if (!isFinitePositive(price) || !isFinitePositive(reference)) return false;
  const move = Math.abs(Math.log(price / reference));
  const tolerance = Math.max(
    0.35, // never reject a move smaller than ~35%; halts and gaps are real
    12 * Math.max(baseline.dailySigma, baseline.medianAbsReturn, MIN_SIGMA),
  );
  return move <= tolerance;
}
