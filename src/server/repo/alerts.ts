/**
 * User-defined price alerts.
 *
 * An alert is the one place where the user overrides the significance model
 * entirely: they have told us a number matters, so it matters, whatever the
 * volatility baseline says.
 *
 * Rules disarm when they fire and re-arm only when the price comes back
 * through the level, which is what stops a stock oscillating around 1,200 from
 * generating an alert every poll.
 */

import type { AlertRule } from "@/core/significance/detect";
import { query, type Tx } from "../db/client";

export interface StoredAlertRule extends AlertRule {
  instrumentId: string;
  symbol: string;
  createdAt: number;
  lastFiredAt: number | null;
}

interface Row {
  id: string;
  instrument_id: string;
  symbol: string;
  kind: "above" | "below";
  level: number;
  armed: boolean;
  created_at: Date;
  last_fired_at: Date | null;
}

const toRule = (r: Row): StoredAlertRule => ({
  id: r.id,
  instrumentId: r.instrument_id,
  symbol: r.symbol,
  kind: r.kind,
  level: r.level,
  armed: r.armed,
  createdAt: r.created_at.getTime(),
  lastFiredAt: r.last_fired_at?.getTime() ?? null,
});

export async function listAlerts(userId: string): Promise<StoredAlertRule[]> {
  const rows = await query<Row>(
    `SELECT a.id, a.instrument_id, i.symbol, a.kind, a.level, a.armed, a.created_at, a.last_fired_at
       FROM alert_rules a JOIN instruments i ON i.id = a.instrument_id
      WHERE a.user_id = $1
      ORDER BY i.symbol, a.level`,
    [userId],
  );
  return rows.map(toRule);
}

export async function createAlert(
  userId: string,
  instrumentId: string,
  kind: "above" | "below",
  level: number,
): Promise<StoredAlertRule | null> {
  const rows = await query<Row>(
    `WITH ins AS (
       INSERT INTO alert_rules (user_id, instrument_id, kind, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, instrument_id, kind, level)
         DO UPDATE SET armed = true
       RETURNING id, instrument_id, kind, level, armed, created_at, last_fired_at
     )
     SELECT ins.*, i.symbol FROM ins JOIN instruments i ON i.id = ins.instrument_id`,
    [userId, instrumentId, kind, level],
  );
  return rows[0] ? toRule(rows[0]) : null;
}

export async function deleteAlert(userId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    "DELETE FROM alert_rules WHERE id = $1 AND user_id = $2 RETURNING id",
    [id, userId],
  );
  return rows.length > 0;
}

export async function alertsByInstrument(userId: string): Promise<Map<string, AlertRule[]>> {
  const rules = await listAlerts(userId);
  const out = new Map<string, AlertRule[]>();
  for (const r of rules) {
    const list = out.get(r.instrumentId);
    const rule: AlertRule = { id: r.id, kind: r.kind, level: r.level, armed: r.armed };
    if (list) list.push(rule);
    else out.set(r.instrumentId, [rule]);
  }
  return out;
}

/** Disarm the rules that just fired; re-arm the ones the price has left behind. */
export async function reconcileArmedState(
  tx: Tx,
  firedRuleIds: readonly string[],
  instrumentId: string,
  price: number,
): Promise<void> {
  if (firedRuleIds.length > 0) {
    await tx.execute(
      `UPDATE alert_rules SET armed = false, last_fired_at = now()
        WHERE id = ANY($1::uuid[])`,
      [firedRuleIds],
    );
  }
  // Re-arm anything the price is now clearly on the "wrong" side of, with a
  // small hysteresis band so a price sitting exactly on the level does not
  // flip-flop between armed and fired.
  await tx.execute(
    `UPDATE alert_rules SET armed = true
      WHERE instrument_id = $1 AND armed = false
        AND ((kind = 'above' AND $2 < level * 0.995)
          OR (kind = 'below' AND $2 > level * 1.005))`,
    [instrumentId, price],
  );
}
