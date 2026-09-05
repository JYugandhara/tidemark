/**
 * One query for the whole read path.
 *
 * The digest previously assembled itself from three separate round trips —
 * watchlist items, then instruments, then quotes — which is three connections
 * held per request and three chances to queue behind someone else. They are
 * all joins over the same set of rows, so they are one query.
 *
 * Under load this is the difference between the read path holding five
 * connections and holding seven; with a bounded pool that is the difference
 * between p99 latency being flat and being a staircase.
 */

import type { Conviction, Direction } from "@/core/types";
import { defaultVolumeProfile } from "@/core/significance/baseline";
import { query } from "../db/client";
import type { Instrument } from "./instruments";
import type { StoredQuote } from "./quotes";
import type { WatchlistItem } from "./watchlists";

export interface WatchedSnapshotRow {
  item: WatchlistItem;
  instrument: Instrument;
  quote: StoredQuote | null;
}

interface Row {
  item_id: string;
  watchlist_id: string;
  conviction: Conviction;
  muted_until: Date | null;
  position: number;
  note: string | null;
  version: number;

  instrument_id: string;
  symbol: string;
  name: string;
  sector: string | null;
  exchange: string;
  currency: string;
  daily_sigma: number;
  sample_size: number;
  log_volume_mean: number;
  log_volume_sigma: number;
  volume_profile: number[];
  high_52w: number | null;
  low_52w: number | null;
  high_20d: number | null;
  low_20d: number | null;
  median_abs_return: number;
  baseline_computed_at: Date | null;

  price: number | null;
  previous_close: number | null;
  q_open: number | null;
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  halted: boolean | null;
  upper_circuit: number | null;
  lower_circuit: number | null;
  as_of: Date | null;
  received_at: Date | null;
  provider: string | null;
}

const RANK: Record<Conviction, number> = { core: 3, tracking: 2, background: 1 };

export async function watchedSnapshot(userId: string): Promise<WatchedSnapshotRow[]> {
  const rows = await query<Row>(
    `SELECT
        wi.id            AS item_id,
        wi.watchlist_id,
        wi.conviction,
        wi.muted_until,
        wi.position,
        wi.note,
        wi.version,

        i.id             AS instrument_id,
        i.symbol, i.name, i.sector, i.exchange, i.currency,
        i.daily_sigma, i.sample_size, i.log_volume_mean, i.log_volume_sigma,
        i.volume_profile, i.high_52w, i.low_52w, i.high_20d, i.low_20d,
        i.median_abs_return, i.baseline_computed_at,

        q.price, q.previous_close, q.open AS q_open, q.day_high, q.day_low,
        q.volume, q.bid, q.ask, q.halted, q.upper_circuit, q.lower_circuit,
        q.as_of, q.received_at, q.provider
      FROM watchlist_items wi
      JOIN watchlists w  ON w.id = wi.watchlist_id AND w.user_id = $1
      JOIN instruments i ON i.id = wi.instrument_id
      LEFT JOIN quotes q ON q.instrument_id = i.id
     ORDER BY wi.position, i.symbol`,
    [userId],
  );

  // The same instrument can appear on more than one of a reader's lists. It is
  // one thing in the world, so it appears once in the digest, at the strongest
  // conviction they gave it anywhere.
  const best = new Map<string, WatchedSnapshotRow>();
  for (const r of rows) {
    const existing = best.get(r.instrument_id);
    if (existing && RANK[existing.item.conviction] >= RANK[r.conviction]) continue;
    best.set(r.instrument_id, toRow(r));
  }
  return [...best.values()];
}

function toRow(r: Row): WatchedSnapshotRow {
  const profile =
    Array.isArray(r.volume_profile) && r.volume_profile.length > 0
      ? r.volume_profile
      : defaultVolumeProfile();

  return {
    item: {
      id: r.item_id,
      watchlistId: r.watchlist_id,
      instrumentId: r.instrument_id,
      symbol: r.symbol,
      name: r.name,
      sector: r.sector,
      conviction: r.conviction,
      mutedUntil: r.muted_until?.getTime() ?? null,
      position: r.position,
      note: r.note,
      version: r.version,
    },
    instrument: {
      id: r.instrument_id,
      symbol: r.symbol,
      exchange: r.exchange,
      name: r.name,
      sector: r.sector,
      currency: r.currency,
      baselineComputedAt: r.baseline_computed_at?.getTime() ?? null,
      baseline: {
        instrumentId: r.instrument_id,
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
    },
    quote:
      r.price !== null && r.previous_close !== null && r.as_of !== null
        ? {
            instrumentId: r.instrument_id,
            symbol: r.symbol,
            price: r.price,
            previousClose: r.previous_close,
            open: r.q_open,
            dayHigh: r.day_high,
            dayLow: r.day_low,
            volume: r.volume,
            bid: r.bid,
            ask: r.ask,
            halted: r.halted ?? false,
            upperCircuit: r.upper_circuit,
            lowerCircuit: r.lower_circuit,
            asOf: r.as_of.getTime(),
            receivedAt: r.received_at?.getTime() ?? r.as_of.getTime(),
            provider: r.provider ?? "unknown",
          }
        : null,
  };
}

export type { Direction };
