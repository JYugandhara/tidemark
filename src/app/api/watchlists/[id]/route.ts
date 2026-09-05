import { z } from "zod";
import { ApiError, handler, json, parseBody, requireUser, uuid } from "@/server/http";
import { deleteWatchlist, renameWatchlist } from "@/server/repo/watchlists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z.object({
  name: z.string().trim().min(1).max(60),
  /** The version the caller believed it was editing. */
  version: z.number().int().positive(),
});

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const id = uuid.parse((await ctx.params).id);
  const body = await parseBody(req, Patch);

  const res = await renameWatchlist(user.id, id, body.name, body.version);
  if (res.ok) return json({ watchlist: res.value });
  if (!res.current) throw ApiError.notFound("watchlist");
  // Hand back what the server actually holds so the client can merge rather
  // than reload the world.
  throw ApiError.conflict(
    "This list was changed somewhere else. Here is the current version.",
    res.current,
  );
});

export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const id = uuid.parse((await ctx.params).id);
  const ok = await deleteWatchlist(user.id, id);
  if (!ok) throw ApiError.notFound("watchlist");
  return json({ deleted: true });
});
