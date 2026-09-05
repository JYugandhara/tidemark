import { describe, expect, it } from "vitest";
import type { Signal, UserWeighting } from "@/core/types";
import { bandFor, noveltyMultiplier, quietReason, scoreSignals } from "@/core/significance/score";

const sig = (over: Partial<Signal> = {}): Signal => ({
  kind: "PRICE_MOVE",
  direction: "up",
  magnitude: 2.5,
  dedupBucket: "move:up:2",
  headline: "moved a lot",
  evidence: {},
  ...over,
});

const weighting = (over: Partial<UserWeighting> = {}): UserWeighting => ({
  conviction: "tracking",
  attentionThreshold: 45,
  mutedUntil: null,
  ...over,
});

const fresh = { timesShown: 0, hoursSinceLastCheck: 1 };

describe("scoring", () => {
  it("scores nothing as nothing, with an explanation", () => {
    const s = scoreSignals([], weighting(), fresh);
    expect(s.score).toBe(0);
    expect(s.band).toBe("noise");
    expect(s.headline).toBe("Nothing meaningful changed");
  });

  it("is monotone in signal strength", () => {
    const weak = scoreSignals([sig({ magnitude: 1.1 })], weighting(), fresh).score;
    const strong = scoreSignals([sig({ magnitude: 5 })], weighting(), fresh).score;
    expect(strong).toBeGreaterThan(weak);
  });

  it("saturates: one absurd print cannot reach the ceiling alone", () => {
    const absurd = scoreSignals([sig({ magnitude: 40 })], weighting(), fresh).score;
    expect(absurd).toBeLessThan(75);
    const combined = scoreSignals(
      [
        sig({ magnitude: 3 }),
        sig({ kind: "VOLUME_SURGE", magnitude: 3, dedupBucket: "vol:2" }),
        sig({ kind: "RANGE_BREAK", magnitude: 2, dedupBucket: "range:52w" }),
      ],
      weighting(),
      fresh,
    ).score;
    expect(combined).toBeGreaterThan(absurd);
  });

  it("keeps only the strongest signal of each kind", () => {
    const s = scoreSignals(
      [sig({ magnitude: 1.2 }), sig({ magnitude: 4, headline: "the real story" })],
      weighting(),
      fresh,
    );
    expect(s.contributions.filter((c) => c.kind === "PRICE_MOVE")).toHaveLength(1);
    expect(s.headline).toBe("the real story");
  });

  it("attributes every point to a named signal", () => {
    const s = scoreSignals(
      [sig({ magnitude: 3 }), sig({ kind: "GAP", magnitude: 2.5, dedupBucket: "gap:1" })],
      weighting(),
      fresh,
    );
    const total = s.contributions.reduce((a, c) => a + c.points, 0);
    expect(total).toBeCloseTo(s.score, 0);
    expect(s.contributions[0].points).toBeGreaterThanOrEqual(s.contributions[1].points);
  });

  it("honours conviction the user set, and nothing it inferred", () => {
    const core = scoreSignals([sig()], weighting({ conviction: "core" }), fresh).score;
    const bg = scoreSignals([sig()], weighting({ conviction: "background" }), fresh).score;
    expect(core).toBeGreaterThan(bg);
  });

  it("suppresses repeats and never returns below zero or above 100", () => {
    const first = scoreSignals([sig({ magnitude: 6 })], weighting(), fresh).score;
    const second = scoreSignals([sig({ magnitude: 6 })], weighting(), {
      timesShown: 1,
      hoursSinceLastCheck: 1,
    }).score;
    const fourth = scoreSignals([sig({ magnitude: 6 })], weighting(), {
      timesShown: 4,
      hoursSinceLastCheck: 1,
    }).score;
    // Glancing away and back must not bury a story that is still true.
    expect(second).toBe(first);
    expect(fourth).toBeLessThan(first);
    expect(fourth).toBeGreaterThanOrEqual(0);

    const huge = scoreSignals(
      Array.from({ length: 9 }, (_, i) =>
        sig({ kind: "HALT", magnitude: 20, dedupBucket: `h${i}` }),
      ),
      weighting({ conviction: "core" }),
      fresh,
    ).score;
    expect(huge).toBeLessThanOrEqual(100);
  });

  it("returns zero while an instrument is muted", () => {
    const s = scoreSignals(
      [sig({ magnitude: 9 })],
      weighting({ mutedUntil: 2_000 }),
      fresh,
      1_000,
    );
    expect(s.score).toBe(0);
    expect(s.headline).toBe("Muted by you");
  });

  it("stops muting once the mute expires", () => {
    const s = scoreSignals([sig({ magnitude: 9 })], weighting({ mutedUntil: 500 }), fresh, 1_000);
    expect(s.score).toBeGreaterThan(0);
  });

  it("maps scores onto stable bands", () => {
    expect(bandFor(95)).toBe("critical");
    expect(bandFor(65)).toBe("high");
    expect(bandFor(45)).toBe("moderate");
    expect(bandFor(25)).toBe("low");
    expect(bandFor(5)).toBe("noise");
  });

  it("novelty rises with absence and falls with repetition, within bounds", () => {
    expect(noveltyMultiplier({ timesShown: 0, hoursSinceLastCheck: 0 })).toBe(1);
    expect(noveltyMultiplier({ timesShown: 0, hoursSinceLastCheck: 6 })).toBeGreaterThan(1);
    expect(noveltyMultiplier({ timesShown: 0, hoursSinceLastCheck: 1000 })).toBeLessThanOrEqual(
      1.25,
    );
    expect(noveltyMultiplier({ timesShown: 10, hoursSinceLastCheck: 5 })).toBeLessThan(0.3);
  });
});

describe("the quiet state explains itself", () => {
  it("says why nothing was raised", () => {
    expect(quietReason({ sigmaMultiple: 0.3, returnPct: 0.004, isStale: false, isMuted: false })).toBe(
      "0.3σ — well inside its normal day",
    );
    expect(quietReason({ sigmaMultiple: 1.4, returnPct: 0.02, isStale: false, isMuted: false })).toBe(
      "1.4σ — noticeable, but not unusual for this name",
    );
    expect(quietReason({ sigmaMultiple: 0, returnPct: 0, isStale: false, isMuted: false })).toBe(
      "Barely moved",
    );
    expect(quietReason({ sigmaMultiple: 1, returnPct: 1, isStale: true, isMuted: false })).toBe(
      "No fresh data — not scored",
    );
    expect(quietReason({ sigmaMultiple: 1, returnPct: 1, isStale: false, isMuted: true })).toBe(
      "Muted by you",
    );
  });
});
