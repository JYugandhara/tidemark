/**
 * Persistence for the observed intraday volume shape.
 *
 * Two halves: a cheap write on every accepted quote that records where in the
 * session we are and how much has traded, and a slow roll-up that turns
 * completed sessions into a running mean on the instrument and then throws the
 * raw rows away.
 */

import { VOLUME_BUCKETS } from "@/core/significance/baseline";
import {
  foldObservedProfile,
  sessionShares,
  type ObservedProfile,
} from "@/core/significance/volume-profile";
import { query, withTransaction, type Tx } from "../db/client";

/**
 * Record cumulative volume for the current bucket.
 *
 * `GREATEST` rather than assignment: polls arrive out of order and a provider
 * that resets its counter mid-session must not be able to walk the number
 * backwards.
 */
export async function recordVolumeBucket(
  tx: Tx,
  instrumentId: string,
  sessionDate: string,
  bucket: number,
  cumulativeVolume: number,
): Promise<void> {
  if (!Number.isFinite(cumulativeVolume) || cumulativeVolume < 0) return;
  await tx.execute(
    `INSERT INTO intraday_volume (instrument_id, session_date, bucket, cum_volume)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (instrument_id, session_date, bucket)
       DO UPDATE SET cum_volume = GREATEST(intraday_volume.cum_volume, EXCLUDED.cum_volume)`,
    [instrumentId, sessionDate, bucket, cumulativeVolume],
  );
}

export interface RollUpResult {
  sessionsFolded: number;
  instrumentsUpdated: number;
  rowsPruned: number;
}

/**
 * Fold every completed session into its instrument's observed profile.
 *
 * "Completed" means a session strictly older than the one currently running, so
 * a half-finished day can never teach the model that the afternoon does not
 * exist.
 */
export async function rollUpVolumeProfiles(
  currentSessionDate: string,
  limit = 40,
): Promise<RollUpResult> {
  const out: RollUpResult = { sessionsFolded: 0, instrumentsUpdated: 0, rowsPruned: 0 };

  const pending = await query<{ instrument_id: string; session_date: Date }>(
    `SELECT DISTINCT instrument_id, session_date
       FROM intraday_volume
      WHERE session_date < $1::date
      ORDER BY session_date
      LIMIT $2`,
    [currentSessionDate, limit],
  );
  if (pending.length === 0) return out;

  const touched = new Set<string>();

  for (const p of pending) {
    try {
      await withTransaction(async (tx) => {
        const rows = await tx.query<{ bucket: number; cum_volume: number }>(
          `SELECT bucket, cum_volume FROM intraday_volume
            WHERE instrument_id = $1 AND session_date = $2
            ORDER BY bucket
            FOR UPDATE`,
          [p.instrument_id, p.session_date],
        );

        const cumulative: Array<number | null> = Array(VOLUME_BUCKETS).fill(null);
        for (const r of rows) {
          if (r.bucket >= 0 && r.bucket < VOLUME_BUCKETS) cumulative[r.bucket] = r.cum_volume;
        }

        const shares = sessionShares(cumulative);
        if (shares) {
          const current = await tx.queryOne<{
            volume_profile_observed: number[];
            volume_profile_samples: number;
          }>(
            `SELECT volume_profile_observed, volume_profile_samples
               FROM instruments WHERE id = $1 FOR UPDATE`,
            [p.instrument_id],
          );

          const existing: ObservedProfile | null =
            current && Array.isArray(current.volume_profile_observed)
              ? {
                  shares: current.volume_profile_observed,
                  samples: current.volume_profile_samples,
                }
              : null;

          const folded = foldObservedProfile(existing, shares);
          await tx.execute(
            `UPDATE instruments
                SET volume_profile_observed = $2::jsonb,
                    volume_profile_samples = $3
              WHERE id = $1`,
            [p.instrument_id, JSON.stringify(folded.shares), folded.samples],
          );
          out.sessionsFolded += 1;
          touched.add(p.instrument_id);
        }

        // Whether or not the session was usable, the raw rows have served their
        // purpose and must not accumulate.
        const pruned = await tx.execute(
          "DELETE FROM intraday_volume WHERE instrument_id = $1 AND session_date = $2",
          [p.instrument_id, p.session_date],
        );
        out.rowsPruned += pruned;
      });
    } catch (err) {
      console.error(
        `[volume-profile] roll-up failed for ${p.instrument_id} ${p.session_date.toISOString().slice(0, 10)}:`,
        err,
      );
    }
  }

  out.instrumentsUpdated = touched.size;
  return out;
}

/** The observed profile stored on an instrument, if it has one worth using. */
export async function readObservedProfile(
  instrumentId: string,
): Promise<ObservedProfile | null> {
  const row = await query<{
    volume_profile_observed: number[];
    volume_profile_samples: number;
  }>(
    `SELECT volume_profile_observed, volume_profile_samples
       FROM instruments WHERE id = $1`,
    [instrumentId],
  );
  const r = row[0];
  if (!r || !Array.isArray(r.volume_profile_observed) || r.volume_profile_observed.length === 0) {
    return null;
  }
  return { shares: r.volume_profile_observed, samples: r.volume_profile_samples };
}
