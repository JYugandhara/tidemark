/**
 * Watchlist CRUD with optimistic concurrency.
 *
 * Two devices on the same account is the normal case, not the exotic one: a
 * phone in a pocket and a laptop on a desk, both with the app open. Every
 * mutation therefore carries the version the caller believed it was editing,
 * and a mismatch returns the current server state instead of quietly
 * overwriting whatever the other device just did.
 */

import type { Conviction } from "@/core/types";
import { query, queryOne, withTransaction, type Tx } from "../db/client";

export interface WatchlistItem {
  id: string;
  watchlistId: string;
  instrumentId: string;
  symbol: string;
  name: string;
  sector: string | null;
  conviction: Conviction;
  mutedUntil: number | null;
  position: number;
  note: string | null;
  version: number;
}

export interface Watchlist {
  id: string;
  name: string;
  position: number;
  version: number;
  items: WatchlistItem[];
}

export type Conflict<T> = { ok: true; value: T } | { ok: false; current: T | null };

interface ItemRow {
  id: string;
  watchlist_id: string;
  instrument_id: string;
  symbol: string;
  name: string;
  sector: string | null;
  conviction: Conviction;
  muted_until: Date | null;
  position: number;
  note: string | null;
  version: number;
}

function toItem(r: ItemRow): WatchlistItem {
  return {
    id: r.id,
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
  };
}

const ITEM_SELECT = `
  SELECT wi.id, wi.watchlist_id, wi.instrument_id, i.symbol, i.name, i.sector,
         wi.conviction, wi.muted_until, wi.position, wi.note, wi.version
    FROM watchlist_items wi
    JOIN instruments i ON i.id = wi.instrument_id`;

export async function listWatchlists(userId: string): Promise<Watchlist[]> {
  const lists = await query<{ id: string; name: string; position: number; version: number }>(
    "SELECT id, name, position, version FROM watchlists WHERE user_id = $1 ORDER BY position, created_at",
    [userId],
  );
  if (lists.length === 0) return [];
  const items = await query<ItemRow>(
    `${ITEM_SELECT}
      WHERE wi.watchlist_id = ANY($1::uuid[])
      ORDER BY wi.position, i.symbol`,
    [lists.map((l) => l.id)],
  );
  const byList = new Map<string, WatchlistItem[]>();
  for (const r of items) {
    const bucket = byList.get(r.watchlist_id);
    if (bucket) bucket.push(toItem(r));
    else byList.set(r.watchlist_id, [toItem(r)]);
  }
  return lists.map((l) => ({ ...l, items: byList.get(l.id) ?? [] }));
}

/** Every instrument this user watches, deduplicated across lists. */
export async function watchedItems(userId: string): Promise<WatchlistItem[]> {
  const rows = await query<ItemRow>(
    `${ITEM_SELECT}
       JOIN watchlists w ON w.id = wi.watchlist_id
      WHERE w.user_id = $1
      ORDER BY wi.position, i.symbol`,
    [userId],
  );
  // If the same instrument sits on two lists, the strongest conviction wins.
  const rank: Record<Conviction, number> = { core: 3, tracking: 2, background: 1 };
  const best = new Map<string, WatchlistItem>();
  for (const r of rows) {
    const item = toItem(r);
    const prev = best.get(item.instrumentId);
    if (!prev || rank[item.conviction] > rank[prev.conviction]) best.set(item.instrumentId, item);
  }
  return [...best.values()];
}

export async function createWatchlist(userId: string, name: string): Promise<Watchlist> {
  const row = await queryOne<{ id: string; name: string; position: number; version: number }>(
    `INSERT INTO watchlists (user_id, name, position)
     VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM watchlists WHERE user_id = $1), 0))
     RETURNING id, name, position, version`,
    [userId, name],
  );
  return { ...row!, items: [] };
}

export async function renameWatchlist(
  userId: string,
  watchlistId: string,
  name: string,
  expectedVersion: number,
): Promise<Conflict<{ id: string; name: string; version: number }>> {
  const updated = await queryOne<{ id: string; name: string; version: number }>(
    `UPDATE watchlists SET name = $3, version = version + 1
      WHERE id = $2 AND user_id = $1 AND version = $4
      RETURNING id, name, version`,
    [userId, watchlistId, name, expectedVersion],
  );
  if (updated) return { ok: true, value: updated };
  const current = await queryOne<{ id: string; name: string; version: number }>(
    "SELECT id, name, version FROM watchlists WHERE id = $1 AND user_id = $2",
    [watchlistId, userId],
  );
  return { ok: false, current };
}

export async function deleteWatchlist(userId: string, watchlistId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    "DELETE FROM watchlists WHERE id = $1 AND user_id = $2 RETURNING id",
    [watchlistId, userId],
  );
  return rows.length > 0;
}

/**
 * Add an instrument. Adding something already on the list is not an error —
 * it is a user double-tapping — so this is an idempotent upsert that returns
 * the existing row.
 */
export async function addItem(
  userId: string,
  watchlistId: string,
  instrumentId: string,
  conviction: Conviction = "tracking",
): Promise<WatchlistItem | null> {
  return withTransaction(async (tx) => {
    const owns = await tx.queryOne<{ id: string }>(
      "SELECT id FROM watchlists WHERE id = $1 AND user_id = $2",
      [watchlistId, userId],
    );
    if (!owns) return null;

    await tx.execute(
      `INSERT INTO watchlist_items (watchlist_id, instrument_id, conviction, position)
       VALUES ($1, $2, $3,
         COALESCE((SELECT max(position) + 1 FROM watchlist_items WHERE watchlist_id = $1), 0))
       ON CONFLICT (watchlist_id, instrument_id) DO NOTHING`,
      [watchlistId, instrumentId, conviction],
    );
    // Ensure the instrument is in the polling rotation from this moment on.
    await tx.execute(
      `INSERT INTO ingest_state (instrument_id, tier, next_poll_at)
       VALUES ($1, 'hot', now())
       ON CONFLICT (instrument_id) DO UPDATE SET next_poll_at = LEAST(ingest_state.next_poll_at, now())`,
      [instrumentId],
    );

    const row = await tx.queryOne<ItemRow>(
      `${ITEM_SELECT} WHERE wi.watchlist_id = $1 AND wi.instrument_id = $2`,
      [watchlistId, instrumentId],
    );
    return row ? toItem(row) : null;
  });
}

export async function removeItem(userId: string, itemId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM watchlist_items wi
      USING watchlists w
      WHERE wi.id = $1 AND w.id = wi.watchlist_id AND w.user_id = $2
      RETURNING wi.id`,
    [itemId, userId],
  );
  return rows.length > 0;
}

export interface ItemPatch {
  conviction?: Conviction;
  mutedUntil?: number | null;
  note?: string | null;
  position?: number;
}

export async function updateItem(
  userId: string,
  itemId: string,
  patch: ItemPatch,
  expectedVersion: number,
): Promise<Conflict<WatchlistItem>> {
  // Two statements in one transaction rather than one clever statement: a
  // data-modifying CTE's changes are not visible to the SELECT that follows it
  // in the same statement, so reading the row back that way would return the
  // pre-update version and hand the client a stale token for its next edit.
  return withTransaction(async (tx) => {
    const updated = await tx.queryOne<{ id: string }>(
      `UPDATE watchlist_items wi SET
          conviction  = COALESCE($4, wi.conviction),
          muted_until = CASE WHEN $5::boolean THEN $6::timestamptz ELSE wi.muted_until END,
          note        = CASE WHEN $7::boolean THEN $8::text ELSE wi.note END,
          position    = COALESCE($9, wi.position),
          version     = wi.version + 1,
          updated_at  = now()
        FROM watchlists w
        WHERE wi.id = $2
          AND w.id = wi.watchlist_id
          AND w.user_id = $1
          AND wi.version = $3
        RETURNING wi.id`,
      [
        userId,
        itemId,
        expectedVersion,
        patch.conviction ?? null,
        patch.mutedUntil !== undefined,
        patch.mutedUntil ? new Date(patch.mutedUntil) : null,
        patch.note !== undefined,
        patch.note ?? null,
        patch.position ?? null,
      ],
    );

    const row = await tx.queryOne<ItemRow>(
      `${ITEM_SELECT}
         JOIN watchlists w ON w.id = wi.watchlist_id
        WHERE wi.id = $1 AND w.user_id = $2`,
      [itemId, userId],
    );
    const item = row ? toItem(row) : null;
    if (updated && item) return { ok: true, value: item };
    return { ok: false, current: item };
  });
}

export async function reorderItems(
  userId: string,
  watchlistId: string,
  orderedItemIds: readonly string[],
): Promise<boolean> {
  if (orderedItemIds.length === 0) return true;
  const n = await runReorder(userId, watchlistId, orderedItemIds);
  return n > 0;
}

async function runReorder(
  userId: string,
  watchlistId: string,
  ids: readonly string[],
): Promise<number> {
  return withTransaction(async (tx: Tx) =>
    tx.execute(
      `UPDATE watchlist_items wi
          SET position = ord.pos::int, version = wi.version + 1, updated_at = now()
         FROM unnest($3::uuid[]) WITH ORDINALITY AS ord(id, pos),
              watchlists w
        WHERE wi.id = ord.id
          AND wi.watchlist_id = $2
          AND w.id = $2
          AND w.user_id = $1`,
      [userId, watchlistId, [...ids]],
    ),
  );
}
