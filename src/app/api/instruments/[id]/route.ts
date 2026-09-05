/**
 * Instrument detail: everything behind the "why is this at the top?" drawer.
 */

import { ApiError, handler, json, requireUser, uuid } from "@/server/http";
import { getDailyBars, getInstrumentsByIds } from "@/server/repo/instruments";
import { getQuotes, getTape } from "@/server/repo/quotes";
import { recentEventsForInstrument } from "@/server/repo/events";
import { classifyFreshness, describeAge } from "@/core/market/freshness";
import { currentSession } from "@/server/services/market-clock";
import { typicalDailyVolume } from "@/core/significance/baseline";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const id = uuid.parse((await ctx.params).id);

  const [instruments, quotes, bars, events, tape] = await Promise.all([
    getInstrumentsByIds([id]),
    getQuotes([id]),
    getDailyBars(id, 120),
    recentEventsForInstrument(id, 30),
    getTape([id], 180),
  ]);

  const instrument = instruments[0];
  if (!instrument) throw ApiError.notFound("instrument");
  const quote = quotes[0] ?? null;
  const now = Date.now();
  const { freshness, ageMs } = classifyFreshness(
    currentSession(now).phase,
    quote?.asOf ?? null,
    now,
  );

  return json({
    instrument: {
      id: instrument.id,
      symbol: instrument.symbol,
      name: instrument.name,
      sector: instrument.sector,
      exchange: instrument.exchange,
      currency: instrument.currency,
    },
    baseline: {
      dailySigmaPct: Number((instrument.baseline.dailySigma * 100).toFixed(3)),
      sampleSize: instrument.baseline.sampleSize,
      typicalDailyVolume: typicalDailyVolume(instrument.baseline),
      high52w: instrument.baseline.high52w,
      low52w: instrument.baseline.low52w,
      high20d: instrument.baseline.high20d,
      low20d: instrument.baseline.low20d,
      computedAt: instrument.baselineComputedAt,
    },
    quote: quote && {
      price: quote.price,
      previousClose: quote.previousClose,
      open: quote.open,
      dayHigh: quote.dayHigh,
      dayLow: quote.dayLow,
      volume: quote.volume,
      halted: quote.halted,
      asOf: quote.asOf,
      provider: quote.provider,
      freshness,
      ageLabel: describeAge(ageMs),
    },
    bars,
    tape: tape[id] ?? [],
    events: events.map((e) => ({
      id: e.id,
      seq: e.seq,
      kind: e.kind,
      direction: e.direction,
      magnitude: Number(e.magnitude.toFixed(2)),
      headline: e.headline,
      evidence: e.evidence,
      firstSeenAt: e.firstSeenAt,
      lastUpdatedAt: e.lastUpdatedAt,
    })),
  });
});
