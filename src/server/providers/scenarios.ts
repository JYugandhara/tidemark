/**
 * Active fault/market scenarios, cached briefly so the ingest loop does not
 * hit Postgres for them on every symbol.
 */

import { query } from "../db/client";

export type ScenarioKind =
  | "halt"
  | "gap"
  | "spike"
  | "circuit"
  | "stale"
  | "bad_print"
  | "volume_surge"
  | "provider_outage"
  | "latency";

export interface Scenario {
  id: string;
  symbol: string | null;
  kind: ScenarioKind;
  params: Record<string, number | string | boolean>;
  createdAt: number;
  expiresAt: number;
}

interface CacheState {
  loadedAt: number;
  scenarios: Scenario[];
}

const CACHE_TTL_MS = 1_500;
let cache: CacheState = { loadedAt: 0, scenarios: [] };

export async function activeScenarios(now = Date.now()): Promise<Scenario[]> {
  if (now - cache.loadedAt < CACHE_TTL_MS) return cache.scenarios;
  const rows = await query<{
    id: string;
    symbol: string | null;
    kind: ScenarioKind;
    params: Record<string, number | string | boolean>;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT s.id, i.symbol, s.kind, s.params, s.created_at, s.expires_at
       FROM scenarios s
       LEFT JOIN instruments i ON i.id = s.instrument_id
      WHERE s.expires_at > now()
      ORDER BY s.created_at`,
  );
  cache = {
    loadedAt: now,
    scenarios: rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      kind: r.kind,
      params: r.params ?? {},
      createdAt: r.created_at.getTime(),
      expiresAt: r.expires_at.getTime(),
    })),
  };
  return cache.scenarios;
}

/** Drop the cache so a newly-created scenario takes effect on the next tick. */
export function invalidateScenarioCache(): void {
  cache = { loadedAt: 0, scenarios: [] };
}

export function scenariosFor(all: readonly Scenario[], symbol: string): Scenario[] {
  return all.filter((s) => s.symbol === null || s.symbol === symbol);
}

export function num(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
