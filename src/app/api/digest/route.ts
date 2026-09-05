/** The main read: what changed since this reader last looked. */

import { handler, json, requireUser } from "@/server/http";
import { buildDigestForUser } from "@/server/services/digest";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  const digest = await buildDigestForUser(user);
  return json(digest, {
    headers: {
      // Never cached anywhere: the whole value of this response is that it is
      // computed relative to this reader, at this instant.
      "cache-control": "no-store, must-revalidate",
    },
  });
});
