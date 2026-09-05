/**
 * Signal detection.
 *
 * A detector answers one narrow question about one instrument and returns zero
 * or more candidate `Signal`s. Detectors never decide whether the user should
 * be interrupted — that is the scorer's job — and they never touch I/O.
 *
 * The design rule every detector follows: emit a *bucketed* signal, not a
 * continuous one. Buckets are what turn "this stock has been drifting up for
 * four hours" into one event that escalates from 1σ to 2σ to 3σ, instead of
 * 240 near-identical notifications. The bucket string becomes the row's dedup
 * key in Postgres, so idempotency is enforced by a unique index rather than by
 * hoping the worker runs exactly once.
 */

import type {
  Direction,
  Freshness,
  InstrumentBaseline,
  Millis,
  Quote,
  SessionDate,
  Signal,
} from "../types";
import {
  MIN_SIGMA,
  clamp,
  isFinitePositive,
  logReturn,
  pctChange,
  scaleSigma,
  shrinkageAdjustedSigma,
  zScore,
} from "../stats";
import { OVERNIGHT_VARIANCE_SHARE } from "../market/calendar";
import {
  horizonSincePreviousClose,
  type MarketClock,
  type MarketSession,
} from "../market/clock";

export interface AlertRule {
  id: string;
  kind: "above" | "below";
  level: number;
  /** Rules disarm after firing so a price hovering on the line fires once. */
  armed: boolean;
}

export interface CorporateAction {
  id: string;
  kind: "dividend" | "split" | "bonus" | "earnings" | "agm";
  effectiveDate: SessionDate;
  note: string | null;
}

export interface ReferencePoint {
  price: number;
  asOf: Millis;
  /** True when the reference is the previous close rather than a user visit. */
  isPreviousClose: boolean;
  /** Sign of (referencePrice - previousClose) at reference time. */
  directionAtReference: Direction;
}

export interface DetectionContext {
  now: Millis;
  /** Where the market is, real or generated. Never re-derived from `now`. */
  session: MarketSession;
  clock: MarketClock;
  symbol: string;
  displayName: string;
  baseline: InstrumentBaseline;
  quote: Quote;
  freshness: Freshness;
  reference: ReferencePoint;
  alerts: readonly AlertRule[];
  corporateActions: readonly CorporateAction[];
  /** Typical full-day volume, exp(logVolumeMean); passed in to keep this pure. */
  typicalDailyVolume: number | null;
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

function dirOf(x: number, epsilon = 1e-9): Direction {
  if (x > epsilon) return "up";
  if (x < -epsilon) return "down";
  return "flat";
}

/**
 * Sigma appropriate for the interval between the reference and the quote,
 * measured in market time. Falls back to a single-session sigma when the
 * horizon is degenerate (clock skew, reference in the future).
 */
export function intervalSigma(ctx: DetectionContext): {
  sigma: number;
  horizon: number;
} {
  const daily = shrinkageAdjustedSigma(
    ctx.baseline.dailySigma,
    ctx.baseline.sampleSize,
  );
  // "Since the previous close" is answered from session progress, not from a
  // timestamp difference: the previous close and this quote are not on the
  // same timeline when the session is generated, and differencing them was
  // producing horizons near zero and therefore 12-sigma readings on a 2% day.
  const horizonRaw = ctx.reference.isPreviousClose
    ? horizonSincePreviousClose(ctx.session.progress)
    : ctx.clock.horizon(ctx.reference.asOf, Math.max(ctx.quote.asOf, ctx.reference.asOf));
  // A reference taken seconds ago still carries the risk of the next tick;
  // floor the horizon at one minute of session time so z-scores stay sane.
  const horizon = Math.max(horizonRaw, 1 / 375);
  return { sigma: Math.max(scaleSigma(daily, horizon), MIN_SIGMA), horizon };
}

/** Bucket |z| into integer sigma steps: 1σ, 2σ, 3σ, capped at 6σ. */
function sigmaBucket(z: number): number {
  return Math.min(6, Math.floor(Math.abs(z)));
}

export function detectPriceMove(ctx: DetectionContext): Signal[] {
  const { quote, reference } = ctx;
  if (!isFinitePositive(quote.price) || !isFinitePositive(reference.price)) return [];

  const ret = pctChange(reference.price, quote.price);
  const { sigma, horizon } = intervalSigma(ctx);
  const z = zScore(logReturn(reference.price, quote.price), sigma);
  const bucket = sigmaBucket(z);
  if (bucket < 1) return [];

  const direction = dirOf(ret);
  const sinceLabel = reference.isPreviousClose
    ? "since yesterday's close"
    : "since you last checked";

  return [
    {
      kind: "PRICE_MOVE",
      direction,
      magnitude: Math.abs(z),
      dedupBucket: `move:${direction}:${bucket}`,
      headline: `${ctx.symbol} ${direction === "up" ? "up" : "down"} ${pct(
        Math.abs(ret),
      )} ${sinceLabel} — a ${Math.abs(z).toFixed(1)}σ move`,
      evidence: {
        returnPct: Number((ret * 100).toFixed(3)),
        sigmaMultiple: Number(Math.abs(z).toFixed(2)),
        intervalSigmaPct: Number((sigma * 100).toFixed(3)),
        varianceHorizonDays: Number(horizon.toFixed(4)),
        referencePrice: reference.price,
        referenceKind: reference.isPreviousClose ? "previous_close" : "last_seen",
      },
    },
  ];
}

export function detectGap(ctx: DetectionContext): Signal[] {
  const { quote, baseline, session } = ctx;
  if (session.phase === "CLOSED" || session.phase === "PRE_OPEN") return [];
  if (!isFinitePositive(quote.open) || !isFinitePositive(quote.previousClose)) return [];

  const gap = pctChange(quote.previousClose, quote.open as number);
  const daily = shrinkageAdjustedSigma(baseline.dailySigma, baseline.sampleSize);
  const overnightSigma = scaleSigma(daily, OVERNIGHT_VARIANCE_SHARE);
  const z = zScore(gap, overnightSigma);
  if (Math.abs(z) < 1.2) return [];

  const direction = dirOf(gap);
  return [
    {
      kind: "GAP",
      direction,
      magnitude: Math.abs(z),
      dedupBucket: `gap:${session.sessionDate}:${sigmaBucket(z)}`,
      headline: `${ctx.symbol} gapped ${direction} ${pct(Math.abs(gap))} at the open`,
      evidence: {
        gapPct: Number((gap * 100).toFixed(3)),
        sigmaMultiple: Number(Math.abs(z).toFixed(2)),
        open: quote.open,
        previousClose: quote.previousClose,
      },
    },
  ];
}

/**
 * Volume is compared against the *shape* of a normal day, not against the
 * full-day average. At 09:45 a stock has legitimately traded ~12% of its daily
 * volume; comparing that to the daily mean would flag every name every morning.
 */
export function detectVolumeSurge(ctx: DetectionContext): Signal[] {
  const { quote, baseline, session, typicalDailyVolume } = ctx;
  if (!isFinitePositive(quote.volume) || !isFinitePositive(typicalDailyVolume)) return [];
  if (session.phase === "CLOSED" || session.phase === "PRE_OPEN") return [];

  const progress = session.progress;
  const expectedShare = expectedVolumeShare(baseline.volumeProfile, progress);
  if (expectedShare <= 0.005) return []; // too early to say anything

  const expected = (typicalDailyVolume as number) * expectedShare;
  if (!isFinitePositive(expected)) return [];

  const ratio = (quote.volume as number) / expected;
  if (!Number.isFinite(ratio) || ratio <= 0) return [];

  const sigma = Math.max(baseline.logVolumeSigma, 0.12);
  const z = zScore(Math.log(ratio), sigma);
  if (ratio < 1.75 || z < 1) return [];

  const bucket = clamp(Math.floor(Math.log2(ratio)), 0, 5);
  return [
    {
      kind: "VOLUME_SURGE",
      direction: "up",
      magnitude: z,
      dedupBucket: `vol:${session.sessionDate}:${bucket}`,
      headline: `${ctx.symbol} trading on ${ratio.toFixed(1)}× its usual volume for this time of day`,
      evidence: {
        volume: quote.volume,
        expectedVolume: Math.round(expected),
        ratio: Number(ratio.toFixed(2)),
        sigmaMultiple: Number(z.toFixed(2)),
        sessionProgress: Number(progress.toFixed(3)),
      },
    },
  ];
}

/** Cumulative share of daily volume expected by `progress` through the session. */
export function expectedVolumeShare(profile: readonly number[], progress: number): number {
  if (profile.length === 0) return clamp(progress, 0, 1);
  const p = clamp(progress, 0, 1);
  const exact = p * profile.length;
  const idx = Math.min(profile.length - 1, Math.floor(exact));
  let cum = 0;
  for (let i = 0; i < idx; i++) cum += profile[i];
  cum += profile[idx] * (exact - idx);
  const total = profile.reduce((a, b) => a + b, 0) || 1;
  return clamp(cum / total, 0, 1);
}

export function detectRangeBreak(ctx: DetectionContext): Signal[] {
  const { quote, baseline, session } = ctx;
  if (!isFinitePositive(quote.price)) return [];
  const out: Signal[] = [];
  const day = session.sessionDate;

  const checks: Array<{
    level: number | null;
    window: string;
    direction: Direction;
    label: string;
    weightHint: number;
  }> = [
    { level: baseline.high52w, window: "52w", direction: "up", label: "52-week high", weightHint: 1 },
    { level: baseline.low52w, window: "52w", direction: "down", label: "52-week low", weightHint: 1 },
    { level: baseline.high20d, window: "20d", direction: "up", label: "20-day high", weightHint: 0.6 },
    { level: baseline.low20d, window: "20d", direction: "down", label: "20-day low", weightHint: 0.6 },
  ];

  for (const c of checks) {
    if (!isFinitePositive(c.level)) continue;
    const level = c.level as number;
    const broke = c.direction === "up" ? quote.price > level : quote.price < level;
    if (!broke) continue;
    const distance = Math.abs(pctChange(level, quote.price));
    out.push({
      kind: "RANGE_BREAK",
      direction: c.direction,
      magnitude: c.weightHint * (1 + Math.min(distance * 20, 2)),
      dedupBucket: `range:${c.window}:${c.direction}:${day}`,
      headline: `${ctx.symbol} broke its ${c.label} (${quote.price.toFixed(2)} vs ${level.toFixed(2)})`,
      evidence: {
        window: c.window,
        level,
        price: quote.price,
        beyondPct: Number((distance * 100).toFixed(3)),
      },
    });
  }
  // A 52-week break implies the 20-day one; keep only the stronger statement.
  const has52 = out.some((s) => s.evidence.window === "52w");
  return has52 ? out.filter((s) => s.evidence.window === "52w") : out;
}

/**
 * A stock that was up 2% when you looked and is now down 1% has "changed" far
 * more than one that simply went from up 2% to up 3%, even though the second
 * moved further in price terms. Direction flips are their own signal.
 */
export function detectTrendReversal(ctx: DetectionContext): Signal[] {
  const { quote, reference } = ctx;
  if (reference.isPreviousClose) return []; // no prior direction to flip
  if (!isFinitePositive(quote.previousClose) || !isFinitePositive(quote.price)) return [];

  const nowDir = dirOf(pctChange(quote.previousClose, quote.price), 0.001);
  const thenDir = reference.directionAtReference;
  if (nowDir === "flat" || thenDir === "flat" || nowDir === thenDir) return [];

  const { sigma } = intervalSigma(ctx);
  const z = Math.abs(zScore(logReturn(reference.price, quote.price), sigma));
  if (z < 1.2) return [];

  return [
    {
      kind: "TREND_REVERSAL",
      direction: nowDir,
      magnitude: z,
      dedupBucket: `rev:${nowDir}:${sigmaBucket(z)}`,
      headline: `${ctx.symbol} flipped from ${thenDir} to ${nowDir} on the day since you last checked`,
      evidence: {
        directionAtLastCheck: thenDir,
        directionNow: nowDir,
        dayChangePct: Number((pctChange(quote.previousClose, quote.price) * 100).toFixed(3)),
        sigmaMultiple: Number(z.toFixed(2)),
      },
    },
  ];
}

export function detectLevelCross(ctx: DetectionContext): Signal[] {
  const { quote, reference, alerts } = ctx;
  if (!isFinitePositive(quote.price)) return [];
  const out: Signal[] = [];

  for (const rule of alerts) {
    // A disarmed rule has already fired; it re-arms only when the price comes
    // back through the level, which is handled where rules are persisted.
    if (!rule.armed) continue;
    // Fire on the transition, never on the state. A price that merely sits
    // above the level (because the rule was created below the market) does not
    // produce an alert every poll.
    const crossedUp =
      rule.kind === "above" && reference.price <= rule.level && quote.price > rule.level;
    const crossedDown =
      rule.kind === "below" && reference.price >= rule.level && quote.price < rule.level;
    if (!crossedUp && !crossedDown) continue;

    out.push({
      kind: "LEVEL_CROSS",
      direction: rule.kind === "above" ? "up" : "down",
      magnitude: 3,
      dedupBucket: `alert:${rule.id}`,
      headline: `${ctx.symbol} crossed ${rule.kind} your ${rule.level.toFixed(2)} alert`,
      evidence: { ruleId: rule.id, level: rule.level, price: quote.price },
    });
  }
  return out;
}

export function detectCircuitAndHalt(ctx: DetectionContext): Signal[] {
  const { quote, session } = ctx;
  const day = session.sessionDate;
  const out: Signal[] = [];

  if (quote.halted) {
    out.push({
      kind: "HALT",
      direction: "flat",
      magnitude: 4,
      dedupBucket: `halt:${day}`,
      headline: `${ctx.symbol} is halted — no trading right now`,
      evidence: { lastPrice: quote.price, asOf: quote.asOf },
    });
  }

  const near = (band: number | null | undefined, side: "upper" | "lower") => {
    if (!isFinitePositive(band) || !isFinitePositive(quote.price)) return;
    const distance = Math.abs(pctChange(band as number, quote.price));
    if (distance > 0.0025) return;
    out.push({
      kind: "CIRCUIT",
      direction: side === "upper" ? "up" : "down",
      magnitude: 3.5,
      dedupBucket: `circuit:${side}:${day}`,
      headline: `${ctx.symbol} is at its ${side} circuit (${(band as number).toFixed(2)})`,
      evidence: { side, band: band as number, price: quote.price },
    });
  };
  near(quote.upperCircuit, "upper");
  near(quote.lowerCircuit, "lower");
  return out;
}

export function detectLiquidityDrop(ctx: DetectionContext): Signal[] {
  const { quote, session } = ctx;
  if (!isFinitePositive(quote.bid) || !isFinitePositive(quote.ask)) return [];
  const bid = quote.bid as number;
  const ask = quote.ask as number;
  if (ask <= bid) return [];
  const mid = (ask + bid) / 2;
  const spread = (ask - bid) / mid;
  if (spread < 0.008) return [];
  return [
    {
      kind: "LIQUIDITY_DROP",
      direction: "flat",
      magnitude: 1 + Math.min(spread * 50, 3),
      dedupBucket: `liq:${session.sessionDate}:${Math.floor(spread * 200)}`,
      headline: `${ctx.symbol} spread widened to ${pct(spread)} — thin book`,
      evidence: { bid, ask, spreadPct: Number((spread * 100).toFixed(3)) },
    },
  ];
}

/**
 * Missing data is itself news. If the feed for one of your core holdings went
 * quiet twenty minutes ago while the market is open, that is something you
 * should be told, not something we should paper over with the last price.
 */
export function detectDataStale(ctx: DetectionContext): Signal[] {
  const { freshness, session, now, quote } = ctx;
  if (session.phase !== "OPEN") return [];
  if (freshness !== "STALE" && freshness !== "UNAVAILABLE") return [];
  const ageMin = Math.floor((now - quote.asOf) / 60_000);
  return [
    {
      kind: "DATA_STALE",
      direction: "flat",
      magnitude: freshness === "UNAVAILABLE" ? 3 : 1.8,
      dedupBucket: `stale:${session.sessionDate}:${Math.floor(ageMin / 15)}`,
      headline: `No fresh price for ${ctx.symbol} in ${ageMin} minutes while the market is open`,
      evidence: { freshness, ageMinutes: ageMin, lastAsOf: quote.asOf },
    },
  ];
}

export function detectCorporateActions(ctx: DetectionContext): Signal[] {
  const day = ctx.session.sessionDate;
  return ctx.corporateActions
    .filter((ca) => ca.effectiveDate >= day)
    .filter((ca) => daysBetween(day, ca.effectiveDate) <= 5)
    .map((ca) => ({
      kind: "CORPORATE_ACTION" as const,
      direction: "flat" as Direction,
      magnitude: ca.kind === "earnings" ? 2.2 : 1.6,
      dedupBucket: `ca:${ca.id}`,
      headline:
        ca.effectiveDate === day
          ? `${ctx.symbol} ${describeAction(ca)} today`
          : `${ctx.symbol} ${describeAction(ca)} on ${ca.effectiveDate}`,
      evidence: {
        actionKind: ca.kind,
        effectiveDate: ca.effectiveDate,
        note: ca.note,
      },
    }));
}

function describeAction(ca: CorporateAction): string {
  switch (ca.kind) {
    case "dividend":
      return "goes ex-dividend";
    case "split":
      return "splits";
    case "bonus":
      return "issues bonus shares";
    case "earnings":
      return "reports earnings";
    default:
      return "holds its AGM";
  }
}

function daysBetween(a: SessionDate, b: SessionDate): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

const DETECTORS: Array<(ctx: DetectionContext) => Signal[]> = [
  detectPriceMove,
  detectGap,
  detectVolumeSurge,
  detectRangeBreak,
  detectTrendReversal,
  detectLevelCross,
  detectCircuitAndHalt,
  detectLiquidityDrop,
  detectDataStale,
  detectCorporateActions,
];

/**
 * Run every detector. One misbehaving detector must not take down ingestion
 * for the whole instrument, so failures are contained and reported rather than
 * thrown — the remaining signals are still worth having.
 */
export function detectSignals(ctx: DetectionContext): {
  signals: Signal[];
  failures: Array<{ detector: string; message: string }>;
} {
  const signals: Signal[] = [];
  const failures: Array<{ detector: string; message: string }> = [];
  for (const d of DETECTORS) {
    try {
      signals.push(...d(ctx));
    } catch (err) {
      failures.push({
        detector: d.name || "anonymous",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { signals, failures };
}

export { signed };
