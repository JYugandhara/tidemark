/**
 * The read path.
 *
 * Assembles one reader's answer to "what changed since I last looked" from
 * four cheap lookups (watchlist, quotes, watermarks, unseen events) plus a few
 * hundred floating-point operations. No provider calls, no scoring of
 * instruments nobody is watching, no work proportional to the size of the
 * market.
 */

import { buildDigest, type Digest, type DigestItemInput } from "@/core/diff/digest";
import { classifyFreshness, describeAge } from "@/core/market/freshness";
import { typicalDailyVolume } from "@/core/significance/baseline";
import type { Conviction, Direction, Freshness } from "@/core/types";
import { alertsByInstrument } from "../repo/alerts";
import { markShown, unseenEventsForUser } from "../repo/events";
import { getTape } from "../repo/quotes";
import { watchedSnapshot } from "../repo/snapshot";
import { getWatermarks } from "../repo/watermarks";
import type { SessionUser } from "../session";
import { marketClock } from "./market-clock";

const SESSION_HOURS = 6.25;

export interface DigestEntryDTO {
  instrumentId: string;
  itemId: string;
  symbol: string;
  name: string;
  sector: string | null;
  conviction: Conviction;
  mutedUntil: number | null;
  version: number;
  score: number;
  band: string;
  headline: string;
  contributions: Array<{ kind: string; points: number; detail: string; weight: number }>;
  signals: Array<{
    kind: string;
    direction: Direction;
    magnitude: number;
    headline: string;
    evidence: Record<string, unknown>;
  }>;
  eventIds: string[];
  eventSeqs: number[];
  price: number | null;
  previousClose: number | null;
  changeSinceReferencePct: number | null;
  changeTodayPct: number | null;
  sigmaMultiple: number | null;
  dailySigmaPct: number;
  freshness: Freshness;
  asOf: number | null;
  ageLabel: string;
  referenceLabel: string;
  referencePrice: number | null;
  /** When the reader last saw this instrument; anchors the sparkline shading. */
  referenceAsOf: number | null;
  /**
   * When the unseen events behind this entry actually happened. A halt that
   * cleared twenty minutes ago is still news to someone who was away, but the
   * page has to say *when* or it reads as a live claim.
   */
  eventFirstSeenAt: number | null;
  eventLastUpdatedAt: number | null;
  quiet: boolean;
  quietReason: string | null;
  halted: boolean;
  provider: string | null;
  tape: Array<{ t: number; p: number }>;
}

export interface DigestResponse {
  generatedAt: number;
  marketPhase: string;
  sessionDate: string;
  /** True when prices come from the generated session rather than a live feed. */
  simulated: boolean;
  sessionProgress: number;
  hoursSinceLastCheck: number;
  lastCheckedAt: number;
  attentionThreshold: number;
  attention: DigestEntryDTO[];
  quiet: DigestEntryDTO[];
  summary: Digest["summary"];
  highWaterSeq: number;
}

export async function buildDigestForUser(
  user: SessionUser,
  opts: { now?: number; tapePoints?: number } = {},
): Promise<DigestResponse> {
  const now = opts.now ?? Date.now();
  const clock = marketClock();
  const session = clock.session(now);
  // One query for items + instruments + quotes; the rest run alongside it.
  const snapshot = await watchedSnapshot(user.id);
  const items = snapshot.map((s) => s.item);
  const instrumentIds = items.map((i) => i.instrumentId);

  const [watermarks, events, alerts, tape] = await Promise.all([
    getWatermarks(user.id),
    unseenEventsForUser(user.id),
    alertsByInstrument(user.id),
    getTape(instrumentIds, opts.tapePoints ?? 40),
  ]);

  const instrumentById = new Map(snapshot.map((s) => [s.instrument.id, s.instrument]));
  const quoteById = new Map(
    snapshot.filter((s) => s.quote).map((s) => [s.instrument.id, s.quote!]),
  );

  const eventsByInstrument = new Map<string, typeof events>();
  const timesShownByInstrument = new Map<string, Record<string, number>>();
  for (const e of events) {
    const list = eventsByInstrument.get(e.instrumentId);
    if (list) list.push(e);
    else eventsByInstrument.set(e.instrumentId, [e]);
    const shown = timesShownByInstrument.get(e.instrumentId) ?? {};
    shown[e.dedupBucket] = Math.max(shown[e.dedupBucket] ?? 0, e.timesShown);
    timesShownByInstrument.set(e.instrumentId, shown);
  }

  // Market time, not wall time: an overnight absence is worth less catching up
  // on than the same number of hours during a live session.
  const marketHoursSince = clock.horizon(user.lastCheckedAt, now) * SESSION_HOURS;

  const inputs: DigestItemInput[] = items.map((item) => {
    const inst = instrumentById.get(item.instrumentId);
    const quote = quoteById.get(item.instrumentId) ?? null;
    const wm = watermarks.get(item.instrumentId);
    const { freshness } = classifyFreshness(session.phase, quote?.asOf ?? null, now);

    return {
      instrumentId: item.instrumentId,
      symbol: item.symbol,
      name: item.name,
      quote,
      freshness,
      baseline:
        inst?.baseline ??
        {
          instrumentId: item.instrumentId,
          dailySigma: 0.02,
          sampleSize: 0,
          logVolumeMean: 0,
          logVolumeSigma: 0.45,
          volumeProfile: [],
          high52w: null,
          low52w: null,
          high20d: null,
          low20d: null,
          medianAbsReturn: 0.01,
          computedAt: 0,
        },
      typicalDailyVolume: inst ? typicalDailyVolume(inst.baseline) : null,
      weighting: {
        conviction: item.conviction,
        attentionThreshold: user.attentionThreshold,
        mutedUntil: item.mutedUntil,
      },
      reference:
        wm && wm.refPrice !== null && wm.refAsOf !== null
          ? {
              price: wm.refPrice,
              asOf: wm.refAsOf,
              isPreviousClose: false,
              directionAtReference: wm.refDirection,
            }
          : null,
      alerts: alerts.get(item.instrumentId) ?? [],
      corporateActions: [],
      unseenEvents: eventsByInstrument.get(item.instrumentId) ?? [],
      timesShown: timesShownByInstrument.get(item.instrumentId) ?? {},
    };
  });

  const digest = buildDigest(inputs, {
    now,
    clock,
    session,
    attentionThreshold: user.attentionThreshold,
    hoursSinceLastCheck: marketHoursSince,
  });

  const itemByInstrument = new Map(items.map((i) => [i.instrumentId, i]));
  const eventIdsByInstrument = new Map(
    [...eventsByInstrument.entries()].map(([k, v]) => [k, v.map((e) => e.id)]),
  );

  const toDTO = (e: (typeof digest.attention)[number]): DigestEntryDTO => {
    const item = itemByInstrument.get(e.instrumentId)!;
    const inst = instrumentById.get(e.instrumentId);
    const quote = quoteById.get(e.instrumentId);
    return {
      instrumentId: e.instrumentId,
      itemId: item.id,
      symbol: e.symbol,
      name: e.name,
      sector: item.sector,
      conviction: item.conviction,
      mutedUntil: item.mutedUntil,
      version: item.version,
      score: e.significance.score,
      band: e.significance.band,
      headline: e.significance.headline,
      contributions: e.significance.contributions.map((c) => ({
        kind: c.kind,
        points: c.points,
        detail: c.detail,
        weight: c.weight,
      })),
      // The scorer keeps the strongest signal per kind; the drawer has to show
      // the same set, or a reader auditing the score sees evidence blocks that
      // contributed nothing.
      signals: dedupeSignals(e.signals).map((s) => ({
        kind: s.kind,
        direction: s.direction,
        magnitude: Number(s.magnitude.toFixed(2)),
        headline: s.headline,
        evidence: s.evidence,
      })),
      eventIds: eventIdsByInstrument.get(e.instrumentId) ?? [],
      eventSeqs: e.eventSeqs,
      price: e.price,
      previousClose: quote?.previousClose ?? null,
      changeSinceReferencePct: e.changeSinceReferencePct,
      changeTodayPct: e.changeTodayPct,
      sigmaMultiple: e.sigmaMultiple,
      dailySigmaPct: Number(((inst?.baseline.dailySigma ?? 0.02) * 100).toFixed(2)),
      freshness: e.freshness,
      asOf: e.asOf,
      ageLabel: e.asOf === null ? "no data" : describeAge(now - e.asOf),
      referenceLabel: e.referenceLabel,
      referencePrice:
        watermarks.get(e.instrumentId)?.refPrice ?? quote?.previousClose ?? null,
      referenceAsOf: watermarks.get(e.instrumentId)?.refAsOf ?? null,
      eventFirstSeenAt: minOf((eventsByInstrument.get(e.instrumentId) ?? []).map((x) => x.firstSeenAt)),
      eventLastUpdatedAt: maxOf(
        (eventsByInstrument.get(e.instrumentId) ?? []).map((x) => x.lastUpdatedAt),
      ),
      quiet: e.quiet,
      quietReason: e.quietReason,
      halted: quote?.halted ?? false,
      provider: quote?.provider ?? null,
      tape: tape[e.instrumentId] ?? [],
    };
  };

  const attention = digest.attention.map(toDTO);
  const quiet = digest.quiet.map(toDTO);

  // Repeat suppression only works if we record what we actually showed.
  const shown = attention.flatMap((a) => a.eventIds);
  if (shown.length > 0) void markShown(user.id, shown);

  return {
    generatedAt: now,
    marketPhase: session.phase,
    sessionDate: session.sessionDate,
    simulated: session.synthetic,
    sessionProgress: Number(session.progress.toFixed(4)),
    hoursSinceLastCheck: Number(marketHoursSince.toFixed(2)),
    lastCheckedAt: user.lastCheckedAt,
    attentionThreshold: user.attentionThreshold,
    attention,
    quiet,
    summary: digest.summary,
    highWaterSeq: digest.highWaterSeq,
  };
}

/** Keep the strongest signal of each kind — exactly what `scoreSignals` uses. */
function dedupeSignals<T extends { kind: string; magnitude: number }>(signals: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const s of signals) {
    const prev = best.get(s.kind);
    if (!prev || s.magnitude > prev.magnitude) best.set(s.kind, s);
  }
  return [...best.values()].sort((a, b) => b.magnitude - a.magnitude);
}

function minOf(xs: readonly number[]): number | null {
  return xs.length ? Math.min(...xs) : null;
}
function maxOf(xs: readonly number[]): number | null {
  return xs.length ? Math.max(...xs) : null;
}
