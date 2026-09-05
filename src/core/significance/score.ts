/**
 * Scoring: turning a bag of signals into one number a human can rank by.
 *
 * Three properties this had to have, in priority order:
 *
 *  1. **Explainable.** Every point in the score is attributable to a named
 *     signal, and the UI shows that attribution. A ranking a user cannot
 *     interrogate is a ranking they will stop trusting the first time it is
 *     wrong.
 *  2. **Saturating.** A single 12σ print — nearly always a bad tick — must not
 *     be able to outvote every other instrument. Each signal's strength is
 *     bounded to 0-1 before weighting, and the sum is squashed again.
 *  3. **Personal, but only in ways the user chose.** Relevance comes from a
 *     conviction level the user set explicitly. Nothing here infers what
 *     someone "probably" cares about from their behaviour.
 */

import type {
  Conviction,
  ScoreContribution,
  Significance,
  Signal,
  SignalKind,
  UserWeighting,
} from "../types";
import { clamp, saturate } from "../stats";

/**
 * Weights are deliberately hand-set rather than learned. With no labelled data
 * on the first day of a product, a transparent prior beats a fitted model
 * nobody can debug — and the weights are exposed in the UI so a user can see
 * exactly what the system values.
 */
export const SIGNAL_WEIGHTS: Record<SignalKind, number> = {
  LEVEL_CROSS: 1.35, // the user asked for this by name; honour it above all
  HALT: 1.3,
  PRICE_MOVE: 1.0,
  CIRCUIT: 1.05,
  GAP: 0.9,
  RANGE_BREAK: 0.7,
  CORPORATE_ACTION: 0.6,
  VOLUME_SURGE: 0.55,
  TREND_REVERSAL: 0.5,
  DATA_STALE: 0.45,
  LIQUIDITY_DROP: 0.4,
};

/** Where each signal's strength curve bends, in its own natural units. */
const SATURATION_SCALE: Record<SignalKind, number> = {
  PRICE_MOVE: 2.5,
  GAP: 2.0,
  VOLUME_SURGE: 2.0,
  RANGE_BREAK: 1.4,
  TREND_REVERSAL: 2.0,
  LEVEL_CROSS: 1.5,
  CIRCUIT: 2.0,
  HALT: 2.0,
  LIQUIDITY_DROP: 2.0,
  DATA_STALE: 2.0,
  CORPORATE_ACTION: 2.0,
};

export const CONVICTION_MULTIPLIER: Record<Conviction, number> = {
  core: 1.25,
  tracking: 1.0,
  background: 0.72,
};

/** Controls how fast the squash approaches 100. Tuned so ~1.15 raw ≈ 63. */
const SQUASH_K = 1.15;

export interface NoveltyInput {
  /** How many times this exact event has already been surfaced to this user. */
  timesShown: number;
  /** Market-time hours since the user last opened the app. */
  hoursSinceLastCheck: number;
}

export function noveltyMultiplier(n: NoveltyInput): number {
  // Seeing the same story a third time makes it less worth interrupting for —
  // but the *second* viewing must not be penalised. A live page re-renders on
  // its own, and a story that loses a third of its score the moment the reader
  // glances away and back is a story the system will hide from them while it is
  // still true. The offset is what makes "shown once" free.
  const repeatSuppression = 1 / (1 + 0.45 * Math.max(0, n.timesShown - 1));

  // A move you have not seen in three days is more newsworthy than the same
  // move five minutes ago, so absence lifts the score — but only up to 25%, and
  // never below 1.0: arriving fresh must not be a penalty.
  const absenceBoost = clamp(
    1 + 0.08 * Math.log2(1 + Math.max(0, n.hoursSinceLastCheck)),
    1,
    1.25,
  );
  return repeatSuppression * absenceBoost;
}

export function bandFor(score: number): Significance["band"] {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "moderate";
  if (score >= 20) return "low";
  return "noise";
}

/**
 * Collapse signals of the same kind, keeping the strongest. Two 20-day range
 * breaks in the same tick are one fact, not two.
 */
function strongestPerKind(signals: readonly Signal[]): Signal[] {
  const best = new Map<SignalKind, Signal>();
  for (const s of signals) {
    const prev = best.get(s.kind);
    if (!prev || s.magnitude > prev.magnitude) best.set(s.kind, s);
  }
  return [...best.values()];
}

export function scoreSignals(
  signals: readonly Signal[],
  weighting: UserWeighting,
  novelty: NoveltyInput,
  now = 0,
): Significance {
  const muted = weighting.mutedUntil !== null && now < weighting.mutedUntil;
  const chosen = strongestPerKind(signals);

  if (chosen.length === 0 || muted) {
    return {
      score: 0,
      band: "noise",
      contributions: [],
      relevanceMultiplier: CONVICTION_MULTIPLIER[weighting.conviction],
      noveltyMultiplier: muted ? 0 : noveltyMultiplier(novelty),
      headline: muted ? "Muted by you" : "Nothing meaningful changed",
    };
  }

  const relevance = CONVICTION_MULTIPLIER[weighting.conviction];
  const nov = noveltyMultiplier(novelty);

  let raw = 0;
  const parts: Array<{ signal: Signal; weighted: number; strength: number }> = [];
  for (const s of chosen) {
    const weight = SIGNAL_WEIGHTS[s.kind] ?? 0.5;
    const strength = saturate(s.magnitude, SATURATION_SCALE[s.kind] ?? 2);
    const weighted = weight * strength;
    raw += weighted;
    parts.push({ signal: s, weighted, strength });
  }

  const base = 100 * (1 - Math.exp(-raw / SQUASH_K));
  const score = clamp(base * relevance * nov, 0, 100);

  const totalWeighted = parts.reduce((a, p) => a + p.weighted, 0) || 1;
  const contributions: ScoreContribution[] = parts
    .map((p) => ({
      kind: p.signal.kind,
      points: Number(((p.weighted / totalWeighted) * score).toFixed(1)),
      strength: Number(p.strength.toFixed(3)),
      weight: SIGNAL_WEIGHTS[p.signal.kind] ?? 0.5,
      detail: p.signal.headline,
    }))
    .sort((a, b) => b.points - a.points);

  return {
    score: Number(score.toFixed(1)),
    band: bandFor(score),
    contributions,
    relevanceMultiplier: relevance,
    noveltyMultiplier: Number(nov.toFixed(3)),
    headline: contributions[0]?.detail ?? chosen[0].headline,
  };
}

/**
 * The empty state is a feature, not a fallback. When nothing crossed the bar we
 * say *why* — "moved 0.4%, which is a quarter of a normal day for this name" —
 * so the user can trust the silence instead of refreshing to double-check.
 */
export function quietReason(input: {
  sigmaMultiple: number | null;
  returnPct: number | null;
  isStale: boolean;
  isMuted: boolean;
}): string {
  if (input.isMuted) return "Muted by you";
  if (input.isStale) return "No fresh data — not scored";
  if (input.sigmaMultiple === null || input.returnPct === null) return "No change to report";
  // Below a basis point of movement, quoting a sigma is false precision.
  if (Math.abs(input.returnPct) < 0.0005) return "Barely moved";
  // The row already shows the percentage; repeating it here wastes the line
  // that should be doing the explaining.
  const s = input.sigmaMultiple;
  if (s < 0.5) return `${s.toFixed(1)}σ — well inside its normal day`;
  if (s < 1) return `${s.toFixed(1)}σ — an ordinary move for this name`;
  return `${s.toFixed(1)}σ — noticeable, but not unusual for this name`;
}
