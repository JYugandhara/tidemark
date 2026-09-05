/**
 * The digest: "what actually changed since you last looked".
 *
 * This is where the two halves of the system meet.
 *
 *   Instrument-level events are produced once by the ingestion worker,
 *   independent of how many people watch the name. Gaps, volume surges,
 *   52-week breaks, halts and feed outages are facts about the market, so
 *   computing them per user would be pure waste — a name held by 50,000 users
 *   costs exactly the same to analyse as one held by a single user.
 *
 *   User-level signals must be computed per reader, because they are defined
 *   relative to *that person's* watermark: the move since they last looked,
 *   the direction flip since they last looked, their own price alerts. These
 *   are a handful of arithmetic operations over data already in memory.
 *
 * `buildDigest` merges the two, scores them with the reader's weighting, and
 * splits the result into what deserves attention and what explicitly does not.
 */

import type {
  Freshness,
  InstrumentBaseline,
  Millis,
  Quote,
  Significance,
  Signal,
} from "../types";
import type { MarketClock, MarketSession } from "../market/clock";
import { pctChange } from "../stats";
import {
  type AlertRule,
  type CorporateAction,
  type DetectionContext,
  type ReferencePoint,
  detectLevelCross,
  detectPriceMove,
  detectTrendReversal,
  intervalSigma,
} from "../significance/detect";
import { quietReason, scoreSignals } from "../significance/score";
import type { UserWeighting } from "../types";

/** An instrument-level event already persisted by the worker. */
export interface StoredEvent {
  id: string;
  seq: number;
  kind: Signal["kind"];
  direction: Signal["direction"];
  magnitude: number;
  dedupBucket: string;
  headline: string;
  evidence: Record<string, unknown>;
  firstSeenAt: Millis;
  lastUpdatedAt: Millis;
}

export interface DigestItemInput {
  instrumentId: string;
  symbol: string;
  name: string;
  quote: Quote | null;
  freshness: Freshness;
  baseline: InstrumentBaseline;
  typicalDailyVolume: number | null;
  weighting: UserWeighting;
  reference: ReferencePoint | null;
  alerts: readonly AlertRule[];
  corporateActions: readonly CorporateAction[];
  /** Instrument-level events the reader has not acknowledged yet. */
  unseenEvents: readonly StoredEvent[];
  /** How many times each dedup bucket has already been shown to this reader. */
  timesShown: Readonly<Record<string, number>>;
}

export interface DigestEntry {
  instrumentId: string;
  symbol: string;
  name: string;
  significance: Significance;
  signals: Signal[];
  /** Sequence numbers this entry is built from; the client acknowledges these. */
  eventSeqs: number[];
  price: number | null;
  changeSinceReferencePct: number | null;
  changeTodayPct: number | null;
  sigmaMultiple: number | null;
  freshness: Freshness;
  asOf: Millis | null;
  referenceLabel: string;
  quiet: boolean;
  quietReason: string | null;
}

export interface DigestOptions {
  now: Millis;
  clock: MarketClock;
  session: MarketSession;
  /** Score below which an entry is filed under "quiet" instead of "attention". */
  attentionThreshold: number;
  /** Market-time hours since this reader last opened the app. */
  hoursSinceLastCheck: number;
}

export interface Digest {
  attention: DigestEntry[];
  quiet: DigestEntry[];
  generatedAt: Millis;
  /** Highest sequence number represented anywhere in this digest. */
  highWaterSeq: number;
  summary: {
    watched: number;
    needingAttention: number;
    unavailable: number;
    topHeadline: string | null;
  };
}

function eventToSignal(e: StoredEvent): Signal {
  return {
    kind: e.kind,
    direction: e.direction,
    magnitude: e.magnitude,
    dedupBucket: e.dedupBucket,
    headline: e.headline,
    evidence: e.evidence as Signal["evidence"],
    stored: true,
  };
}

export function buildDigestEntry(
  item: DigestItemInput,
  opts: DigestOptions,
): DigestEntry {
  const { quote, reference } = item;

  // No quote at all: still surface the instrument, but say so honestly instead
  // of dropping it from the list where the user would never notice.
  if (!quote || item.freshness === "UNAVAILABLE") {
    const signals = item.unseenEvents.map(eventToSignal);
    const significance = scoreSignals(
      signals,
      item.weighting,
      {
        timesShown: maxTimesShown(item, signals),
        hoursSinceLastCheck: opts.hoursSinceLastCheck,
      },
      opts.now,
    );
    return {
      instrumentId: item.instrumentId,
      symbol: item.symbol,
      name: item.name,
      significance,
      signals,
      eventSeqs: item.unseenEvents.map((e) => e.seq),
      price: quote?.price ?? null,
      changeSinceReferencePct: null,
      changeTodayPct: null,
      sigmaMultiple: null,
      freshness: item.freshness,
      asOf: quote?.asOf ?? null,
      referenceLabel: "no data",
      quiet: significance.score < opts.attentionThreshold,
      quietReason: quietReason({
        sigmaMultiple: null,
        returnPct: null,
        isStale: true,
        isMuted: false,
      }),
    };
  }

  const ref: ReferencePoint = reference ?? {
    price: quote.previousClose,
    asOf: quote.asOf,
    isPreviousClose: true,
    directionAtReference: "flat",
  };

  const ctx: DetectionContext = {
    now: opts.now,
    session: opts.session,
    clock: opts.clock,
    symbol: item.symbol,
    displayName: item.name,
    baseline: item.baseline,
    quote,
    freshness: item.freshness,
    reference: ref,
    alerts: item.alerts,
    corporateActions: item.corporateActions,
    typicalDailyVolume: item.typicalDailyVolume,
  };

  // Reader-relative signals, computed here; everything else came from the worker.
  const userSignals: Signal[] = [
    ...safe(() => detectPriceMove(ctx)),
    ...safe(() => detectTrendReversal(ctx)),
    ...safe(() => detectLevelCross(ctx)),
  ];
  const signals = [...userSignals, ...item.unseenEvents.map(eventToSignal)];

  const significance = scoreSignals(
    signals,
    item.weighting,
    {
      timesShown: maxTimesShown(item, signals),
      hoursSinceLastCheck: opts.hoursSinceLastCheck,
    },
    opts.now,
  );

  const { sigma } = intervalSigma(ctx);
  const changeSinceRef = pctChange(ref.price, quote.price);
  const sigmaMultiple = sigma > 0 ? Math.abs(changeSinceRef) / sigma : null;
  const quiet = significance.score < opts.attentionThreshold;

  return {
    instrumentId: item.instrumentId,
    symbol: item.symbol,
    name: item.name,
    significance,
    signals,
    eventSeqs: item.unseenEvents.map((e) => e.seq),
    price: quote.price,
    changeSinceReferencePct: changeSinceRef,
    changeTodayPct: pctChange(quote.previousClose, quote.price),
    sigmaMultiple,
    freshness: item.freshness,
    asOf: quote.asOf,
    referenceLabel: ref.isPreviousClose ? "since yesterday's close" : "since you last checked",
    quiet,
    // A quiet row still has to say what the system *did* consider. An 8x
    // volume surge that scored 38 is not "an ordinary move" — it is a real
    // signal that landed under the line, and a reader who cannot see that will
    // stop believing the quiet list.
    quietReason: quiet
      ? explainQuiet(significance, item.symbol, {
          sigmaMultiple,
          returnPct: changeSinceRef,
          isStale: item.freshness === "STALE",
          isMuted: item.weighting.mutedUntil !== null && opts.now < item.weighting.mutedUntil,
        })
      : null,
  };
}

function explainQuiet(
  significance: Significance,
  symbol: string,
  fallback: Parameters<typeof quietReason>[0],
): string {
  if (fallback.isMuted || fallback.isStale) return quietReason(fallback);
  if (significance.contributions.length === 0 || significance.score <= 0) {
    return quietReason(fallback);
  }
  // Prefer a contribution measured on this request. A stored event's sentence
  // carries the sigma it was detected with, against whatever reference applied
  // then; the row's own sigma column is computed now, against the reader's
  // current watermark. Both are true and they can differ, but sitting on one
  // line they read as a contradiction. Taking the live one where there is a
  // live one makes the row internally consistent by construction.
  const top =
    significance.contributions.find((c) => !c.stored) ?? significance.contributions[0];
  return `${stripSymbol(top.detail, symbol)} — ${Math.round(significance.score)}/100, under your line`;
}

/** Headlines lead with the ticker; the row already shows it. */
function stripSymbol(headline: string, symbol: string): string {
  const trimmed = headline.startsWith(symbol) ? headline.slice(symbol.length).trim() : headline;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function maxTimesShown(item: DigestItemInput, signals: readonly Signal[]): number {
  let max = 0;
  for (const s of signals) max = Math.max(max, item.timesShown[s.dedupBucket] ?? 0);
  return max;
}

function safe<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

export function buildDigest(
  items: readonly DigestItemInput[],
  opts: DigestOptions,
): Digest {
  const entries = items.map((i) => buildDigestEntry(i, opts));
  const attention = entries
    .filter((e) => !e.quiet)
    .sort((a, b) => b.significance.score - a.significance.score);
  const quiet = entries
    .filter((e) => e.quiet)
    .sort((a, b) => (b.sigmaMultiple ?? 0) - (a.sigmaMultiple ?? 0));

  let highWaterSeq = 0;
  for (const e of entries) for (const s of e.eventSeqs) highWaterSeq = Math.max(highWaterSeq, s);

  return {
    attention,
    quiet,
    generatedAt: opts.now,
    highWaterSeq,
    summary: {
      watched: entries.length,
      needingAttention: attention.length,
      unavailable: entries.filter((e) => e.freshness === "UNAVAILABLE").length,
      topHeadline: attention[0]?.significance.headline ?? null,
    },
  };
}
