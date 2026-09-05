import { describe, expect, it } from "vitest";
import type { InstrumentBaseline, Quote } from "@/core/types";
import { istInstant, makeCalendar, openInstant } from "@/core/market/calendar";
import { realClock } from "@/core/market/clock";
import { defaultVolumeProfile, isPlausiblePrice } from "@/core/significance/baseline";
import {
  type DetectionContext,
  detectCircuitAndHalt,
  detectDataStale,
  detectGap,
  detectLevelCross,
  detectPriceMove,
  detectRangeBreak,
  detectSignals,
  detectTrendReversal,
  detectVolumeSurge,
  expectedVolumeShare,
} from "@/core/significance/detect";

const cal = makeCalendar();
const clock = realClock(cal);
const DAY = "2026-09-04"; // Friday
const NOON = istInstant(DAY, 12 * 60);

const sessionAt = (ms: number) => clock.session(ms);

const baseline = (over: Partial<InstrumentBaseline> = {}): InstrumentBaseline => ({
  instrumentId: "i1",
  dailySigma: 0.02,
  sampleSize: 250,
  logVolumeMean: Math.log(1_000_000),
  logVolumeSigma: 0.4,
  volumeProfile: defaultVolumeProfile(),
  high52w: 1200,
  low52w: 800,
  high20d: 1050,
  low20d: 950,
  medianAbsReturn: 0.012,
  computedAt: NOON,
  ...over,
});

const quote = (over: Partial<Quote> = {}): Quote => ({
  symbol: "TESTCO",
  price: 1000,
  previousClose: 1000,
  open: 1000,
  dayHigh: 1005,
  dayLow: 995,
  volume: 400_000,
  asOf: NOON,
  ...over,
});

const ctx = (over: Partial<DetectionContext> = {}): DetectionContext => ({
  now: over.now ?? NOON,
  session: over.session ?? sessionAt(over.now ?? NOON),
  clock,
  symbol: "TESTCO",
  displayName: "Test Company",
  baseline: baseline(),
  quote: quote(),
  freshness: "LIVE",
  reference: {
    price: 1000,
    asOf: openInstant(DAY),
    isPreviousClose: false,
    directionAtReference: "flat",
  },
  alerts: [],
  corporateActions: [],
  typicalDailyVolume: 1_000_000,
  ...over,
});

describe("price-move detection is volatility-normalised", () => {
  it("ignores a move that is ordinary for a volatile name", () => {
    const c = ctx({
      baseline: baseline({ dailySigma: 0.05 }),
      quote: quote({ price: 1010 }),
    });
    expect(detectPriceMove(c)).toHaveLength(0);
  });

  it("flags the same move for a quiet name", () => {
    const c = ctx({
      baseline: baseline({ dailySigma: 0.004 }),
      quote: quote({ price: 1010 }),
    });
    const [s] = detectPriceMove(c);
    expect(s).toBeDefined();
    expect(s.kind).toBe("PRICE_MOVE");
    expect(s.direction).toBe("up");
    expect(s.magnitude).toBeGreaterThan(2);
  });

  it("escalates the dedup bucket as the move grows, so one story is one event", () => {
    const mk = (price: number) =>
      detectPriceMove(ctx({ baseline: baseline({ dailySigma: 0.004 }), quote: quote({ price }) }));
    const a = mk(1008)[0];
    const b = mk(1009)[0];
    const c = mk(1030)[0];
    expect(a.dedupBucket).toBe(b.dedupBucket); // same story, updated
    expect(c.dedupBucket).not.toBe(a.dedupBucket); // genuine escalation
  });

  it("separates up and down moves into different events", () => {
    const up = detectPriceMove(
      ctx({ baseline: baseline({ dailySigma: 0.004 }), quote: quote({ price: 1015 }) }),
    )[0];
    const down = detectPriceMove(
      ctx({ baseline: baseline({ dailySigma: 0.004 }), quote: quote({ price: 985 }) }),
    )[0];
    expect(up.dedupBucket).not.toBe(down.dedupBucket);
  });

  it("charges more sigma to a move that took longer of the session", () => {
    const quick = detectPriceMove(
      ctx({
        baseline: baseline({ dailySigma: 0.004 }),
        quote: quote({ price: 1010 }),
        reference: {
          price: 1000,
          asOf: NOON - 60_000,
          isPreviousClose: false,
          directionAtReference: "flat",
        },
      }),
    )[0];
    const slow = detectPriceMove(
      ctx({ baseline: baseline({ dailySigma: 0.004 }), quote: quote({ price: 1010 }) }),
    )[0];
    expect(quick.magnitude).toBeGreaterThan(slow.magnitude);
  });

  it("returns nothing for a non-positive price", () => {
    expect(detectPriceMove(ctx({ quote: quote({ price: 0 }) }))).toHaveLength(0);
  });
});

describe("gap detection", () => {
  it("uses the overnight variance share, not the full-day sigma", () => {
    const [s] = detectGap(ctx({ quote: quote({ open: 1030, previousClose: 1000 }) }));
    expect(s.kind).toBe("GAP");
    expect(s.evidence.gapPct).toBeCloseTo(3, 3);
    expect(s.magnitude).toBeGreaterThan(2);
  });

  it("stays quiet before the open", () => {
    const c = ctx({ now: istInstant(DAY, 9 * 60 + 5), quote: quote({ open: 1030 }) });
    expect(detectGap(c)).toHaveLength(0);
  });
});

describe("volume detection compares against the shape of the day", () => {
  it("does not flag normal early-session volume", () => {
    const early = istInstant(DAY, 9 * 60 + 45);
    const share = expectedVolumeShare(defaultVolumeProfile(), 0.08);
    const c = ctx({ now: early, quote: quote({ volume: Math.round(1_000_000 * share) }) });
    expect(detectVolumeSurge(c)).toHaveLength(0);
  });

  it("flags a genuine surge", () => {
    const early = istInstant(DAY, 9 * 60 + 45);
    const share = expectedVolumeShare(defaultVolumeProfile(), 0.08);
    const c = ctx({ now: early, quote: quote({ volume: Math.round(1_000_000 * share * 6) }) });
    const [s] = detectVolumeSurge(c);
    expect(s.kind).toBe("VOLUME_SURGE");
    expect(Number(s.evidence.ratio)).toBeGreaterThan(5);
  });

  it("expected share is monotone and bounded", () => {
    const p = defaultVolumeProfile();
    expect(expectedVolumeShare(p, 0)).toBeCloseTo(0, 6);
    expect(expectedVolumeShare(p, 1)).toBeCloseTo(1, 6);
    expect(expectedVolumeShare(p, 0.5)).toBeGreaterThan(expectedVolumeShare(p, 0.25));
    expect(expectedVolumeShare(p, -3)).toBe(0);
    expect(expectedVolumeShare([], 0.4)).toBeCloseTo(0.4, 6);
  });
});

describe("range breaks", () => {
  it("suppresses the 20-day break when the 52-week break already says more", () => {
    const out = detectRangeBreak(ctx({ quote: quote({ price: 1250 }) }));
    expect(out).toHaveLength(1);
    expect(out[0].evidence.window).toBe("52w");
  });

  it("reports a 20-day break on its own", () => {
    const out = detectRangeBreak(ctx({ quote: quote({ price: 1100 }) }));
    expect(out).toHaveLength(1);
    expect(out[0].evidence.window).toBe("20d");
  });

  it("tolerates a missing baseline extreme", () => {
    const out = detectRangeBreak(
      ctx({ baseline: baseline({ high52w: null, high20d: null }), quote: quote({ price: 5000 }) }),
    );
    expect(out.every((s) => s.direction === "down")).toBe(true);
  });
});

describe("reversal, alerts, circuits and staleness", () => {
  it("flags a direction flip since the last visit", () => {
    const c = ctx({
      baseline: baseline({ dailySigma: 0.004 }),
      quote: quote({ price: 985, previousClose: 1000 }),
      reference: {
        price: 1010,
        asOf: openInstant(DAY),
        isPreviousClose: false,
        directionAtReference: "up",
      },
    });
    const [s] = detectTrendReversal(c);
    expect(s.kind).toBe("TREND_REVERSAL");
    expect(s.evidence.directionAtLastCheck).toBe("up");
    expect(s.evidence.directionNow).toBe("down");
  });

  it("does not invent a reversal when the reference is the previous close", () => {
    const c = ctx({
      quote: quote({ price: 985 }),
      reference: {
        price: 1000,
        asOf: openInstant(DAY),
        isPreviousClose: true,
        directionAtReference: "flat",
      },
    });
    expect(detectTrendReversal(c)).toHaveLength(0);
  });

  it("fires a level alert on the crossing only", () => {
    const rule = { id: "r1", kind: "above" as const, level: 1005, armed: true };
    const crossing = detectLevelCross(
      ctx({ alerts: [rule], quote: quote({ price: 1010 }) }),
    );
    expect(crossing).toHaveLength(1);

    const alreadyAbove = detectLevelCross(
      ctx({
        alerts: [rule],
        quote: quote({ price: 1010 }),
        reference: {
          price: 1009,
          asOf: openInstant(DAY),
          isPreviousClose: false,
          directionAtReference: "up",
        },
      }),
    );
    expect(alreadyAbove).toHaveLength(0);

    const disarmed = detectLevelCross(
      ctx({ alerts: [{ ...rule, armed: false }], quote: quote({ price: 1010 }) }),
    );
    expect(disarmed).toHaveLength(0);
  });

  it("detects halts and circuit bands", () => {
    const halted = detectCircuitAndHalt(ctx({ quote: quote({ halted: true }) }));
    expect(halted[0].kind).toBe("HALT");

    const circuit = detectCircuitAndHalt(
      ctx({ quote: quote({ price: 1100, upperCircuit: 1100 }) }),
    );
    expect(circuit[0].kind).toBe("CIRCUIT");
    expect(circuit[0].evidence.side).toBe("upper");
  });

  it("treats a silent feed during an open market as an event", () => {
    const c = ctx({ freshness: "STALE", quote: quote({ asOf: NOON - 20 * 60_000 }) });
    const [s] = detectDataStale(c);
    expect(s.kind).toBe("DATA_STALE");
    expect(s.evidence.ageMinutes).toBe(20);
  });

  it("does not complain about a silent feed when the market is shut", () => {
    const c = ctx({
      now: istInstant("2026-09-05", 12 * 60),
      freshness: "STALE",
      quote: quote({ asOf: NOON }),
    });
    expect(detectDataStale(c)).toHaveLength(0);
  });
});

describe("detector isolation and price sanity", () => {
  it("collects signals from every detector without one failure killing the rest", () => {
    const { signals, failures } = detectSignals(
      ctx({
        baseline: baseline({ dailySigma: 0.004 }),
        quote: quote({ price: 1250, open: 1040, volume: 5_000_000, halted: true }),
      }),
    );
    expect(failures).toHaveLength(0);
    const kinds = new Set(signals.map((s) => s.kind));
    expect(kinds.has("PRICE_MOVE")).toBe(true);
    expect(kinds.has("RANGE_BREAK")).toBe(true);
    expect(kinds.has("HALT")).toBe(true);
  });

  it("rejects an implausible print but accepts a violent real move", () => {
    const b = baseline();
    expect(isPlausiblePrice(10, 1000, b)).toBe(false); // decimal error
    expect(isPlausiblePrice(0, 1000, b)).toBe(false);
    expect(isPlausiblePrice(1200, 1000, b)).toBe(true); // 20% — a real upper circuit
    expect(isPlausiblePrice(1000, Number.NaN, b)).toBe(false);
  });
});
