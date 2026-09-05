import { z } from "zod";
import { ApiError, handler, json, parseBody, requireUser, uuid } from "@/server/http";
import { removeItem, updateItem } from "@/server/repo/watchlists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z.object({
  conviction: z.enum(["core", "tracking", "background"]).optional(),
  /** Epoch millis, or null to unmute. Absent means "leave it alone". */
  mutedUntil: z.number().int().nonnegative().nullable().optional(),
  note: z.string().max(280).nullable().optional(),
  position: z.number().int().min(0).optional(),
  version: z.number().int().positive(),
});

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const id = uuid.parse((await ctx.params).id);
  const { version, ...patch } = await parseBody(req, Patch);

  const res = await updateItem(user.id, id, patch, version);
  if (res.ok) return json({ item: res.value });
  if (!res.current) throw ApiError.notFound("watchlist item");
  throw ApiError.conflict(
    "This item was changed on another device. Here is the current version.",
    res.current,
  );
});

export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const id = uuid.parse((await ctx.params).id);
  const ok = await removeItem(user.id, id);
  if (!ok) throw ApiError.notFound("watchlist item");
  return json({ deleted: true });
});
