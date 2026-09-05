/**
 * Scenario injection.
 *
 * The honest way to demonstrate resilience: create the fault for real and let
 * the pipeline meet it with no special handling. Nothing downstream knows a
 * scenario exists — the halt that appears in the digest went through the same
 * detector, the same dedup key and the same outbox as a real one would.
 */

import { z } from "zod";
import { ApiError, handler, json, parseBody, requireUser } from "@/server/http";
import { query } from "@/server/db/client";
import { invalidateScenarioCache } from "@/server/providers/scenarios";
import { getProviderPool } from "@/server/providers/pool";

export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum([
    "halt",
    "gap",
    "spike",
    "circuit",
    "stale",
    "bad_print",
    "volume_surge",
    "provider_outage",
    "latency",
  ]),
  /** Omit for provider-level faults, which apply to everything. */
  instrumentId: z.string().uuid().nullable().optional(),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  ttlSeconds: z.number().int().min(5).max(3600).default(180),
});

export const GET = handler(async () => {
  await requireUser();
  const rows = await query<{
    id: string;
    kind: string;
    symbol: string | null;
    params: Record<string, unknown>;
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT s.id, s.kind, i.symbol, s.params, s.expires_at, s.created_at
       FROM scenarios s LEFT JOIN instruments i ON i.id = s.instrument_id
      WHERE s.expires_at > now()
      ORDER BY s.created_at DESC`,
  );
  return json({
    scenarios: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      symbol: r.symbol,
      params: r.params,
      createdAt: r.created_at.getTime(),
      expiresAt: r.expires_at.getTime(),
    })),
  });
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = await parseBody(req, Body);

  if (body.kind !== "provider_outage" && !body.instrumentId) {
    throw ApiError.invalid("This scenario needs an instrumentId");
  }

  const rows = await query<{ id: string; expires_at: Date }>(
    `INSERT INTO scenarios (instrument_id, kind, params, expires_at, created_by)
     VALUES ($1, $2, $3::jsonb, now() + ($4 || ' seconds')::interval, $5)
     RETURNING id, expires_at`,
    [
      body.instrumentId ?? null,
      body.kind,
      JSON.stringify(body.params),
      String(body.ttlSeconds),
      user.handle,
    ],
  );

  invalidateScenarioCache();
  // A provider outage is also reflected in the breaker immediately, so the
  // Feed Room shows the circuit tripping rather than waiting for five real
  // failures to accumulate.
  if (body.kind === "provider_outage") {
    getProviderPool().forceOpen(String(body.params.provider ?? "simulated"));
  }

  return json({ id: rows[0].id, expiresAt: rows[0].expires_at.getTime() }, { status: 201 });
});
