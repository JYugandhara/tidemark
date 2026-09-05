import { z } from "zod";
import { ApiError, handler, json, parseBody, requireUser, uuid } from "@/server/http";
import { addItem } from "@/server/repo/watchlists";
import { getInstrumentBySymbol } from "@/server/repo/instruments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Accept either an instrument id or a plain ticker, because both are natural. */
const Body = z
  .object({
    instrumentId: z.string().uuid().optional(),
    symbol: z.string().trim().min(1).max(24).optional(),
    conviction: z.enum(["core", "tracking", "background"]).default("tracking"),
  })
  .refine((b) => b.instrumentId || b.symbol, {
    message: "Provide either instrumentId or symbol",
  });

export const POST = handler(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const watchlistId = uuid.parse((await ctx.params).id);
  const body = await parseBody(req, Body);

  let instrumentId = body.instrumentId;
  if (!instrumentId && body.symbol) {
    const inst = await getInstrumentBySymbol(body.symbol);
    if (!inst) throw ApiError.notFound(`instrument ${body.symbol.toUpperCase()}`);
    instrumentId = inst.id;
  }

  const item = await addItem(user.id, watchlistId, instrumentId!, body.conviction);
  if (!item) throw ApiError.notFound("watchlist");
  return json({ item }, { status: 201 });
});
