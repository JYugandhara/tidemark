import { z } from "zod";
import { ApiError, handler, json, parseBody, requireUser } from "@/server/http";
import { createAlert, listAlerts } from "@/server/repo/alerts";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  return json({ alerts: await listAlerts(user.id) });
});

const Body = z.object({
  instrumentId: z.string().uuid(),
  kind: z.enum(["above", "below"]),
  level: z.number().positive().finite(),
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = await parseBody(req, Body);
  const alert = await createAlert(user.id, body.instrumentId, body.kind, body.level);
  if (!alert) throw ApiError.notFound("instrument");
  return json({ alert }, { status: 201 });
});
