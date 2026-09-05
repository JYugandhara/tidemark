import { z } from "zod";
import { handler, json, parseBody, requireUser } from "@/server/http";
import { getUser, setAttentionThreshold } from "@/server/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  /** How much noise the reader is willing to tolerate, 0-100. */
  attentionThreshold: z.number().int().min(0).max(100),
});

export const PATCH = handler(async (req: Request) => {
  const user = await requireUser();
  const { attentionThreshold } = await parseBody(req, Body);
  await setAttentionThreshold(user.id, attentionThreshold);
  return json({ user: await getUser(user.id) });
});
