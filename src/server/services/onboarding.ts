/**
 * First-run setup.
 *
 * A watchlist product with an empty watchlist cannot demonstrate anything, so
 * a new workspace gets a small, deliberately varied starter list: a couple of
 * mega-caps that barely move, a couple of names that move a lot, and one that
 * is habitually violent. That spread is what makes the σ-normalisation visible
 * within thirty seconds of opening the app — the same 2% move sits in the
 * "quiet" pile for one of them and at the top of the attention list for another.
 */

import { query } from "../db/client";

const STARTER = [
  { symbol: "RELIANCE", conviction: "core" },
  { symbol: "HDFCBANK", conviction: "core" },
  { symbol: "TCS", conviction: "tracking" },
  { symbol: "HINDUNILVR", conviction: "background" },
  { symbol: "TATAMOTORS", conviction: "tracking" },
  { symbol: "ZOMATO", conviction: "tracking" },
  { symbol: "SUZLON", conviction: "background" },
  { symbol: "IDEA", conviction: "background" },
] as const;

export async function seedStarterWatchlist(userId: string): Promise<void> {
  const rows = await query<{ id: string }>(
    `INSERT INTO watchlists (user_id, name, position) VALUES ($1, 'My watchlist', 0)
     RETURNING id`,
    [userId],
  );
  const watchlistId = rows[0]?.id;
  if (!watchlistId) return;

  await query(
    `INSERT INTO watchlist_items (watchlist_id, instrument_id, conviction, position)
     SELECT $1, i.id, t.conviction, t.pos::int
       FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(symbol, conviction, pos)
       JOIN instruments i ON i.symbol = t.symbol
     ON CONFLICT (watchlist_id, instrument_id) DO NOTHING`,
    [watchlistId, STARTER.map((s) => s.symbol), STARTER.map((s) => s.conviction)],
  );

  // Bring these into the polling rotation immediately rather than waiting for
  // the next retier pass, so the first digest is not empty.
  await query(
    `INSERT INTO ingest_state (instrument_id, tier, next_poll_at)
     SELECT instrument_id, 'hot', now() FROM watchlist_items WHERE watchlist_id = $1
     ON CONFLICT (instrument_id) DO UPDATE SET tier = 'hot', next_poll_at = now()`,
    [watchlistId],
  );
}
