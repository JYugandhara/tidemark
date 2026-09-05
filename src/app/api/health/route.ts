/**
 * Health and observability.
 *
 * Deliberately generous: this is also the data behind the "Feed Room" panel in
 * the UI, because a product whose central claim is honesty about data quality
 * should be willing to show its own plumbing.
 */

import { handler, json } from "@/server/http";
import { healthCheck, query } from "@/server/db/client";
import { getProviderPool } from "@/server/providers/pool";
import { SimulatedProvider } from "@/server/providers/simulated";
import { worker } from "@/server/ingest/scheduler";
import { hub } from "@/server/events/hub";
import { makeCalendar, phaseAt, phaseLabel, istClock } from "@/core/market/calendar";
import { config } from "@/server/config";

export const dynamic = "force-dynamic";

const calendar = makeCalendar();

export const GET = handler(async () => {
  const now = Date.now();
  const db = await healthCheck();

  const [providers, ingest, events, sim] = await Promise.all([
    query<{
      provider: string;
      state: string;
      consecutive_failures: number;
      last_error: string | null;
      last_success_at: Date | null;
      calls: number;
      failures: number;
    }>(
      `SELECT provider, state, consecutive_failures, last_error, last_success_at, calls, failures
         FROM provider_health ORDER BY provider`,
    ).catch(() => []),
    query<{ tier: string; n: number; stale: number }>(
      `SELECT tier, count(*)::int AS n,
              count(*) FILTER (WHERE consecutive_errors > 0)::int AS stale
         FROM ingest_state GROUP BY tier`,
    ).catch(() => []),
    query<{ n: number }>(
      "SELECT count(*)::int AS n FROM change_events WHERE last_updated_at > now() - interval '1 hour'",
    ).catch(() => [{ n: 0 }]),
    Promise.resolve(new SimulatedProvider().clockReading()),
  ]);

  const pool = getProviderPool();
  const phase = phaseAt(calendar, now);

  return json(
    {
      status: db.ok ? "ok" : "degraded",
      now,
      market: {
        phase,
        label: phaseLabel(phase),
        istTime: istClock(now),
      },
      simulation: {
        active: pool.providerNames.includes("simulated"),
        synthetic: sim.synthetic,
        sessionDate: sim.sessionDate,
        minuteOfSession: Number(sim.minute.toFixed(1)),
        seed: config.SIM_SEED,
      },
      database: db,
      providers: {
        configured: pool.providerNames,
        breakers: pool.snapshot(),
        persisted: providers,
      },
      ingest: {
        worker: worker().snapshot(),
        tiers: ingest,
        eventsLastHour: events[0]?.n ?? 0,
      },
      stream: { subscribers: hub().subscriberCount, lastEventId: hub().currentId },
    },
    { headers: { "cache-control": "no-store" } },
  );
});
