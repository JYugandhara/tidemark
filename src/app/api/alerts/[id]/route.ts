import { ApiError, handler, json, requireUser, uuid } from "@/server/http";
import { deleteAlert } from "@/server/repo/alerts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const id = uuid.parse((await ctx.params).id);
  const ok = await deleteAlert(user.id, id);
  if (!ok) throw ApiError.notFound("alert");
  return json({ deleted: true });
});
