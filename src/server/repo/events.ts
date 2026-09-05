/**
 * Change events: the durable, instrument-level record of what the market did.
 *
 * Two properties this module exists to guarantee:
 *
 *   Idempotency. `(instrument_id, kind, dedup_key)` is unique, so two workers
 *   that observe the same 2σ move at the same moment produce one row. The
 *   escalation logic lives in the ON CONFLICT clause, which means it is applied
 *   atomically by Postgres rather than by a read-modify-write that two
 *   processes can interleave.
 *
 *   A read cursor that behaves across devices. Every event gets a bigserial
 *   `seq`; a reader's watermark stores the highest seq they have seen. Because
 *   a bigserial can commit out of order, the acknowledgement path pairs the
 *   cursor with explicit per-event rows — see `acknowledge` below.
 */

import type { Signal } from "@/core/types";
import type { StoredEvent } from "@/core/diff/digest";
import { query, type Tx } from "../db/client";

export interface UpsertEventResult {
  id: string;
  seq: number;
  inserted: boolean;
  escalated: boolean;
}

export async function upsertEvent(
  tx: Tx,
  instrumentId: string,
  sessionDate: string,
  signal: Signal,
): Promise<UpsertEventResult> {
  const rows = await tx.query<{
    id: string;
    seq: number;
    inserted: boolean;
    peak_magnitude: number;
  }>(
    `INSERT INTO change_events (
        instrument_id, kind, direction, magnitude, peak_magnitude,
        dedup_key, headline, evidence, session_date)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7::jsonb,$8::date)
     ON CONFLICT (instrument_id, kind, dedup_key) DO UPDATE SET
        magnitude       = EXCLUDED.magnitude,
        peak_magnitude  = GREATEST(change_events.peak_magnitude, EXCLUDED.magnitude),
        direction       = EXCLUDED.direction,
        headline        = EXCLUDED.headline,
        evidence        = EXCLUDED.evidence,
        last_updated_at = now(),
        update_count    = change_events.update_count + 1
     RETURNING id, seq, peak_magnitude, (xmax = 0) AS inserted`,
    [
      instrumentId,
      signal.kind,
      signal.direction,
      signal.magnitude,
      signal.dedupBucket,
      signal.headline,
      JSON.stringify(signal.evidence),
      sessionDate,
    ],
  );

  const r = rows[0];
  return {
    id: r.id,
    seq: r.seq,
    inserted: r.inserted,
    escalated: !r.inserted && signal.magnitude >= r.peak_magnitude,
  };
}

interface EventRow {
  id: string;
  seq: number;
  instrument_id: string;
  kind: Signal["kind"];
  direction: Signal["direction"];
  magnitude: number;
  dedup_key: string;
  headline: string;
  evidence: Record<string, unknown>;
  first_seen_at: Date;
  last_updated_at: Date;
  times_shown: number | null;
}

function toStoredEvent(r: EventRow): StoredEvent & { instrumentId: string; timesShown: number } {
  return {
    id: r.id,
    seq: r.seq,
    instrumentId: r.instrument_id,
    kind: r.kind,
    direction: r.direction,
    magnitude: r.magnitude,
    dedupBucket: r.dedup_key,
    headline: r.headline,
    evidence: r.evidence ?? {},
    firstSeenAt: r.first_seen_at.getTime(),
    lastUpdatedAt: r.last_updated_at.getTime(),
    timesShown: r.times_shown ?? 0,
  };
}

/**
 * Events on this user's watchlists that they have not seen.
 *
 * The `seq > watermark` predicate is the fast path; the `acknowledged_at IS
 * NULL` predicate is the correctness backstop for events whose sequence
 * committed after a higher one was already read.
 */
export async function unseenEventsForUser(
  userId: string,
  opts: { lookbackDays?: number; limitPerInstrument?: number } = {},
): Promise<Array<StoredEvent & { instrumentId: string; timesShown: number }>> {
  const lookback = opts.lookbackDays ?? 4;
  const rows = await query<EventRow>(
    `WITH watched AS (
        SELECT DISTINCT wi.instrument_id
          FROM watchlist_items wi
          JOIN watchlists w ON w.id = wi.watchlist_id
         WHERE w.user_id = $1
     ), candidate AS (
        SELECT e.*, s.times_shown,
               row_number() OVER (PARTITION BY e.instrument_id ORDER BY e.seq DESC) AS rn
          FROM change_events e
          JOIN watched ON watched.instrument_id = e.instrument_id
          LEFT JOIN watermarks m
                 ON m.user_id = $1 AND m.instrument_id = e.instrument_id
          LEFT JOIN user_event_state s
                 ON s.user_id = $1 AND s.event_id = e.id
         WHERE e.seq > COALESCE(m.last_event_seq, 0)
           AND s.acknowledged_at IS NULL
           AND e.last_updated_at > now() - ($2 || ' days')::interval
     )
     SELECT * FROM candidate WHERE rn <= $3 ORDER BY seq DESC`,
    [userId, String(lookback), opts.limitPerInstrument ?? 6],
  );
  return rows.map(toStoredEvent);
}

/** Recent events for one instrument, for the detail drawer. */
export async function recentEventsForInstrument(
  instrumentId: string,
  limit = 25,
): Promise<Array<StoredEvent & { instrumentId: string; timesShown: number }>> {
  const rows = await query<EventRow>(
    `SELECT e.*, NULL::int AS times_shown
       FROM change_events e
      WHERE e.instrument_id = $1
      ORDER BY e.seq DESC
      LIMIT $2`,
    [instrumentId, limit],
  );
  return rows.map(toStoredEvent);
}

/**
 * How long two renders have to be apart before they count as two viewings.
 *
 * A live page refetches on a timer and on every change event. Counting those as
 * separate sightings let a page left open suppress its own alerts within
 * minutes, which is the exact opposite of what repeat suppression is for.
 */
const SHOWN_COOLDOWN = "10 minutes";

/**
 * Record that these events were put in front of the user. Drives repeat
 * suppression: the third time we show the same story it scores lower.
 */
export async function markShown(userId: string, eventIds: readonly string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await query(
    `INSERT INTO user_event_state (user_id, event_id, times_shown, last_shown_at)
     SELECT $1, e, 1, now() FROM unnest($2::uuid[]) AS e
     ON CONFLICT (user_id, event_id) DO UPDATE SET
        times_shown = user_event_state.times_shown + CASE
          WHEN user_event_state.last_shown_at IS NULL
            OR user_event_state.last_shown_at < now() - interval '${SHOWN_COOLDOWN}'
          THEN 1 ELSE 0 END,
        last_shown_at = now()`,
    [userId, eventIds],
  );
}

export async function acknowledgeEvents(
  tx: Tx,
  userId: string,
  eventIds: readonly string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  await tx.execute(
    `INSERT INTO user_event_state (user_id, event_id, times_shown, acknowledged_at, last_shown_at)
     SELECT $1, e, 1, now(), now() FROM unnest($2::uuid[]) AS e
     ON CONFLICT (user_id, event_id) DO UPDATE SET acknowledged_at = now()`,
    [userId, eventIds],
  );
}

/**
 * The highest sequence number it is safe to jump a watermark to.
 *
 * A bigserial is allocated before commit, so sequence 97 can become visible
 * *after* 98-100 have already been read. Advancing a cursor straight to 100
 * would silently bury 97 forever. Restricting the jump to events that settled
 * more than one settling window ago makes that impossible, and any event newer
 * than the window is handled by the explicit acknowledgement rows instead.
 */
export async function safeAckBoundary(tx: Tx, settlingSeconds = 5): Promise<number> {
  const row = await tx.queryOne<{ boundary: number }>(
    `SELECT COALESCE(max(seq), 0)::bigint AS boundary
       FROM change_events
      WHERE last_updated_at < now() - ($1 || ' seconds')::interval`,
    [String(settlingSeconds)],
  );
  return row?.boundary ?? 0;
}

/** Housekeeping: acknowledgement rows below the cursor carry no information. */
export async function pruneAcknowledgements(): Promise<number> {
  const rows = await query<{ pruned: number }>(
    `WITH deleted AS (
       DELETE FROM user_event_state s
        USING change_events e, watermarks m
        WHERE s.event_id = e.id
          AND m.user_id = s.user_id
          AND m.instrument_id = e.instrument_id
          AND e.seq <= m.last_event_seq
       RETURNING 1
     ) SELECT count(*)::int AS pruned FROM deleted`,
  );
  return rows[0]?.pruned ?? 0;
}

export async function purgeOldEvents(days = 30): Promise<number> {
  const rows = await query<{ purged: number }>(
    `WITH deleted AS (
        DELETE FROM change_events
         WHERE last_updated_at < now() - ($1 || ' days')::interval
        RETURNING 1
     ) SELECT count(*)::int AS purged FROM deleted`,
    [String(days)],
  );
  return rows[0]?.purged ?? 0;
}
