import { describe, expect, it } from "vitest";
import {
  closeInstant,
  istInstant,
  makeCalendar,
  openInstant,
  OVERNIGHT_VARIANCE_SHARE,
} from "@/core/market/calendar";
import {
  horizonSincePreviousClose,
  realClock,
  syntheticClock,
  type SyntheticReading,
} from "@/core/market/clock";
import { classifyFreshness, describeAge, isActionable } from "@/core/market/freshness";

const cal = makeCalendar();
const FRI = "2026-09-04";
const SAT = "2026-09-05";

describe("the real clock", () => {
  const clock = realClock(cal);

  it("reports the live session", () => {
    const s = clock.session(istInstant(FRI, 11 * 60));
    expect(s.phase).toBe("OPEN");
    expect(s.sessionDate).toBe(FRI);
    expect(s.synthetic).toBe(false);
    expect(s.progress).toBeGreaterThan(0.2);
    expect(s.progress).toBeLessThan(0.6);
  });

  it("reports a closed market on a Saturday", () => {
    expect(clock.session(istInstant(SAT, 12 * 60)).phase).toBe("CLOSED");
  });

  it("charges no variance to a weekend", () => {
    expect(clock.horizon(istInstant(SAT, 9 * 60), istInstant(SAT, 17 * 60))).toBe(0);
  });
});

describe("the synthetic clock", () => {
  // A generated market that opened at an arbitrary instant and keeps running.
  const T0 = closeInstant(FRI) + 60_000;
  const read = (now: number): SyntheticReading => {
    const minutes = (now - closeInstant(FRI)) / 60_000;
    const sessions = Math.floor(minutes / 375);
    return {
      sessionDate: sessions === 0 ? "2026-09-07" : "2026-09-08",
      minute: minutes - sessions * 375,
      synthetic: true,
    };
  };
  const clock = syntheticClock(cal, read);

  it("presents a generated session as open, and says it is generated", () => {
    const s = clock.session(T0);
    expect(s.phase).toBe("OPEN");
    expect(s.synthetic).toBe(true);
    expect(s.sessionDate).toBe("2026-09-07");
  });

  it("counts elapsed wall time as session time", () => {
    // Half a session of generated time is half a session of variance,
    // minus the overnight share which is charged at boundaries.
    const h = clock.horizon(T0, T0 + 187.5 * 60_000);
    expect(h).toBeCloseTo(0.5 * (1 - OVERNIGHT_VARIANCE_SHARE), 3);
  });

  it("charges an overnight allocation when a generated session rolls over", () => {
    const h = clock.horizon(T0, T0 + 400 * 60_000);
    expect(h).toBeGreaterThan(OVERNIGHT_VARIANCE_SHARE);
  });

  it("returns zero for a reversed interval", () => {
    expect(clock.horizon(T0 + 1000, T0)).toBe(0);
  });
});

describe("horizon since the previous close", () => {
  it("is the overnight share at the open and a full day at the close", () => {
    expect(horizonSincePreviousClose(0)).toBeCloseTo(OVERNIGHT_VARIANCE_SHARE, 10);
    expect(horizonSincePreviousClose(1)).toBeCloseTo(1, 10);
    expect(horizonSincePreviousClose(0.5)).toBeCloseTo(
      OVERNIGHT_VARIANCE_SHARE + 0.5 * (1 - OVERNIGHT_VARIANCE_SHARE),
      10,
    );
  });

  it("is clamped for nonsense input", () => {
    expect(horizonSincePreviousClose(-4)).toBeCloseTo(OVERNIGHT_VARIANCE_SHARE, 10);
    expect(horizonSincePreviousClose(9)).toBeCloseTo(1, 10);
  });
});

describe("freshness is judged against the session the reader is looking at", () => {
  const now = openInstant(FRI) + 60 * 60_000;

  it("grades an open market strictly", () => {
    expect(classifyFreshness("OPEN", now - 5_000, now).freshness).toBe("LIVE");
    expect(classifyFreshness("OPEN", now - 60_000, now).freshness).toBe("DELAYED");
    expect(classifyFreshness("OPEN", now - 300_000, now).freshness).toBe("STALE");
    expect(classifyFreshness("OPEN", now - 3_600_000, now).freshness).toBe("UNAVAILABLE");
  });

  it("treats an hours-old price as settled when the market is shut", () => {
    expect(classifyFreshness("CLOSED", now - 6 * 3_600_000, now).freshness).toBe("AT_CLOSE");
    expect(classifyFreshness("CLOSED", now - 9 * 86_400_000, now).freshness).toBe("STALE");
  });

  it("does not call a generated open session 'at close'", () => {
    // The bug this guards: under the simulator the wall clock says the market
    // is shut, so every live price was being labelled as a settled close.
    expect(classifyFreshness("OPEN", now - 2_000, now).freshness).toBe("LIVE");
    expect(classifyFreshness("CLOSING_AUCTION", now - 2_000, now).freshness).toBe("LIVE");
  });

  it("reports nothing at all as unavailable", () => {
    const r = classifyFreshness("OPEN", null, now);
    expect(r.freshness).toBe("UNAVAILABLE");
    expect(isActionable(r.freshness)).toBe(false);
    expect(describeAge(r.ageMs)).toBe("no data");
  });

  it("describes ages in units a person reads", () => {
    expect(describeAge(2_000)).toBe("just now");
    expect(describeAge(30_000)).toBe("30s ago");
    expect(describeAge(180_000)).toBe("3m ago");
    expect(describeAge(3 * 3_600_000)).toBe("3h ago");
    expect(describeAge(3 * 86_400_000)).toBe("3d ago");
  });
});
