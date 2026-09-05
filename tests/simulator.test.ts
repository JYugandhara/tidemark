import { describe, expect, it } from "vitest";
import { makeCalendar, openInstant, closeInstant, isTradingDay } from "@/core/market/calendar";
import {
  MarketSimulator,
  gaussian,
  hash32,
  mostRecentCompletedSession,
  mulberry32,
  nextTradingDate,
  simClock,
} from "@/server/providers/sim-engine";
import { buildBaseline, typicalDailyVolume } from "@/core/significance/baseline";

const cal = makeCalendar();

function makeSim(seed = 42) {
  return new MarketSimulator({
    seed,
    volatilityScale: 1,
    calendar: cal,
    anchorDate: "2025-01-01",
    horizonDays: 420,
  });
}

describe("pseudo-random primitives", () => {
  it("hashes deterministically and spreads inputs", () => {
    expect(hash32("RELIANCE")).toBe(hash32("RELIANCE"));
    expect(hash32("RELIANCE")).not.toBe(hash32("RELIANCF"));
  });

  it("produces a uniform-ish stream in [0,1)", () => {
    const rng = mulberry32(7);
    let sum = 0;
    for (let i = 0; i < 20_000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 20_000).toBeGreaterThan(0.47);
    expect(sum / 20_000).toBeLessThan(0.53);
  });

  it("produces approximately standard normals", () => {
    const rng = mulberry32(11);
    const xs = Array.from({ length: 20_000 }, () => gaussian(rng));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeGreaterThan(0.95);
    expect(sd).toBeLessThan(1.05);
  });
});

describe("market simulator", () => {
  it("is reproducible across instances with the same seed", () => {
    const a = makeSim().bars("RELIANCE", "2025-06-02", 30);
    const b = makeSim().bars("RELIANCE", "2025-06-02", 30);
    expect(a).toEqual(b);
    const c = makeSim(43).bars("RELIANCE", "2025-06-02", 30);
    expect(c).not.toEqual(a);
  });

  it("emits internally consistent bars on trading days only", () => {
    const bars = makeSim().bars("TCS", "2025-06-02", 60);
    expect(bars.length).toBe(60);
    for (const b of bars) {
      expect(isTradingDay(cal, b.date)).toBe(true);
      expect(b.high).toBeGreaterThanOrEqual(b.open);
      expect(b.high).toBeGreaterThanOrEqual(b.close);
      expect(b.low).toBeLessThanOrEqual(b.open);
      expect(b.low).toBeLessThanOrEqual(b.close);
      expect(b.close).toBeGreaterThan(0);
      expect(b.volume).toBeGreaterThan(0);
    }
    const dates = bars.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("gives a volatile name a wider realised sigma than a quiet one", () => {
    const sim = makeSim();
    const quiet = buildBaseline({
      instrumentId: "a",
      bars: sim.bars("HINDUNILVR", "2025-12-01", 200),
      now: 0,
    });
    const wild = buildBaseline({
      instrumentId: "b",
      bars: sim.bars("SUZLON", "2025-12-01", 200),
      now: 0,
    });
    expect(wild.dailySigma).toBeGreaterThan(quiet.dailySigma * 1.5);
    expect(typicalDailyVolume(quiet)).toBeGreaterThan(0);
  });

  it("pins the intraday path to the session open and close", () => {
    const sim = makeSim();
    const date = "2025-06-02";
    const [bar] = sim.bars("INFY", date, 1);
    const atOpen = sim.quoteAt("INFY", date, 0, 0)!;
    const atClose = sim.quoteAt("INFY", date, 375, 0)!;
    expect(atOpen.price).toBeCloseTo(bar.open, 1);
    expect(atClose.price).toBeCloseTo(bar.close, 1);
  });

  it("moves monotonically in time without teleporting", () => {
    const sim = makeSim();
    const date = "2025-06-02";
    let prev = sim.quoteAt("TATAMOTORS", date, 0, 0)!.price;
    for (let m = 1; m <= 375; m++) {
      const q = sim.quoteAt("TATAMOTORS", date, m, 0)!;
      const step = Math.abs(Math.log(q.price / prev));
      expect(step).toBeLessThan(0.05); // no single-minute 5% jump
      prev = q.price;
    }
  });

  it("keeps day high/low consistent with the path so far", () => {
    const sim = makeSim();
    const q = sim.quoteAt("SBIN", "2025-06-02", 200, 0)!;
    expect(q.dayHigh!).toBeGreaterThanOrEqual(q.price);
    expect(q.dayLow!).toBeLessThanOrEqual(q.price);
    expect(q.bid!).toBeLessThan(q.ask!);
    expect(q.upperCircuit!).toBeGreaterThan(q.previousClose);
    expect(q.lowerCircuit!).toBeLessThan(q.previousClose);
  });

  it("accumulates volume monotonically through the session", () => {
    const sim = makeSim();
    let prev = -1;
    for (let m = 0; m <= 375; m += 25) {
      const v = sim.quoteAt("ITC", "2025-06-02", m, 0)!.volume!;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("synthesises stable parameters for an unknown symbol", () => {
    const sim = makeSim();
    const a = sim.quoteAt("MADEUPCO", "2025-06-02", 100, 0);
    const b = makeSim().quoteAt("MADEUPCO", "2025-06-02", 100, 0);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });
});

describe("simulated session clock", () => {
  const FRI = "2026-09-04";

  it("is the identity while the real market is open", () => {
    const now = openInstant(FRI) + 60 * 60_000;
    const r = simClock(cal, now, { alwaysOpen: true, speedup: 1, realPhaseOpen: true, today: FRI });
    expect(r.synthetic).toBe(false);
    expect(r.sessionDate).toBe(FRI);
    expect(r.minute).toBeCloseTo(60, 6);
  });

  it("freezes at the last close when we are not pretending", () => {
    const now = closeInstant(FRI) + 3 * 60 * 60_000;
    const r = simClock(cal, now, { alwaysOpen: false, speedup: 1, realPhaseOpen: false, today: FRI });
    expect(r.minute).toBe(375);
    expect(r.sessionDate).toBe(FRI);
  });

  it("runs synthetic sessions forward once the real market shuts", () => {
    const base = closeInstant(FRI);
    const r1 = simClock(cal, base + 10 * 60_000, {
      alwaysOpen: true,
      speedup: 1,
      realPhaseOpen: false,
      today: FRI,
    });
    expect(r1.synthetic).toBe(true);
    expect(r1.minute).toBeCloseTo(10, 6);
    // The next session skips the weekend.
    expect(r1.sessionDate).toBe("2026-09-07");

    const r2 = simClock(cal, base + 400 * 60_000, {
      alwaysOpen: true,
      speedup: 1,
      realPhaseOpen: false,
      today: FRI,
    });
    expect(r2.sessionDate).toBe("2026-09-08");
    expect(r2.minute).toBeCloseTo(25, 6);
  });

  it("finds the most recent completed session and the next trading date", () => {
    expect(mostRecentCompletedSession(cal, closeInstant(FRI) + 1, FRI)).toBe(FRI);
    expect(mostRecentCompletedSession(cal, openInstant(FRI) + 1, FRI)).toBe("2026-09-03");
    expect(nextTradingDate(cal, FRI)).toBe("2026-09-07");
  });
});
