/**
 * The scheduler.
 *
 * The single most important decision in this file is that polling is fanned in
 * by *instrument*, not by user-instrument pair. A name held by one person and
 * a name held by fifty thousand cost the same to keep current. Watchlists
 * become a subscription set, and the cost of the system tracks the size of the
 * market, not the size of the user base.
 *
 * On top of that sits demand tiering. There is no point spending a poll every
 * five seconds on a stock whose only watcher closed the tab yesterday, and
 * there is every point spending it on one somebody is looking at right now.
 */

import { config } from "../config";
import { query } from "../db/client";
import { drainOutbox, purgePublished } from "../events/outbox";
import { pruneAcknowledgements, purgeOldEvents } from "../repo/events";
import { trimTape } from "../repo/quotes";
import { toInstrument, type Instrument, type InstrumentRow } from "../repo/instruments";
import { purgeExpiredHandoffCodes } from "../session";
import { refreshBaselines } from "./baselines";
import { ingest, type IngestReport } from "./pipeline";
import { rollUpVolumeProfiles } from "./volume-profile";
import { currentSession } from "../services/market-clock";

export type Tier = "hot" | "warm" | "cold";

export interface WorkerStats {
  ticks: number;
  lastTickAt: number | null;
  lastReport: IngestReport | null;
  instrumentsDue: number;
  errors: number;
  lastError: string | null;
  running: boolean;
  startedAt: number | null;
}

const TIER_INTERVAL: Record<Tier, () => number> = {
  hot: () => config.POLL_HOT_MS,
  warm: () => config.POLL_WARM_MS,
  cold: () => config.POLL_COLD_MS,
};

/** "Somebody has looked at the app recently" is what makes a name hot. */
const HOT_ACTIVITY_WINDOW = "5 minutes";

export class IngestWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private tickCount = 0;
  private stats: WorkerStats = {
    ticks: 0,
    lastTickAt: null,
    lastReport: null,
    instrumentsDue: 0,
    errors: 0,
    lastError: null,
    running: false,
    startedAt: null,
  };

  start(): void {
    if (this.timer) return;
    this.stats.running = true;
    this.stats.startedAt = Date.now();
    this.timer = setInterval(() => void this.safeTick(), config.WORKER_TICK_MS);
    // Node keeps the process alive for an interval; the worker should not be
    // the reason a serverless-style shutdown hangs.
    this.timer.unref?.();
    void this.safeTick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stats.running = false;
  }

  snapshot(): WorkerStats {
    return { ...this.stats };
  }

  private async safeTick(): Promise<void> {
    // Overlapping ticks would double-poll and fight over advisory locks.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.tick();
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      console.error("[worker] tick failed:", err);
    } finally {
      this.inFlight = false;
    }
  }

  private async tick(): Promise<void> {
    this.tickCount += 1;
    this.stats.ticks = this.tickCount;
    this.stats.lastTickAt = Date.now();

    // Retier every ~15s: cheap, and it is what makes the hot set follow
    // attention rather than lag behind it.
    if (this.tickCount % Math.max(1, Math.round(15_000 / config.WORKER_TICK_MS)) === 1) {
      await this.retier();
    }

    const due = await this.claimDue(config.QUOTE_BATCH_SIZE);
    this.stats.instrumentsDue = due.length;
    if (due.length > 0) {
      this.stats.lastReport = await ingest(due.map((d) => d.instrument));
      await this.scheduleNext(due);
    }

    await drainOutbox();

    // Maintenance, spread out so no single tick is expensive.
    if (this.tickCount % 60 === 0) await refreshBaselines({ limit: 6 });
    if (this.tickCount % 120 === 0) {
      await trimTape(config.TAPE_LENGTH);
      await pruneAcknowledgements();
      // Fold yesterday's observed volume shape into each instrument's profile.
      await rollUpVolumeProfiles(currentSession().sessionDate);
    }
    if (this.tickCount % 3600 === 0) {
      await purgePublished();
      await purgeOldEvents();
      await purgeExpiredHandoffCodes();
    }
  }

  /**
   * Assign a polling tier to every instrument in one statement.
   *
   * Instruments nobody watches fall back to `cold` via the LEFT JOIN, which
   * also means an instrument dropped from the last watchlist stops costing us
   * anything within one retier cycle.
   */
  private async retier(): Promise<void> {
    await query(
      `INSERT INTO ingest_state (instrument_id, tier, next_poll_at)
       SELECT i.id,
              CASE
                WHEN d.hot   > 0 THEN 'hot'
                WHEN d.warm  > 0 THEN 'warm'
                ELSE 'cold'
              END,
              now()
         FROM instruments i
         LEFT JOIN (
             SELECT wi.instrument_id,
                    count(*) FILTER (
                      WHERE u.last_checked_at > now() - interval '${HOT_ACTIVITY_WINDOW}'
                    ) AS hot,
                    count(*) AS warm
               FROM watchlist_items wi
               JOIN watchlists w ON w.id = wi.watchlist_id
               JOIN users u ON u.id = w.user_id
              GROUP BY wi.instrument_id
         ) d ON d.instrument_id = i.id
        WHERE i.is_active
       ON CONFLICT (instrument_id) DO UPDATE SET tier = EXCLUDED.tier`,
    );
  }

  /**
   * Take the next batch of due instruments.
   *
   * `FOR UPDATE SKIP LOCKED` lets several worker processes share the rotation
   * without coordination: each takes rows the others are not holding, so
   * scaling the worker out is adding a process, not adding a leader election.
   */
  private async claimDue(limit: number): Promise<Array<{ instrument: Instrument; tier: Tier }>> {
    const rows = await query<InstrumentRow & { tier: Tier }>(
      `WITH due AS (
          SELECT s.instrument_id, s.tier
            FROM ingest_state s
           WHERE s.next_poll_at <= now()
           ORDER BY (s.tier = 'hot') DESC, s.next_poll_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
       )
       SELECT i.*, due.tier
         FROM instruments i JOIN due ON due.instrument_id = i.id`,
      [limit],
    );
    return rows.map((r) => ({ instrument: toInstrument(r), tier: r.tier }));
  }

  /**
   * Schedule the next poll per instrument, with jitter and error backoff.
   *
   * Jitter matters more than it looks: without it every instrument added in
   * the same second polls in the same second forever, and the load profile
   * becomes a set of spikes separated by idle time.
   */
  private async scheduleNext(
    due: ReadonlyArray<{ instrument: Instrument; tier: Tier }>,
  ): Promise<void> {
    if (due.length === 0) return;
    const ids: string[] = [];
    const delays: number[] = [];
    for (const d of due) {
      const base = TIER_INTERVAL[d.tier]();
      ids.push(d.instrument.id);
      delays.push(Math.round(base * (0.85 + Math.random() * 0.3)));
    }
    await query(
      `UPDATE ingest_state s
          SET next_poll_at = now()
              + (t.delay_ms * least(power(2, least(s.consecutive_errors, 5)), 32)) * interval '1 millisecond'
         FROM unnest($1::uuid[], $2::int[]) AS t(id, delay_ms)
        WHERE s.instrument_id = t.id`,
      [ids, delays],
    );
  }
}

declare global {
  var __tidemarkWorker: IngestWorker | undefined;
}

export function worker(): IngestWorker {
  globalThis.__tidemarkWorker ??= new IngestWorker();
  return globalThis.__tidemarkWorker;
}

/**
 * Start the worker inside the web process.
 *
 * Convenient for development and for a single-container deployment; set
 * RUN_WORKER_IN_WEB=false and run `npm run worker` when the two should scale
 * separately. Either way the advisory locks mean running both is safe.
 */
export function startWorkerIfEnabled(): void {
  if (!config.RUN_WORKER_IN_WEB) return;
  worker().start();
}
