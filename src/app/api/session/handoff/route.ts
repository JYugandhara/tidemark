/** Issue a short-lived code that moves this workspace onto another device. */

import { handler, json, requireUser } from "@/server/http";
import { createHandoffCode } from "@/server/session";

export const dynamic = "force-dynamic";

export const POST = handler(async () => {
  const user = await requireUser();
  const { code, expiresAt } = await createHandoffCode(user.id);
  return json({ code, expiresAt, validForSeconds: Math.round((expiresAt - Date.now()) / 1000) });
});
