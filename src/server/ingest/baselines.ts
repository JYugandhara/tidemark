/**
 * Baseline maintenance.
 *
 * Volatility, typical volume and rolling extremes are recomputed on a slow
 * cadence from daily bars. This is the cheap half of the system — a few
 * hundred numbers per instrument per day — and it is what lets the hot path
 * answer "is this move unusual?" with a division instead of a query.
 */

import { buildBaseline } from "@/core/significance/baseline";
import { query } from "../db/client";
import { getProviderPool } from "../providers/pool";
import {
  getDailyBars,
  saveBaseline,
  toInstrument,
  upsertDailyBars,
  type InstrumentRow,
} from "../repo/instruments";

const HISTORY_DAYS = 260;

function toObserved(row: InstrumentRow & { volume_profile_observed?: number[] }) {
  const shares = row.volume_profile_observed;
  if (!Array.isArray(shares) || shares.length === 0) return null;
  return { shares, samples: row.volume_profile_samples };
}

export interface BaselineRefreshResult {
  refreshed: number;
  backfilled: number;
  failures: Array<{ symbol: string; error: string }>;
}

/**
 * Refresh instruments whose baseline is missing or older than `maxAgeHours`.
 *
 * Bounded by `limit` per call so a cold start with a large universe spreads
 * its backfill over several ticks instead of stalling the poll loop.
 */
export async function refreshBaselines(
  opts: { maxAgeHours?: number; limit?: number } = {},
): Promise<BaselineRefreshResult> {
  const maxAge = opts.maxAgeHours ?? 20;
  const limit = opts.limit ?? 8;
  const out: BaselineRefreshResult = { refreshed: 0, backfilled: 0, failures: [] };

  const rows = await query<InstrumentRow>(
    `SELECT * FROM instruments
      WHERE is_active
        AND (baseline_computed_at IS NULL OR baseline_computed_at < now() - ($1 || ' hours')::interval)
      ORDER BY baseline_computed_at NULLS FIRST
      LIMIT $2`,
    [String(maxAge), limit],
  );
  if (rows.length === 0) return out;

  const pool = getProviderPool();

  for (const row of rows) {
    const inst = toInstrument(row);
    try {
      let bars = await getDailyBars(inst.id, HISTORY_DAYS);
      // Fewer than a quarter of a year of bars is not enough for a credible
      // volatility estimate, so go and get some.
      if (bars.length < 60) {
        const fetched = await pool.getDailyBars(inst.symbol, HISTORY_DAYS);
        if (fetched.bars.length > 0) {
          out.backfilled += await upsertDailyBars(inst.id, fetched.bars);
          bars = await getDailyBars(inst.id, HISTORY_DAYS);
        }
      }
      if (bars.length === 0) {
        out.failures.push({ symbol: inst.symbol, error: "no daily history available" });
        continue;
      }
      const baseline = buildBaseline({
        instrumentId: inst.id,
        bars,
        // The blend weight inside buildBaseline is driven by how many sessions
        // we have observed, so this quietly takes over from the generic curve
        // as evidence accumulates.
        observedProfile: toObserved(row),
        now: Date.now(),
      });
      await saveBaseline(inst.id, baseline);
      out.refreshed += 1;
    } catch (err) {
      out.failures.push({
        symbol: inst.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
