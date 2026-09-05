/**
 * Watermarks: where each reader got to.
 *
 * A watermark is per (user, instrument), not per device, because "what changed
 * since I last checked" is a fact about the person, not about the laptop they
 * checked from. Open the app on a phone, mark things read, and the desktop
 * agrees.
 *
 * Every field advances monotonically. Two devices acknowledging concurrently
 * converge on the later of the two rather than the last writer winning.
 */

import type { Direction } from "@/core/types";
import { query, type Tx } from "../db/client";

export interface Watermark {
  instrumentId: string;
  seenAt: number;
  refPrice: number | null;
  refAsOf: number | null;
  refDirection: Direction;
  lastEventSeq: number;
}

export async function getWatermarks(userId: string): Promise<Map<string, Watermark>> {
  const rows = await query<{
    instrument_id: string;
    seen_at: Date;
    ref_price: number | null;
    ref_as_of: Date | null;
    ref_direction: Direction;
    last_event_seq: number;
  }>(
    `SELECT instrument_id, seen_at, ref_price, ref_as_of, ref_direction, last_event_seq
       FROM watermarks WHERE user_id = $1`,
    [userId],
  );
  return new Map(
    rows.map((r) => [
      r.instrument_id,
      {
        instrumentId: r.instrument_id,
        seenAt: r.seen_at.getTime(),
        refPrice: r.ref_price,
        refAsOf: r.ref_as_of?.getTime() ?? null,
        refDirection: r.ref_direction,
        lastEventSeq: r.last_event_seq,
      },
    ]),
  );
}

export interface WatermarkAdvance {
  instrumentId: string;
  /** Price the user actually had on screen. */
  refPrice: number | null;
  /** Timestamp of that price, from the quote — not the wall clock. */
  refAsOf: number | null;
  refDirection: Direction;
  /** Highest event sequence rendered for this instrument. */
  seq: number;
}

/**
 * Advance watermarks for a set of instruments.
 *
 * Written as a single statement over `unnest` so that acknowledging a
 * 200-instrument watchlist is one round trip, and so the whole advance is
 * atomic: a reader either sees the old cursor or the new one, never a
 * half-applied mixture that would make the next digest incoherent.
 *
 * `GREATEST` on the sequence and the `CASE` on the reference are what make
 * this safe under concurrency: an acknowledgement that arrives out of order
 * (slow phone, retried request) cannot drag the cursor backwards.
 */
export async function advanceWatermarks(
  tx: Tx,
  userId: string,
  advances: readonly WatermarkAdvance[],
  boundarySeq: number,
): Promise<number> {
  if (advances.length === 0) return 0;
  return tx.execute(
    `INSERT INTO watermarks
        (user_id, instrument_id, seen_at, ref_price, ref_as_of, ref_direction, last_event_seq)
     SELECT $1, i, now(), p, to_timestamp(a / 1000.0), d, LEAST(s, $6::bigint)
       FROM unnest($2::uuid[], $3::float8[], $4::float8[], $5::text[], $7::bigint[])
            AS t(i, p, a, d, s)
     ON CONFLICT (user_id, instrument_id) DO UPDATE SET
        seen_at = now(),
        last_event_seq = GREATEST(watermarks.last_event_seq, EXCLUDED.last_event_seq),
        -- Only move the price reference forward in market time.
        ref_price = CASE
          WHEN watermarks.ref_as_of IS NULL OR EXCLUDED.ref_as_of >= watermarks.ref_as_of
          THEN COALESCE(EXCLUDED.ref_price, watermarks.ref_price)
          ELSE watermarks.ref_price END,
        ref_as_of = CASE
          WHEN watermarks.ref_as_of IS NULL OR EXCLUDED.ref_as_of >= watermarks.ref_as_of
          THEN COALESCE(EXCLUDED.ref_as_of, watermarks.ref_as_of)
          ELSE watermarks.ref_as_of END,
        ref_direction = CASE
          WHEN watermarks.ref_as_of IS NULL OR EXCLUDED.ref_as_of >= watermarks.ref_as_of
          THEN EXCLUDED.ref_direction
          ELSE watermarks.ref_direction END`,
    [
      userId,
      advances.map((a) => a.instrumentId),
      advances.map((a) => a.refPrice),
      advances.map((a) => a.refAsOf ?? 0),
      advances.map((a) => a.refDirection),
      boundarySeq,
      advances.map((a) => a.seq),
    ],
  );
}

/** Forget a reader's position on one instrument, so everything is new again. */
export async function resetWatermark(
  tx: Tx,
  userId: string,
  instrumentId: string,
): Promise<void> {
  await tx.execute("DELETE FROM watermarks WHERE user_id = $1 AND instrument_id = $2", [
    userId,
    instrumentId,
  ]);
  await tx.execute(
    `DELETE FROM user_event_state s
      USING change_events e
      WHERE s.event_id = e.id AND s.user_id = $1 AND e.instrument_id = $2`,
    [userId, instrumentId],
  );
}
