import { z } from "zod";
import { handler, json, parseQuery, requireUser } from "@/server/http";
import { searchInstruments } from "@/server/repo/instruments";

export const dynamic = "force-dynamic";

const Query = z.object({
  q: z.string().trim().max(60).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export const GET = handler(async (req: Request) => {
  await requireUser();
  const { q, limit } = parseQuery(req, Query);
  const results = await searchInstruments(q, limit);
  return json({
    results: results.map((i) => ({
      id: i.id,
      symbol: i.symbol,
      name: i.name,
      sector: i.sector,
      exchange: i.exchange,
      dailySigmaPct: Number((i.baseline.dailySigma * 100).toFixed(2)),
    })),
  });
});
