/**
 * The market clock.
 *
 * Detectors used to work out the session phase from `Date.now()` themselves.
 * That was wrong for two reasons, and the second one is the interesting one:
 *
 *   1. It duplicated calendar logic across ten call sites.
 *   2. It made every detector silently *incorrect* whenever the system was not
 *      running against a live NSE session — which is most of the time, and all
 *      of the time during a demo. Volume comparisons need to know how far
 *      through a session we are; a gap needs to know the market has opened; a
 *      silent feed is only newsworthy while trading is happening. Under the
 *      simulator none of those were true of the wall clock even though they
 *      were all true of the market the user was looking at.
 *
 * So the session became an explicit input. A `MarketClock` answers two
 * questions — where are we in the session, and how much variance sits between
 * two instants — and the rest of the engine asks rather than assumes. The real
 * clock and the simulated clock are the same interface, which is why the
 * significance engine needs no knowledge of which one it is running under.
 */

import type { Millis, SessionDate, SessionPhase } from "../types";
import {
  OVERNIGHT_VARIANCE_SHARE,
  SESSION_MS,
  type Calendar,
  phaseAt,
  sessionDateOf,
  sessionProgress,
  varianceHorizon,
} from "./calendar";

export interface MarketSession {
  phase: SessionPhase;
  sessionDate: SessionDate;
  /** 0 at the open, 1 at the close. */
  progress: number;
  /** True when this session is generated rather than observed. */
  synthetic: boolean;
}

export interface MarketClock {
  session(now: Millis): MarketSession;
  /**
   * Fraction of one trading day's variance between two instants. 1.0 means
   * "as much can have happened as in a normal full day".
   */
  horizon(from: Millis, to: Millis): number;
}

export function realClock(cal: Calendar): MarketClock {
  return {
    session(now) {
      return {
        phase: phaseAt(cal, now),
        sessionDate: sessionDateOf(now),
        progress: sessionProgress(cal, now),
        synthetic: false,
      };
    },
    horizon(from, to) {
      return varianceHorizon(cal, from, to);
    },
  };
}

export interface SyntheticReading {
  sessionDate: SessionDate;
  /** Minutes into the synthetic session, 0..375. */
  minute: number;
  synthetic: boolean;
}

/**
 * A clock driven by a generated session.
 *
 * Elapsed wall time counts as session time (the synthetic market never closes
 * for the night in the middle of a demo), and each completed session boundary
 * still contributes its overnight variance so a gap is scored the same way it
 * would be against a real feed.
 */
export function syntheticClock(
  cal: Calendar,
  read: (now: Millis) => SyntheticReading,
  speedup = 1,
): MarketClock {
  const real = realClock(cal);
  return {
    session(now) {
      const r = read(now);
      if (!r.synthetic) return real.session(now);
      const progress = Math.max(0, Math.min(1, r.minute / 375));
      return {
        // A generated session is always "open" as far as the engine is
        // concerned; it only stops at the boundary between sessions.
        phase: progress >= 1 ? "CLOSING_AUCTION" : "OPEN",
        sessionDate: r.sessionDate,
        progress,
        synthetic: true,
      };
    },
    horizon(from, to) {
      if (!(to > from)) return 0;
      const readingFrom = read(from);
      const readingTo = read(to);
      if (!readingFrom.synthetic && !readingTo.synthetic) return real.horizon(from, to);

      const sessionsElapsed = countSessionBoundaries(readingFrom, readingTo);
      const elapsedSessionMs = (to - from) * speedup;
      const intraday = (elapsedSessionMs / SESSION_MS) * (1 - OVERNIGHT_VARIANCE_SHARE);
      return intraday + sessionsElapsed * OVERNIGHT_VARIANCE_SHARE;
    },
  };
}

function countSessionBoundaries(a: SyntheticReading, b: SyntheticReading): number {
  if (a.sessionDate === b.sessionDate) return 0;
  // Dates are ISO strings on the same generated calendar; a day-count is a
  // good enough proxy for "how many opens did we pass through".
  const days = Math.round((Date.parse(b.sessionDate) - Date.parse(a.sessionDate)) / 86_400_000);
  return Math.max(0, Math.round(days * (5 / 7)));
}

/**
 * Variance horizon implied by "since the previous close", using only how far
 * through the session we are.
 *
 * This is the correct denominator for today's change, and it is exact under
 * both clocks — which the previous approach of differencing two timestamps was
 * not, because a quote's `asOf` and the previous close are not on the same
 * timeline when the session is generated.
 */
export function horizonSincePreviousClose(progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  return OVERNIGHT_VARIANCE_SHARE + p * (1 - OVERNIGHT_VARIANCE_SHARE);
}
