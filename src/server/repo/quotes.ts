/**
 * Quote persistence.
 *
 * The whole point of this file is the WHERE clause on line ~60. Providers
 * deliver out of order — a retry that lands after the retry-of-the-retry, a
 * failover to a slower feed, two workers polling the same symbol a moment
 * apart. Without a monotonic guard, the newest price on screen is whichever
 * write happened to finish last, which is a silent, intermittent correctness
 * bug of exactly the kind nobody notices until a user acts on it.
 */

import type { Quote } from "@/core/types";
import { execute, query, type Tx } from "../db/client";

export interface StoredQuote extends Quote {
  instrumentId: string;
  receivedAt: number;
  provider: string;
}

interface QuoteRow {
  instrument_id: string;
  symbol: string;
  price: number;
  previous_close: number;
  open: number | null;
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  halted: boolean;
  upper_circuit: number | null;
  lower_circuit: number | null;
  as_of: Date;
  received_at: Date;
  provider: string;
}

function toStored(r: QuoteRow): StoredQuote {
  return {
    instrumentId: r.instrument_id,
    symbol: r.symbol,
    price: r.price,
    previousClose: r.previous_close,
    open: r.open,
    dayHigh: r.day_high,
    dayLow: r.day_low,
    volume: r.volume,
    bid: r.bid,
    ask: r.ask,
    halted: r.halted,
    upperCircuit: r.upper_circuit,
    lowerCircuit: r.lower_circuit,
    asOf: r.as_of.getTime(),
    receivedAt: r.received_at.getTime(),
    provider: r.provider,
  };
}

export async function getQuotes(instrumentIds: readonly string[]): Promise<StoredQuote[]> {
  if (instrumentIds.length === 0) return [];
  const rows = await query<QuoteRow>(
    `SELECT q.*, i.symbol
       FROM quotes q JOIN instruments i ON i.id = q.instrument_id
      WHERE q.instrument_id = ANY($1::uuid[])`,
    [instrumentIds],
  );
  return rows.map(toStored);
}

export interface UpsertResult {
  instrumentId: string;
  /** False when an older tick was correctly refused. */
  accepted: boolean;
  previous: { price: number; asOf: number } | null;
}

/**
 * Write a quote, but only if it is strictly newer than what we already hold.
 *
 * Returns the previous state so the caller can compute a delta without a
 * second read, and reports whether the write was accepted so late ticks show
 * up in telemetry instead of vanishing.
 */
export async function upsertQuote(
  tx: Tx,
  instrumentId: string,
  q: Quote,
  provider: string,
): Promise<UpsertResult> {
  const before = await tx.queryOne<{ price: number; as_of: Date }>(
    "SELECT price, as_of FROM quotes WHERE instrument_id = $1",
    [instrumentId],
  );

  const rows = await tx.query<{ instrument_id: string }>(
    `INSERT INTO quotes (
        instrument_id, price, previous_close, open, day_high, day_low, volume,
        bid, ask, halted, upper_circuit, lower_circuit, as_of, received_at, provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), $14)
     ON CONFLICT (instrument_id) DO UPDATE SET
        price = EXCLUDED.price,
        previous_close = EXCLUDED.previous_close,
        open = EXCLUDED.open,
        day_high = EXCLUDED.day_high,
        day_low = EXCLUDED.day_low,
        volume = EXCLUDED.volume,
        bid = EXCLUDED.bid,
        ask = EXCLUDED.ask,
        halted = EXCLUDED.halted,
        upper_circuit = EXCLUDED.upper_circuit,
        lower_circuit = EXCLUDED.lower_circuit,
        as_of = EXCLUDED.as_of,
        received_at = now(),
        provider = EXCLUDED.provider
     -- The guard. An older observation is discarded, not applied.
     WHERE quotes.as_of < EXCLUDED.as_of
     RETURNING instrument_id`,
    [
      instrumentId,
      q.price,
      q.previousClose,
      q.open,
      q.dayHigh,
      q.dayLow,
      q.volume,
      q.bid ?? null,
      q.ask ?? null,
      q.halted ?? false,
      q.upperCircuit ?? null,
      q.lowerCircuit ?? null,
      new Date(q.asOf),
      provider,
    ],
  );

  return {
    instrumentId,
    accepted: rows.length > 0,
    previous: before ? { price: before.price, asOf: before.as_of.getTime() } : null,
  };
}

/** Append to the rolling tape used for sparklines. Duplicates are no-ops. */
export async function appendTick(
  tx: Tx,
  instrumentId: string,
  asOf: number,
  price: number,
  volume: number | null,
): Promise<void> {
  await tx.execute(
    `INSERT INTO quote_ticks (instrument_id, as_of, price, volume)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (instrument_id, as_of) DO NOTHING`,
    [instrumentId, new Date(asOf), price, volume],
  );
}

/** Keep the tape bounded; called on a slow cadence by the worker. */
export async function trimTape(keepPerInstrument: number): Promise<number> {
  return execute(
    `DELETE FROM quote_ticks t
      USING (
        SELECT instrument_id, as_of,
               row_number() OVER (PARTITION BY instrument_id ORDER BY as_of DESC) AS rn
          FROM quote_ticks
      ) ranked
      WHERE ranked.instrument_id = t.instrument_id
        AND ranked.as_of = t.as_of
        AND ranked.rn > $1`,
    [keepPerInstrument],
  );
}

export async function getTape(
  instrumentIds: readonly string[],
  points: number,
): Promise<Record<string, Array<{ t: number; p: number }>>> {
  if (instrumentIds.length === 0) return {};
  const rows = await query<{ instrument_id: string; as_of: Date; price: number }>(
    `SELECT instrument_id, as_of, price FROM (
        SELECT instrument_id, as_of, price,
               row_number() OVER (PARTITION BY instrument_id ORDER BY as_of DESC) AS rn
          FROM quote_ticks
         WHERE instrument_id = ANY($1::uuid[])
     ) x WHERE rn <= $2
     ORDER BY instrument_id, as_of`,
    [instrumentIds, points],
  );
  const out: Record<string, Array<{ t: number; p: number }>> = {};
  for (const r of rows) {
    (out[r.instrument_id] ??= []).push({ t: r.as_of.getTime(), p: r.price });
  }
  return out;
}
