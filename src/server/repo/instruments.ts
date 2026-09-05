/**
 * Instrument reads and baseline persistence.
 */

import type { InstrumentBaseline } from "@/core/types";
import { defaultVolumeProfile } from "@/core/significance/baseline";
import { execute, query, queryOne, type Tx } from "../db/client";

export interface InstrumentRow {
  id: string;
  symbol: string;
  exchange: string;
  name: string;
  sector: string | null;
  currency: string;
  is_active: boolean;
  daily_sigma: number;
  sample_size: number;
  log_volume_mean: number;
  log_volume_sigma: number;
  volume_profile: number[];
  volume_profile_samples: number;
  volume_profile_observed?: number[];
  high_52w: number | null;
  low_52w: number | null;
  high_20d: number | null;
  low_20d: number | null;
  median_abs_return: number;
  baseline_computed_at: Date | null;
}

export interface Instrument {
  id: string;
  symbol: string;
  exchange: string;
  name: string;
  sector: string | null;
  currency: string;
  baseline: InstrumentBaseline;
  baselineComputedAt: number | null;
}

const SELECT = `
  SELECT id, symbol, exchange, name, sector, currency, is_active,
         daily_sigma, sample_size, log_volume_mean, log_volume_sigma,
         volume_profile, volume_profile_samples,
         high_52w, low_52w, high_20d, low_20d, median_abs_return,
         baseline_computed_at
    FROM instruments`;

export function toInstrument(r: InstrumentRow): Instrument {
  const profile =
    Array.isArray(r.volume_profile) && r.volume_profile.length > 0
      ? r.volume_profile
      : defaultVolumeProfile();
  return {
    id: r.id,
    symbol: r.symbol,
    exchange: r.exchange,
    name: r.name,
    sector: r.sector,
    currency: r.currency,
    baselineComputedAt: r.baseline_computed_at?.getTime() ?? null,
    baseline: {
      instrumentId: r.id,
      dailySigma: r.daily_sigma,
      sampleSize: r.sample_size,
      logVolumeMean: r.log_volume_mean,
      logVolumeSigma: r.log_volume_sigma,
      volumeProfile: profile,
      high52w: r.high_52w,
      low52w: r.low_52w,
      high20d: r.high_20d,
      low20d: r.low_20d,
      medianAbsReturn: r.median_abs_return,
      computedAt: r.baseline_computed_at?.getTime() ?? 0,
    },
  };
}

export async function getInstrumentsByIds(ids: readonly string[]): Promise<Instrument[]> {
  if (ids.length === 0) return [];
  const rows = await query<InstrumentRow>(`${SELECT} WHERE id = ANY($1::uuid[])`, [ids]);
  return rows.map(toInstrument);
}

export async function getInstrumentBySymbol(
  symbol: string,
  exchange = "NSE",
): Promise<Instrument | null> {
  const row = await queryOne<InstrumentRow>(
    `${SELECT} WHERE exchange = $1 AND upper(symbol) = upper($2)`,
    [exchange, symbol],
  );
  return row ? toInstrument(row) : null;
}

/**
 * Symbol/name search for the "add to watchlist" box.
 *
 * Ranked so an exact ticker match always wins, then prefix matches, then
 * substring matches on the company name — which is the order a person typing
 * "REL" expects.
 */
export async function searchInstruments(term: string, limit = 12): Promise<Instrument[]> {
  const t = term.trim();
  if (!t) return [];
  const rows = await query<InstrumentRow>(
    `${SELECT}
      WHERE is_active
        AND (symbol ILIKE $1 OR name ILIKE $1)
      ORDER BY
        (upper(symbol) = upper($2)) DESC,
        (symbol ILIKE $3) DESC,
        (name ILIKE $3) DESC,
        length(symbol) ASC,
        symbol ASC
      LIMIT $4`,
    [`%${t}%`, t, `${t}%`, limit],
  );
  return rows.map(toInstrument);
}

/** Every instrument at least one user is watching, with its subscriber count. */
export async function subscribedInstruments(): Promise<
  Array<{ id: string; symbol: string; subscribers: number }>
> {
  return query<{ id: string; symbol: string; subscribers: number }>(
    `SELECT i.id, i.symbol, count(DISTINCT w.user_id)::int AS subscribers
       FROM instruments i
       JOIN watchlist_items wi ON wi.instrument_id = i.id
       JOIN watchlists w ON w.id = wi.watchlist_id
      WHERE i.is_active
      GROUP BY i.id, i.symbol`,
  );
}

export async function saveBaseline(
  instrumentId: string,
  b: InstrumentBaseline,
  tx?: Tx,
): Promise<void> {
  const sql = `
    UPDATE instruments SET
      daily_sigma = $2, sample_size = $3,
      log_volume_mean = $4, log_volume_sigma = $5,
      volume_profile = $6::jsonb,
      high_52w = $7, low_52w = $8, high_20d = $9, low_20d = $10,
      median_abs_return = $11, baseline_computed_at = now()
    WHERE id = $1`;
  const params = [
    instrumentId,
    b.dailySigma,
    b.sampleSize,
    b.logVolumeMean,
    b.logVolumeSigma,
    JSON.stringify(b.volumeProfile),
    b.high52w,
    b.low52w,
    b.high20d,
    b.low20d,
    b.medianAbsReturn,
  ];
  if (tx) await tx.execute(sql, params);
  else await execute(sql, params);
}

export async function upsertDailyBars(
  instrumentId: string,
  bars: readonly { date: string; open: number; high: number; low: number; close: number; volume: number }[],
): Promise<number> {
  if (bars.length === 0) return 0;
  // One statement with unnest rather than N round trips; history backfill for
  // 40 instruments is otherwise 10,000 individual inserts.
  return execute(
    `INSERT INTO daily_bars (instrument_id, session_date, open, high, low, close, volume)
     SELECT $1, d::date, o, h, l, c, v
       FROM unnest($2::text[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[])
            AS t(d, o, h, l, c, v)
     ON CONFLICT (instrument_id, session_date) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
       close = EXCLUDED.close, volume = EXCLUDED.volume`,
    [
      instrumentId,
      bars.map((b) => b.date),
      bars.map((b) => b.open),
      bars.map((b) => b.high),
      bars.map((b) => b.low),
      bars.map((b) => b.close),
      bars.map((b) => b.volume),
    ],
  );
}

export async function getDailyBars(instrumentId: string, limit = 260) {
  const rows = await query<{
    session_date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>(
    `SELECT session_date, open, high, low, close, volume
       FROM daily_bars WHERE instrument_id = $1
      ORDER BY session_date DESC LIMIT $2`,
    [instrumentId, limit],
  );
  return rows
    .map((r) => ({
      date: toDateString(r.session_date),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }))
    .reverse();
}

export function toDateString(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  // session_date is a DATE; pg gives a Date at local midnight, so formatting
  // through toISOString would shift it a day west of Greenwich.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
