/**
 * Universe seeding.
 *
 * Idempotent, and safe to run on every boot: instruments are upserted by
 * (exchange, symbol), so a redeploy does not duplicate the universe and a new
 * name added to the file appears without a manual migration.
 */

import { query } from "../db/client";
import { UNIVERSE } from "../providers/universe";

export interface SeedResult {
  instruments: number;
  corporateActions: number;
}

export async function ensureUniverseSeeded(): Promise<SeedResult> {
  const inserted = await query<{ id: string }>(
    `INSERT INTO instruments (symbol, exchange, name, sector, daily_sigma)
     SELECT s, 'NSE', n, sec, sig
       FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[]) AS t(s, n, sec, sig)
     ON CONFLICT (exchange, symbol) DO UPDATE SET name = EXCLUDED.name, sector = EXCLUDED.sector
     RETURNING id`,
    [
      UNIVERSE.map((u) => u.symbol),
      UNIVERSE.map((u) => u.name),
      UNIVERSE.map((u) => u.sector),
      UNIVERSE.map((u) => u.dailySigma),
    ],
  );

  // Every instrument needs a scheduler row, or it is invisible to the worker.
  await query(
    `INSERT INTO ingest_state (instrument_id, tier, next_poll_at)
     SELECT id, 'cold', now() FROM instruments
     ON CONFLICT (instrument_id) DO NOTHING`,
  );

  const ca = await seedCorporateActions();
  return { instruments: inserted.length, corporateActions: ca };
}

/**
 * A handful of upcoming corporate actions so the calendar signal has something
 * to fire on. Dates are derived from the symbol so they are stable across
 * restarts rather than jumping every boot.
 */
async function seedCorporateActions(): Promise<number> {
  const picks = UNIVERSE.filter((_, i) => i % 7 === 0);
  const kinds = ["earnings", "dividend", "split"] as const;
  const rows = picks.map((u, i) => ({
    symbol: u.symbol,
    kind: kinds[i % kinds.length],
    offset: 1 + ((u.symbol.length * 3 + i) % 6),
  }));

  const res = await query<{ id: string }>(
    `INSERT INTO corporate_actions (instrument_id, kind, effective_date, note)
     SELECT i.id, t.kind, current_date + t.offset, 'Synthetic calendar entry for demonstration'
       FROM unnest($1::text[], $2::text[], $3::int[]) AS t(symbol, kind, "offset")
       JOIN instruments i ON i.symbol = t.symbol
     ON CONFLICT (instrument_id, kind, effective_date) DO NOTHING
     RETURNING id`,
    [rows.map((r) => r.symbol), rows.map((r) => r.kind), rows.map((r) => r.offset)],
  );
  return res.length;
}
