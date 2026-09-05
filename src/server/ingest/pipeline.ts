/**
 * The ingestion pipeline: one poll of a set of instruments.
 *
 * Shape of a single instrument's pass:
 *
 *   fetch (pool handles retries, breakers, rate limits and the sanity filter)
 *     -> transaction
 *          -> advisory lock, so only one worker owns this instrument
 *          -> monotonic quote upsert, so a late tick cannot win
 *          -> run instrument-level detectors against the *previous close*
 *          -> idempotent event upsert, so a repeat produces one row
 *          -> outbox insert in the same transaction, so nothing is lost
 *     -> commit
 *
 * Everything user-specific — the move since *you* last looked, *your* alerts —
 * is deliberately absent here. That work is O(readers) and belongs on the read
 * path; this loop is O(instruments) and stays flat as the user base grows.
 */

import type { Quote, Signal } from "@/core/types";
import type { MarketClock, MarketSession } from "@/core/market/clock";
import { classifyFreshness } from "@/core/market/freshness";
import { typicalDailyVolume } from "@/core/significance/baseline";
import { bucketFor } from "@/core/significance/volume-profile";
import {
  type CorporateAction,
  type DetectionContext,
  detectCircuitAndHalt,
  detectCorporateActions,
  detectDataStale,
  detectGap,
  detectLiquidityDrop,
  detectPriceMove,
  detectRangeBreak,
  detectVolumeSurge,
} from "@/core/significance/detect";
import { config } from "../config";
import { tryAdvisoryLock, withTransaction, query, type Tx } from "../db/client";
import { enqueue } from "../events/outbox";
import { topics } from "../events/hub";
import { upsertEvent } from "../repo/events";
import { getQuotes, upsertQuote, appendTick } from "../repo/quotes";
import { recordVolumeBucket } from "./volume-profile";
import type { Instrument } from "../repo/instruments";
import { getProviderPool } from "../providers/pool";
import { marketClock } from "../services/market-clock";

export interface IngestReport {
  polled: number;
  quotesAccepted: number;
  quotesRejectedStale: number;
  eventsCreated: number;
  eventsUpdated: number;
  missing: Array<{ symbol: string; reason: string }>;
  rejected: Array<{ symbol: string; reason: string; provider: string }>;
  attempts: Array<{ provider: string; ok: boolean; latencyMs: number; error?: string }>;
  durationMs: number;
}

/** Detectors that describe the market, not a particular reader. */
const INSTRUMENT_DETECTORS: Array<(ctx: DetectionContext) => Signal[]> = [
  detectPriceMove,
  detectGap,
  detectVolumeSurge,
  detectRangeBreak,
  detectCircuitAndHalt,
  detectLiquidityDrop,
  detectDataStale,
  detectCorporateActions,
];

export async function ingest(instruments: readonly Instrument[]): Promise<IngestReport> {
  const started = Date.now();
  const report: IngestReport = {
    polled: instruments.length,
    quotesAccepted: 0,
    quotesRejectedStale: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    missing: [],
    rejected: [],
    attempts: [],
    durationMs: 0,
  };
  if (instruments.length === 0) return report;

  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const existing = await getQuotes(instruments.map((i) => i.id));
  const lastKnownByInstrument = new Map(existing.map((q) => [q.instrumentId, q]));

  // Tolerance for the plausibility filter is the instrument's own volatility,
  // so a habitually violent small-cap is not judged by a utility's yardstick.
  const lastKnown = new Map<string, { price: number; tolerance: number }>();
  for (const inst of instruments) {
    const q = lastKnownByInstrument.get(inst.id);
    if (!q) continue;
    lastKnown.set(inst.symbol, {
      price: q.price,
      tolerance: Math.max(0.35, 12 * Math.max(inst.baseline.dailySigma, inst.baseline.medianAbsReturn)),
    });
  }

  const corporate = await corporateActionsFor(instruments.map((i) => i.id));
  const pool = getProviderPool();
  const result = await pool.getQuotes([...bySymbol.keys()], lastKnown);
  report.attempts = result.attempts;
  report.missing = result.missing;
  report.rejected = result.rejected;

  const now = Date.now();
  const clock = marketClock();
  const session = clock.session(now);

  for (const quote of result.quotes) {
    const inst = bySymbol.get(quote.symbol);
    if (!inst) continue;
    try {
      const outcome = await processQuote(
        inst,
        quote,
        result.sources[quote.symbol] ?? "unknown",
        corporate.get(inst.id) ?? [],
        now,
        session,
        clock,
      );
      if (outcome.accepted) report.quotesAccepted += 1;
      else report.quotesRejectedStale += 1;
      report.eventsCreated += outcome.created;
      report.eventsUpdated += outcome.updated;
    } catch (err) {
      report.missing.push({
        symbol: quote.symbol,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Symbols nobody could answer for. If the market is open this is itself an
  // event; if it is shut, it is expected and we stay quiet.
  if (result.missing.length > 0) {
    await recordMissing(result.missing, bySymbol, now, session, report);
  }

  report.durationMs = Date.now() - started;
  return report;
}

interface ProcessOutcome {
  accepted: boolean;
  created: number;
  updated: number;
}

async function processQuote(
  inst: Instrument,
  quote: Quote,
  provider: string,
  corporateActions: CorporateAction[],
  now: number,
  session: MarketSession,
  clock: MarketClock,
): Promise<ProcessOutcome> {
  return withTransaction(async (tx) => {
    // If another worker already owns this instrument, skip rather than queue.
    const locked = await tryAdvisoryLock(tx, `ingest:${inst.id}`);
    if (!locked) return { accepted: false, created: 0, updated: 0 };

    const upsert = await upsertQuote(tx, inst.id, quote, provider);
    if (!upsert.accepted) {
      // A late tick. Recorded for telemetry, then dropped: acting on it would
      // move the visible price backwards in time.
      await touchIngestState(tx, inst.id, true, null);
      return { accepted: false, created: 0, updated: 0 };
    }

    await appendTick(tx, inst.id, quote.asOf, quote.price, quote.volume ?? null);

    // Teach this instrument its own intraday volume shape. Only while a
    // session is actually running: a reading taken when the market is shut
    // would flatten the curve toward the close.
    if (quote.volume !== null && quote.volume !== undefined && session.phase === "OPEN") {
      await recordVolumeBucket(
        tx,
        inst.id,
        session.sessionDate,
        bucketFor(session.progress),
        quote.volume,
      );
    }

    const { freshness } = classifyFreshness(session.phase, quote.asOf, now);
    const ctx: DetectionContext = {
      now,
      session,
      clock,
      symbol: inst.symbol,
      displayName: inst.name,
      baseline: inst.baseline,
      quote,
      freshness,
      reference: {
        price: quote.previousClose,
        asOf: quote.asOf,
        isPreviousClose: true,
        directionAtReference: "flat",
      },
      alerts: [],
      corporateActions,
      typicalDailyVolume: typicalDailyVolume(inst.baseline),
    };

    const signals: Signal[] = [];
    for (const detector of INSTRUMENT_DETECTORS) {
      try {
        signals.push(...detector(ctx));
      } catch (err) {
        console.error(`[ingest] detector ${detector.name} failed for ${inst.symbol}:`, err);
      }
    }

    let created = 0;
    let updated = 0;
    for (const signal of signals) {
      const res = await upsertEvent(tx, inst.id, session.sessionDate, signal);
      if (res.inserted) created += 1;
      else updated += 1;
      // Only a genuinely new or escalated event is worth waking a browser for.
      if (res.inserted || res.escalated) {
        await enqueue(tx, topics.instrument(inst.id), {
          event: "change",
          instrumentId: inst.id,
          symbol: inst.symbol,
          eventId: res.id,
          seq: res.seq,
          kind: signal.kind,
          direction: signal.direction,
          headline: signal.headline,
          magnitude: signal.magnitude,
        });
      }
    }

    // The price itself is worth streaming even when nothing "happened",
    // because a live tape is what makes the page feel alive.
    await enqueue(tx, topics.instrument(inst.id), {
      event: "quote",
      instrumentId: inst.id,
      symbol: inst.symbol,
      price: quote.price,
      previousClose: quote.previousClose,
      volume: quote.volume,
      halted: quote.halted ?? false,
      asOf: quote.asOf,
      provider,
    });

    await touchIngestState(tx, inst.id, true, null);
    return { accepted: true, created, updated };
  });
}

async function recordMissing(
  missing: readonly { symbol: string; reason: string }[],
  bySymbol: ReadonlyMap<string, Instrument>,
  now: number,
  session: MarketSession,
  report: IngestReport,
): Promise<void> {
  const marketOpen = session.phase === "OPEN";
  for (const m of missing) {
    const inst = bySymbol.get(m.symbol);
    if (!inst) continue;
    try {
      await withTransaction(async (tx) => {
        await touchIngestState(tx, inst.id, false, m.reason);
        if (!marketOpen) return;
        const ageMinutes = 0;
        const signal: Signal = {
          kind: "DATA_STALE",
          direction: "flat",
          magnitude: 2.4,
          dedupBucket: `feed:${session.sessionDate}:${Math.floor(now / (15 * 60_000))}`,
          headline: `No price for ${inst.symbol} — ${m.reason}`,
          evidence: { reason: m.reason, ageMinutes, freshness: "UNAVAILABLE" },
        };
        const res = await upsertEvent(tx, inst.id, session.sessionDate, signal);
        if (res.inserted) {
          report.eventsCreated += 1;
          await enqueue(tx, topics.instrument(inst.id), {
            event: "change",
            instrumentId: inst.id,
            symbol: inst.symbol,
            eventId: res.id,
            seq: res.seq,
            kind: signal.kind,
            direction: signal.direction,
            headline: signal.headline,
            magnitude: signal.magnitude,
          });
        }
      });
    } catch (err) {
      console.error(`[ingest] failed to record missing ${m.symbol}:`, err);
    }
  }
}

async function touchIngestState(
  tx: Tx,
  instrumentId: string,
  ok: boolean,
  error: string | null,
): Promise<void> {
  await tx.execute(
    `INSERT INTO ingest_state (instrument_id, last_polled_at, last_success_at, consecutive_errors, last_error)
     VALUES ($1, now(), CASE WHEN $2 THEN now() ELSE NULL END, CASE WHEN $2 THEN 0 ELSE 1 END, $3)
     ON CONFLICT (instrument_id) DO UPDATE SET
        last_polled_at = now(),
        last_success_at = CASE WHEN $2 THEN now() ELSE ingest_state.last_success_at END,
        consecutive_errors = CASE WHEN $2 THEN 0 ELSE ingest_state.consecutive_errors + 1 END,
        last_error = $3`,
    [instrumentId, ok, error],
  );
}

async function corporateActionsFor(
  instrumentIds: readonly string[],
): Promise<Map<string, CorporateAction[]>> {
  if (instrumentIds.length === 0) return new Map();
  const rows = await query<{
    id: string;
    instrument_id: string;
    kind: CorporateAction["kind"];
    effective_date: Date;
    note: string | null;
  }>(
    `SELECT id, instrument_id, kind, effective_date, note
       FROM corporate_actions
      WHERE instrument_id = ANY($1::uuid[])
        AND effective_date BETWEEN current_date AND current_date + 7`,
    [instrumentIds],
  );
  const out = new Map<string, CorporateAction[]>();
  for (const r of rows) {
    const ca: CorporateAction = {
      id: r.id,
      kind: r.kind,
      effectiveDate: toDate(r.effective_date),
      note: r.note,
    };
    const list = out.get(r.instrument_id);
    if (list) list.push(ca);
    else out.set(r.instrument_id, [ca]);
  }
  return out;
}

function toDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export { config as ingestConfig };
