import { z } from "zod";
import { ApiError, handler, json, parseBody, requireUser, uuid } from "@/server/http";
import { reorderItems } from "@/server/repo/watchlists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const watchlistId = uuid.parse((await ctx.params).id);
  const { itemIds } = await parseBody(
    req,
    z.object({ itemIds: z.array(z.string().uuid()).min(1).max(500) }),
  );
  const ok = await reorderItems(user.id, watchlistId, itemIds);
  if (!ok) throw ApiError.notFound("watchlist");
  return json({ reordered: itemIds.length });
});
