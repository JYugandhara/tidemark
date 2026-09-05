/**
 * Exchange calendar and market-time arithmetic for NSE/BSE (Asia/Kolkata).
 *
 * Two things live here that most watchlists get wrong:
 *
 *  1. IST has no daylight saving, so the local offset is a constant +05:30.
 *     That lets us do exact calendar arithmetic without a timezone library
 *     and without the class of bug where a DST transition shifts the open.
 *
 *  2. "How long since the user last looked" must be measured in *market*
 *     time, not wall time. Three hours across a live session is a far larger
 *     opportunity for change than three hours on a Sunday, and the overnight
 *     gap carries real variance even though zero session minutes elapse.
 *     `varianceHorizon` is the single function that encodes this.
 */

import type { Millis, SessionDate, SessionPhase } from "../types";

export const IST_OFFSET_MINUTES = 330; // UTC+05:30, fixed year-round
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Minutes from IST midnight. */
const PRE_OPEN_START = 9 * 60; // 09:00
const REGULAR_OPEN = 9 * 60 + 15; // 09:15
const REGULAR_CLOSE = 15 * 60 + 30; // 15:30
const CLOSING_AUCTION_END = 15 * 60 + 40; // 15:40
const POST_CLOSE_END = 16 * 60; // 16:00

export const SESSION_MINUTES = REGULAR_CLOSE - REGULAR_OPEN; // 375
export const SESSION_MS = SESSION_MINUTES * MS_PER_MINUTE;

/**
 * Share of a trading day's total variance that accrues while the market is
 * shut. Equity index studies put the overnight component in the 20-35% range;
 * we use 25% and expose it so it can be recalibrated per venue from data.
 *
 * The consequence users feel: a gap open is scored as a genuine event rather
 * than being divided by "zero elapsed session time" and blowing up to
 * infinity, and a move that took the whole session is not judged against the
 * same yardstick as one that took ten minutes.
 */
export const OVERNIGHT_VARIANCE_SHARE = 0.25;

export interface Calendar {
  /** Exchange holidays as "YYYY-MM-DD" in exchange-local time. */
  holidays: ReadonlySet<SessionDate>;
}

/** Fixed-date national holidays. Movable ones are supplied by config/data. */
const FIXED_HOLIDAY_MONTH_DAYS = ["01-26", "08-15", "10-02", "12-25"] as const;

export function makeCalendar(extraHolidays: Iterable<SessionDate> = []): Calendar {
  return { holidays: new Set(extraHolidays) };
}

/** Split an instant into IST calendar parts without any timezone dependency. */
function istParts(ms: Millis): {
  date: SessionDate;
  minuteOfDay: number;
  weekday: number; // 0 = Sunday
  dayIndex: number; // whole IST days since epoch, for cheap day arithmetic
} {
  const shifted = ms + IST_OFFSET_MINUTES * MS_PER_MINUTE;
  const dayIndex = Math.floor(shifted / MS_PER_DAY);
  const minuteOfDay = Math.floor((shifted - dayIndex * MS_PER_DAY) / MS_PER_MINUTE);
  const d = new Date(dayIndex * MS_PER_DAY);
  const date = d.toISOString().slice(0, 10);
  const weekday = d.getUTCDay();
  return { date, minuteOfDay, weekday, dayIndex };
}

export function sessionDateOf(ms: Millis): SessionDate {
  return istParts(ms).date;
}

/** Instant of a given IST wall-clock minute on a given session date. */
export function istInstant(date: SessionDate, minuteOfDay: number): Millis {
  const dayMs = Date.parse(`${date}T00:00:00Z`);
  return dayMs + minuteOfDay * MS_PER_MINUTE - IST_OFFSET_MINUTES * MS_PER_MINUTE;
}

export function openInstant(date: SessionDate): Millis {
  return istInstant(date, REGULAR_OPEN);
}
export function closeInstant(date: SessionDate): Millis {
  return istInstant(date, REGULAR_CLOSE);
}

function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

export function isTradingDay(cal: Calendar, date: SessionDate): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (isWeekend(weekday)) return false;
  if (cal.holidays.has(date)) return false;
  return !FIXED_HOLIDAY_MONTH_DAYS.includes(
    date.slice(5) as (typeof FIXED_HOLIDAY_MONTH_DAYS)[number],
  );
}

export function phaseAt(cal: Calendar, ms: Millis): SessionPhase {
  const { date, minuteOfDay } = istParts(ms);
  if (!isTradingDay(cal, date)) return "CLOSED";
  if (minuteOfDay >= PRE_OPEN_START && minuteOfDay < REGULAR_OPEN) return "PRE_OPEN";
  if (minuteOfDay >= REGULAR_OPEN && minuteOfDay < REGULAR_CLOSE) return "OPEN";
  if (minuteOfDay >= REGULAR_CLOSE && minuteOfDay < CLOSING_AUCTION_END)
    return "CLOSING_AUCTION";
  if (minuteOfDay >= CLOSING_AUCTION_END && minuteOfDay < POST_CLOSE_END)
    return "POST_CLOSE";
  return "CLOSED";
}

export function isMarketOpen(cal: Calendar, ms: Millis): boolean {
  return phaseAt(cal, ms) === "OPEN";
}

/** Nearest trading day at or before `date`. */
export function previousTradingDate(cal: Calendar, date: SessionDate): SessionDate {
  let d = addDays(date, -1);
  for (let i = 0; i < 30 && !isTradingDay(cal, d); i++) d = addDays(d, -1);
  return d;
}

export function addDays(date: SessionDate, days: number): SessionDate {
  const t = Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** Session milliseconds that elapsed on one specific date between two instants. */
function sessionOverlapMs(
  cal: Calendar,
  date: SessionDate,
  from: Millis,
  to: Millis,
): number {
  if (!isTradingDay(cal, date)) return 0;
  const start = openInstant(date);
  const end = closeInstant(date);
  const lo = Math.max(from, start);
  const hi = Math.min(to, end);
  return Math.max(0, hi - lo);
}

/**
 * How much of a "normal trading day" of variance sits between two instants.
 *
 * Returns a dimensionless multiplier: 1.0 means "one full day's worth of
 * variance". Multiply a daily sigma by its square root to get the sigma
 * appropriate for the interval.
 *
 * Composed of two parts:
 *   - session time actually elapsed, scaled by (1 - overnight share)
 *   - one overnight allocation for each close the interval crossed
 */
export function varianceHorizon(cal: Calendar, from: Millis, to: Millis): number {
  if (!(to > from)) return 0;
  // Bound the walk so a watermark from six months ago cannot spin the loop.
  const maxDays = 400;
  let sessionMs = 0;
  let overnightCount = 0;

  const startDate = sessionDateOf(from);
  const endDate = sessionDateOf(to);
  let date = startDate;

  for (let i = 0; i <= maxDays; i++) {
    sessionMs += sessionOverlapMs(cal, date, from, to);
    if (date === endDate) break;
    // Crossing this day's close into the next day is one overnight gap,
    // but only if the day we are leaving was itself a trading day.
    if (isTradingDay(cal, date) && to > closeInstant(date)) overnightCount += 1;
    date = addDays(date, 1);
    if (i === maxDays) {
      // Interval longer than the walk: fall back to a calendar approximation.
      const extraDays = (to - istInstant(date, 0)) / MS_PER_DAY;
      overnightCount += Math.max(0, Math.floor(extraDays * (5 / 7)));
      sessionMs += Math.max(0, extraDays * (5 / 7)) * SESSION_MS;
      break;
    }
  }

  const intraday = (sessionMs / SESSION_MS) * (1 - OVERNIGHT_VARIANCE_SHARE);
  const overnight = overnightCount * OVERNIGHT_VARIANCE_SHARE;
  return intraday + overnight;
}

/** Fraction of the current session completed, 0 before the open, 1 after close. */
export function sessionProgress(cal: Calendar, ms: Millis): number {
  const date = sessionDateOf(ms);
  if (!isTradingDay(cal, date)) return 1;
  const start = openInstant(date);
  const end = closeInstant(date);
  if (ms <= start) return 0;
  if (ms >= end) return 1;
  return (ms - start) / (end - start);
}

/** Human label for the phase, used in the UI header and in event copy. */
export function phaseLabel(phase: SessionPhase): string {
  switch (phase) {
    case "PRE_OPEN":
      return "Pre-open";
    case "OPEN":
      return "Market open";
    case "CLOSING_AUCTION":
      return "Closing auction";
    case "POST_CLOSE":
      return "Post-close";
    default:
      return "Market closed";
  }
}

/** Formats an instant as IST wall-clock time, e.g. "14:32". */
export function istClock(ms: Millis): string {
  const { minuteOfDay } = istParts(ms);
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
