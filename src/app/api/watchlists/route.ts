import { z } from "zod";
import { handler, json, parseBody, requireUser } from "@/server/http";
import { createWatchlist, listWatchlists } from "@/server/repo/watchlists";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  return json({ watchlists: await listWatchlists(user.id) });
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const { name } = await parseBody(req, z.object({ name: z.string().trim().min(1).max(60) }));
  return json({ watchlist: await createWatchlist(user.id, name) }, { status: 201 });
});
