import { describe, expect, it } from "vitest";
import {
  OVERNIGHT_VARIANCE_SHARE,
  addDays,
  closeInstant,
  istClock,
  istInstant,
  isTradingDay,
  makeCalendar,
  openInstant,
  phaseAt,
  previousTradingDate,
  sessionDateOf,
  sessionProgress,
  varianceHorizon,
} from "@/core/market/calendar";

const cal = makeCalendar(["2026-09-07"]); // an injected exchange holiday (Monday)

// 2026-09-04 is a Friday.
const FRI = "2026-09-04";
const SAT = "2026-09-05";
const MON_HOLIDAY = "2026-09-07";
const TUE = "2026-09-08";

describe("exchange calendar", () => {
  it("maps instants to IST session dates across the UTC day boundary", () => {
    // 20:00 UTC on 3 Sep is 01:30 IST on 4 Sep.
    expect(sessionDateOf(Date.parse("2026-09-03T20:00:00Z"))).toBe("2026-09-04");
    expect(sessionDateOf(Date.parse("2026-09-04T18:29:00Z"))).toBe("2026-09-04");
    expect(sessionDateOf(Date.parse("2026-09-04T18:31:00Z"))).toBe("2026-09-05");
  });

  it("renders IST wall clock", () => {
    expect(istClock(istInstant(FRI, 9 * 60 + 15))).toBe("09:15");
    expect(istClock(istInstant(FRI, 15 * 60 + 30))).toBe("15:30");
  });

  it("knows weekends, injected holidays and fixed national holidays", () => {
    expect(isTradingDay(cal, FRI)).toBe(true);
    expect(isTradingDay(cal, SAT)).toBe(false);
    expect(isTradingDay(cal, MON_HOLIDAY)).toBe(false);
    expect(isTradingDay(cal, "2027-01-26")).toBe(false); // Republic Day
    expect(isTradingDay(cal, "2026-12-25")).toBe(false); // Christmas
  });

  it("classifies session phases", () => {
    expect(phaseAt(cal, istInstant(FRI, 8 * 60))).toBe("CLOSED");
    expect(phaseAt(cal, istInstant(FRI, 9 * 60 + 5))).toBe("PRE_OPEN");
    expect(phaseAt(cal, istInstant(FRI, 9 * 60 + 15))).toBe("OPEN");
    expect(phaseAt(cal, istInstant(FRI, 12 * 60))).toBe("OPEN");
    expect(phaseAt(cal, istInstant(FRI, 15 * 60 + 29))).toBe("OPEN");
    expect(phaseAt(cal, istInstant(FRI, 15 * 60 + 35))).toBe("CLOSING_AUCTION");
    expect(phaseAt(cal, istInstant(FRI, 15 * 60 + 50))).toBe("POST_CLOSE");
    expect(phaseAt(cal, istInstant(FRI, 20 * 60))).toBe("CLOSED");
    expect(phaseAt(cal, istInstant(SAT, 12 * 60))).toBe("CLOSED");
  });

  it("walks back to the previous trading date over a holiday weekend", () => {
    expect(previousTradingDate(cal, TUE)).toBe(FRI);
    expect(addDays(FRI, 4)).toBe(TUE);
  });

  it("measures elapsed variance in market time, not wall time", () => {
    const openF = openInstant(FRI);
    const halfSession = varianceHorizon(cal, openF, openF + 187.5 * 60_000);
    expect(halfSession).toBeCloseTo(0.5 * (1 - OVERNIGHT_VARIANCE_SHARE), 6);

    // A whole weekend of wall time that contains no session at all.
    const satNoon = istInstant(SAT, 12 * 60);
    const sunNoon = istInstant("2026-09-06", 12 * 60);
    expect(varianceHorizon(cal, satNoon, sunNoon)).toBe(0);

    // Friday close to Tuesday open crosses exactly one *trading* close boundary
    // that we charge overnight variance for, because Sat/Sun/Mon are shut.
    const acrossHoliday = varianceHorizon(cal, closeInstant(FRI), openInstant(TUE));
    expect(acrossHoliday).toBeCloseTo(OVERNIGHT_VARIANCE_SHARE, 6);
  });

  it("gives a full day of variance for a complete session plus its overnight", () => {
    const h = varianceHorizon(cal, openInstant(FRI), openInstant(TUE));
    expect(h).toBeCloseTo(1, 6);
  });

  it("returns zero for a reversed or empty interval", () => {
    expect(varianceHorizon(cal, 1000, 1000)).toBe(0);
    expect(varianceHorizon(cal, 2000, 1000)).toBe(0);
  });

  it("does not spin on an interval measured in months", () => {
    const t0 = openInstant("2026-01-02");
    const t1 = closeInstant("2026-09-04");
    const started = Date.now();
    const h = varianceHorizon(cal, t0, t1);
    expect(Date.now() - started).toBeLessThan(200);
    expect(h).toBeGreaterThan(100);
  });

  it("reports session progress", () => {
    expect(sessionProgress(cal, openInstant(FRI) - 1)).toBe(0);
    expect(sessionProgress(cal, closeInstant(FRI) + 1)).toBe(1);
    expect(sessionProgress(cal, openInstant(FRI) + 187.5 * 60_000)).toBeCloseTo(0.5, 6);
    expect(sessionProgress(cal, istInstant(SAT, 12 * 60))).toBe(1);
  });
});
