/**
 * Transactional outbox.
 *
 * Notifications are written in the same transaction as the data that caused
 * them. If the process dies between committing an event and telling anyone
 * about it, the row is still there and gets published on the next drain. The
 * failure mode is therefore a duplicate delivery, which subscribers handle by
 * de-duplicating on event id — as opposed to a lost delivery, which nothing
 * downstream can recover from.
 */

import { query, type Tx } from "../db/client";
import { hub } from "./hub";

export async function enqueue(tx: Tx, topic: string, payload: unknown): Promise<void> {
  await tx.execute("INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)", [
    topic,
    JSON.stringify(payload),
  ]);
}

export interface DrainResult {
  published: number;
}

/**
 * Publish pending rows and mark them done.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run from more than one
 * process: each drainer takes a disjoint slice instead of every drainer
 * fighting over the same head of the queue.
 */
export async function drainOutbox(limit = 200): Promise<DrainResult> {
  const rows = await query<{ id: number; topic: string; payload: { event?: string } & Record<string, unknown> }>(
    `WITH picked AS (
        SELECT id FROM outbox
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox o SET published_at = now()
       FROM picked
      WHERE o.id = picked.id
      RETURNING o.id, o.topic, o.payload`,
    [limit],
  );

  for (const r of rows) {
    const { event, ...data } = r.payload ?? {};
    hub().publish(r.topic, typeof event === "string" ? event : "message", data, r.id);
  }
  return { published: rows.length };
}

export async function purgePublished(days = 2): Promise<number> {
  const rows = await query<{ n: number }>(
    `WITH d AS (
        DELETE FROM outbox
         WHERE published_at IS NOT NULL AND published_at < now() - ($1 || ' days')::interval
        RETURNING 1
     ) SELECT count(*)::int AS n FROM d`,
    [String(days)],
  );
  return rows[0]?.n ?? 0;
}
