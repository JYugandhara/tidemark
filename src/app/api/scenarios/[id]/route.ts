import { ApiError, handler, json, requireUser, uuid } from "@/server/http";
import { query } from "@/server/db/client";
import { invalidateScenarioCache } from "@/server/providers/scenarios";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const id = uuid.parse((await ctx.params).id);
  const rows = await query<{ id: string }>("DELETE FROM scenarios WHERE id = $1 RETURNING id", [id]);
  if (rows.length === 0) throw ApiError.notFound("scenario");
  invalidateScenarioCache();
  return json({ deleted: true });
});
