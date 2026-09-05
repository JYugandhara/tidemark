import { describe, expect, it } from "vitest";
import { buildDigest, type DigestItemInput, type StoredEvent } from "@/core/diff/digest";
import { istInstant, makeCalendar, openInstant } from "@/core/market/calendar";
import { realClock } from "@/core/market/clock";
import { defaultVolumeProfile } from "@/core/significance/baseline";
import type { InstrumentBaseline, Quote } from "@/core/types";

const cal = makeCalendar();
const clock = realClock(cal);
const DAY = "2026-09-04";
const NOON = istInstant(DAY, 12 * 60);
const session = clock.session(NOON);

const opts = {
  now: NOON,
  clock,
  session,
  attentionThreshold: 45,
  hoursSinceLastCheck: 2,
};

function baseline(dailySigma: number): InstrumentBaseline {
  return {
    instrumentId: "x",
    dailySigma,
    sampleSize: 250,
    logVolumeMean: Math.log(1_000_000),
    logVolumeSigma: 0.4,
    volumeProfile: defaultVolumeProfile(),
    high52w: 10_000,
    low52w: 1,
    high20d: 9_000,
    low20d: 2,
    medianAbsReturn: dailySigma,
    computedAt: NOON,
  };
}

function item(over: {
  symbol: string;
  dailySigma: number;
  price: number;
  previousClose?: number;
  conviction?: "core" | "tracking" | "background";
  reference?: DigestItemInput["reference"];
  unseenEvents?: StoredEvent[];
  mutedUntil?: number | null;
}): DigestItemInput {
  const previousClose = over.previousClose ?? 1000;
  const quote: Quote = {
    symbol: over.symbol,
    price: over.price,
    previousClose,
    open: previousClose,
    dayHigh: Math.max(over.price, previousClose),
    dayLow: Math.min(over.price, previousClose),
    volume: 400_000,
    asOf: NOON,
  };
  return {
    instrumentId: over.symbol,
    symbol: over.symbol,
    name: `${over.symbol} Ltd`,
    quote,
    freshness: "LIVE",
    baseline: baseline(over.dailySigma),
    typicalDailyVolume: 1_000_000,
    weighting: {
      conviction: over.conviction ?? "tracking",
      attentionThreshold: 45,
      mutedUntil: over.mutedUntil ?? null,
    },
    reference: over.reference ?? null,
    alerts: [],
    corporateActions: [],
    unseenEvents: over.unseenEvents ?? [],
    timesShown: {},
  };
}

describe("the digest ranks by unusualness, not by size of move", () => {
  it("puts a 2% move in a calm name above a 3% move in a violent one", () => {
    const digest = buildDigest(
      [
        item({ symbol: "CALM", dailySigma: 0.011, price: 980 }), // −2.0%, ~1.8σ
        item({ symbol: "WILD", dailySigma: 0.04, price: 1030 }), // +3.0%, ~0.75σ
      ],
      opts,
    );

    expect(digest.attention.map((a) => a.symbol)).toContain("CALM");
    expect(digest.quiet.map((q) => q.symbol)).toContain("WILD");

    const wild = digest.quiet.find((q) => q.symbol === "WILD")!;
    expect(wild.quietReason).toMatch(/σ/);
    // The larger percentage move is the one we stay silent about, and the page
    // is able to say exactly why.
    expect(Math.abs(wild.changeTodayPct!)).toBeGreaterThan(
      Math.abs(digest.attention[0].changeTodayPct!),
    );
  });

  it("accounts for every watched instrument exactly once", () => {
    const digest = buildDigest(
      [
        item({ symbol: "A", dailySigma: 0.01, price: 970 }),
        item({ symbol: "B", dailySigma: 0.03, price: 1002 }),
        item({ symbol: "C", dailySigma: 0.02, price: 1000 }),
      ],
      opts,
    );
    expect(digest.attention.length + digest.quiet.length).toBe(3);
    expect(digest.summary.watched).toBe(3);
    const symbols = [...digest.attention, ...digest.quiet].map((e) => e.symbol).sort();
    expect(symbols).toEqual(["A", "B", "C"]);
  });

  it("sorts the attention list by score, descending", () => {
    const digest = buildDigest(
      [
        item({ symbol: "SMALL", dailySigma: 0.01, price: 985 }),
        item({ symbol: "BIG", dailySigma: 0.01, price: 940 }),
      ],
      opts,
    );
    const scores = digest.attention.map((a) => a.significance.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(digest.attention[0].symbol).toBe("BIG");
  });

  it("measures against the reader's own watermark when there is one", () => {
    const withRef = buildDigest(
      [
        item({
          symbol: "REF",
          dailySigma: 0.01,
          price: 1000,
          reference: {
            price: 960,
            asOf: openInstant(DAY),
            isPreviousClose: false,
            directionAtReference: "down",
          },
        }),
      ],
      opts,
    );
    const entry = [...withRef.attention, ...withRef.quiet][0];
    expect(entry.referenceLabel).toBe("since you last checked");
    expect(entry.changeSinceReferencePct).toBeCloseTo(40 / 960, 6);
    // Flat on the day, but a big move since the reader last looked: exactly the
    // case a conventional watchlist cannot express.
    expect(entry.changeTodayPct).toBeCloseTo(0, 6);
    expect(entry.quiet).toBe(false);
  });

  it("falls back to the previous close for a first visit", () => {
    const digest = buildDigest([item({ symbol: "NEW", dailySigma: 0.01, price: 975 })], opts);
    const entry = [...digest.attention, ...digest.quiet][0];
    expect(entry.referenceLabel).toBe("since yesterday's close");
  });

  it("merges worker-produced events with reader-relative ones", () => {
    const event: StoredEvent = {
      id: "e1",
      seq: 42,
      kind: "RANGE_BREAK",
      direction: "up",
      magnitude: 2,
      dedupBucket: "range:52w:up:2026-09-04",
      headline: "NEW broke its 52-week high",
      evidence: { window: "52w" },
      firstSeenAt: NOON - 60_000,
      lastUpdatedAt: NOON - 30_000,
    };
    const digest = buildDigest(
      [item({ symbol: "NEW", dailySigma: 0.01, price: 1020, unseenEvents: [event] })],
      opts,
    );
    const entry = digest.attention[0];
    expect(entry.eventSeqs).toEqual([42]);
    expect(digest.highWaterSeq).toBe(42);
    expect(entry.significance.contributions.map((c) => c.kind)).toContain("RANGE_BREAK");
    expect(entry.significance.contributions.map((c) => c.kind)).toContain("PRICE_MOVE");
  });

  it("never drops an instrument whose feed has gone dark", () => {
    const dark: DigestItemInput = {
      ...item({ symbol: "DARK", dailySigma: 0.02, price: 1000 }),
      quote: null,
      freshness: "UNAVAILABLE",
    };
    const digest = buildDigest([dark], opts);
    const entry = [...digest.attention, ...digest.quiet][0];
    expect(entry.symbol).toBe("DARK");
    expect(entry.price).toBeNull();
    expect(entry.quietReason).toBe("No fresh data — not scored");
    expect(digest.summary.unavailable).toBe(1);
  });

  it("a quiet row explains the strongest signal, not just the price", () => {
    const event: StoredEvent = {
      id: "e2",
      seq: 7,
      kind: "VOLUME_SURGE",
      direction: "up",
      magnitude: 6.8,
      dedupBucket: "vol:2026-09-04:3",
      headline: "VOL trading on 8.0× its usual volume for this time of day",
      evidence: { ratio: 8 },
      firstSeenAt: NOON - 60_000,
      lastUpdatedAt: NOON - 10_000,
    };
    const digest = buildDigest(
      // Barely moved on price, but the volume story is real and lands under the
      // line: the reader has to be able to see that it was considered.
      [item({ symbol: "VOL", dailySigma: 0.03, price: 1001, unseenEvents: [event] })],
      opts,
    );
    const entry = digest.quiet[0];
    expect(entry).toBeDefined();
    expect(entry.quietReason).toContain("8.0×");
    expect(entry.quietReason).toContain("under your line");
    expect(entry.quietReason!.startsWith("VOL")).toBe(false);
  });

  it("falls back to the sigma sentence when nothing at all fired", () => {
    const digest = buildDigest([item({ symbol: "FLAT", dailySigma: 0.03, price: 1001 })], opts);
    expect(digest.quiet[0].quietReason).toMatch(/σ|Barely moved/);
  });

  it("respects a mute without pretending nothing happened", () => {
    const digest = buildDigest(
      [item({ symbol: "MUTED", dailySigma: 0.005, price: 900, mutedUntil: NOON + 60_000 })],
      opts,
    );
    const entry = digest.quiet[0];
    expect(entry.significance.score).toBe(0);
    expect(entry.quietReason).toBe("Muted by you");
  });

  it("moves the boundary when the reader moves the dial", () => {
    const items = [
      item({ symbol: "A", dailySigma: 0.02, price: 972 }),
      item({ symbol: "B", dailySigma: 0.02, price: 995 }),
    ];
    const strict = buildDigest(items, { ...opts, attentionThreshold: 95 });
    const loose = buildDigest(items, { ...opts, attentionThreshold: 5 });
    expect(loose.attention.length).toBeGreaterThanOrEqual(strict.attention.length);
    expect(loose.attention.length + loose.quiet.length).toBe(
      strict.attention.length + strict.quiet.length,
    );
  });
});
