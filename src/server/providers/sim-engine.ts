/**
 * Deterministic market simulator.
 *
 * Given the same seed it produces the same year of history and the same
 * intraday path, every time, on every machine. That matters for three
 * different reasons:
 *
 *   - the product can be demonstrated outside NSE hours, which is when demos
 *     actually happen;
 *   - tests of the ingestion pipeline can assert on exact prices;
 *   - "reproduce the bug" is a seed, not a story about what the market did.
 *
 * The generator is a geometric random walk with an overnight gap, session
 * volatility split according to the same overnight/intraday variance share the
 * scoring engine assumes, occasional fat-tailed days, and a volume curve that
 * follows the U-shaped intraday profile. The intraday path is pinned to the
 * day's generated close with a Brownian bridge so minute data and daily bars
 * can never disagree.
 */

import type { DailyBar, Quote, SessionDate } from "@/core/types";
import {
  OVERNIGHT_VARIANCE_SHARE,
  type Calendar,
  addDays,
  isTradingDay,
  openInstant,
} from "@/core/market/calendar";
import { defaultVolumeProfile, VOLUME_BUCKETS } from "@/core/significance/baseline";
import { expectedVolumeShare } from "@/core/significance/detect";
import { UNIVERSE_BY_SYMBOL, type UniverseEntry } from "./universe";

const SESSION_MINUTES = 375;

/* -------------------------------------------------------------- rng bits -- */

export function hash32(input: string): number {
  // FNV-1a: fast, no dependencies, good enough avalanche for seeding.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, returning one standard normal per call. */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* --------------------------------------------------------------- engine -- */

export interface SimulatorOptions {
  seed: number;
  /** Global multiplier on every instrument's volatility. */
  volatilityScale: number;
  calendar: Calendar;
  /** First simulated trading date. */
  anchorDate: SessionDate;
  /** Trading days generated beyond the anchor. */
  horizonDays: number;
}

interface DayState {
  date: SessionDate;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

interface IntradayPath {
  /** Price at each minute 0..375 inclusive. */
  prices: Float64Array;
  /** Cumulative volume at each minute. */
  volumes: Float64Array;
  open: number;
  previousClose: number;
}

export class MarketSimulator {
  private readonly profile = defaultVolumeProfile(VOLUME_BUCKETS);
  private readonly dates: SessionDate[];
  private readonly dateIndex: Map<SessionDate, number>;
  private readonly history = new Map<string, DayState[]>();
  private readonly intraday = new Map<string, IntradayPath>();

  constructor(private readonly opts: SimulatorOptions) {
    this.dates = [];
    let d = opts.anchorDate;
    for (let i = 0; i < opts.horizonDays * 2 && this.dates.length < opts.horizonDays; i++) {
      if (isTradingDay(opts.calendar, d)) this.dates.push(d);
      d = addDays(d, 1);
    }
    this.dateIndex = new Map(this.dates.map((x, i) => [x, i]));
  }

  get tradingDates(): readonly SessionDate[] {
    return this.dates;
  }

  private entry(symbol: string): UniverseEntry {
    const e = UNIVERSE_BY_SYMBOL.get(symbol);
    if (e) return e;
    // Unknown symbol: synthesise stable parameters from its name so the
    // simulator still works for instruments added at runtime.
    const h = hash32(symbol);
    return {
      symbol,
      name: symbol,
      sector: "Unclassified",
      basePrice: 100 + (h % 4000) / 4,
      dailySigma: 0.010 + ((h >>> 7) % 300) / 10000,
      avgVolume: 200_000 + ((h >>> 13) % 5_000_000),
      annualDrift: (((h >>> 19) % 200) - 80) / 1000,
    };
  }

  /** Full generated daily history for a symbol, lazily built once. */
  private series(symbol: string): DayState[] {
    const cached = this.history.get(symbol);
    if (cached) return cached;

    const e = this.entry(symbol);
    const sigma = e.dailySigma * this.opts.volatilityScale;
    const out: DayState[] = [];
    let prevClose = e.basePrice;

    for (let i = 0; i < this.dates.length; i++) {
      const date = this.dates[i];
      const rng = mulberry32(hash32(`${this.opts.seed}|${symbol}|${date}`));

      // Roughly one day in fifty carries an outsized, news-like move.
      const shocked = rng() < 0.02;
      const dayScale = shocked ? 3.2 : 1;

      const gapSigma = sigma * Math.sqrt(OVERNIGHT_VARIANCE_SHARE) * dayScale;
      const gap = gaussian(rng) * gapSigma;
      const open = prevClose * Math.exp(gap);

      const drift = e.annualDrift / 252;
      const intradaySigma = sigma * Math.sqrt(1 - OVERNIGHT_VARIANCE_SHARE) * dayScale;
      const body = drift + gaussian(rng) * intradaySigma;
      const close = open * Math.exp(body);

      // Wick sizes are drawn separately so a small-bodied day can still have a
      // wide range, the way a reversal day does.
      const wick = Math.abs(gaussian(rng)) * intradaySigma * 0.7;
      const high = Math.max(open, close) * Math.exp(wick);
      const low = Math.min(open, close) * Math.exp(-Math.abs(gaussian(rng)) * intradaySigma * 0.7);

      const volNoise = Math.exp(gaussian(rng) * 0.32 - 0.32 ** 2 / 2);
      const volume = Math.round(e.avgVolume * volNoise * (shocked ? 2.6 : 1));

      out.push({ date, open, close, high, low, volume });
      prevClose = close;
    }

    this.history.set(symbol, out);
    return out;
  }

  private dayState(symbol: string, date: SessionDate): DayState | null {
    const idx = this.dateIndex.get(date);
    if (idx === undefined) return null;
    return this.series(symbol)[idx] ?? null;
  }

  previousClose(symbol: string, date: SessionDate): number {
    const idx = this.dateIndex.get(date);
    const series = this.series(symbol);
    if (idx === undefined || idx <= 0) return this.entry(symbol).basePrice;
    return series[idx - 1].close;
  }

  /** Daily bars up to and including `upTo`, most recent last. */
  bars(symbol: string, upTo: SessionDate, count: number): DailyBar[] {
    const series = this.series(symbol);
    let idx = this.dateIndex.get(upTo);
    if (idx === undefined) {
      // Nearest earlier generated date.
      idx = series.length - 1;
      for (let i = series.length - 1; i >= 0; i--) {
        if (series[i].date <= upTo) {
          idx = i;
          break;
        }
      }
    }
    const start = Math.max(0, idx - count + 1);
    return series.slice(start, idx + 1).map((d) => ({
      date: d.date,
      open: round2(d.open),
      high: round2(d.high),
      low: round2(d.low),
      close: round2(d.close),
      volume: d.volume,
    }));
  }

  /**
   * Minute-resolution path for one session, pinned to that session's generated
   * open and close by a Brownian bridge.
   */
  private path(symbol: string, date: SessionDate): IntradayPath | null {
    const key = `${symbol}|${date}`;
    const cached = this.intraday.get(key);
    if (cached) return cached;

    const day = this.dayState(symbol, date);
    if (!day) return null;
    const prevClose = this.previousClose(symbol, date);

    const rng = mulberry32(hash32(`${this.opts.seed}|intraday|${symbol}|${date}`));
    const e = this.entry(symbol);
    const sigma = e.dailySigma * this.opts.volatilityScale;
    const minuteSigma = (sigma * Math.sqrt(1 - OVERNIGHT_VARIANCE_SHARE)) / Math.sqrt(SESSION_MINUTES);

    const steps = new Float64Array(SESSION_MINUTES);
    let sum = 0;
    for (let i = 0; i < SESSION_MINUTES; i++) {
      steps[i] = gaussian(rng) * minuteSigma;
      sum += steps[i];
    }
    // Bridge: shift every increment so the path lands exactly on the close.
    const target = Math.log(day.close / day.open);
    const adjust = (target - sum) / SESSION_MINUTES;

    const prices = new Float64Array(SESSION_MINUTES + 1);
    const volumes = new Float64Array(SESSION_MINUTES + 1);
    prices[0] = day.open;
    let cum = 0;
    for (let i = 0; i < SESSION_MINUTES; i++) {
      cum += steps[i] + adjust;
      prices[i + 1] = day.open * Math.exp(cum);
      const share = expectedVolumeShare(this.profile, (i + 1) / SESSION_MINUTES);
      volumes[i + 1] = day.volume * share;
    }

    const out: IntradayPath = { prices, volumes, open: day.open, previousClose: prevClose };
    this.intraday.set(key, out);
    // Bound memory: the simulator only ever needs the recent few sessions live.
    if (this.intraday.size > 400) {
      const oldest = this.intraday.keys().next().value;
      if (oldest) this.intraday.delete(oldest);
    }
    return out;
  }

  /**
   * A quote for `symbol` at `minute` minutes into `date`'s session.
   * `minute` may be fractional; values are interpolated between minutes.
   */
  quoteAt(
    symbol: string,
    date: SessionDate,
    minute: number,
    asOf: number,
  ): Quote | null {
    const p = this.path(symbol, date);
    if (!p) return null;

    const m = Math.max(0, Math.min(SESSION_MINUTES, minute));
    const lo = Math.floor(m);
    const hi = Math.min(SESSION_MINUTES, lo + 1);
    const frac = m - lo;
    const price = p.prices[lo] + (p.prices[hi] - p.prices[lo]) * frac;
    const volume = p.volumes[lo] + (p.volumes[hi] - p.volumes[lo]) * frac;

    let dayHigh = p.prices[0];
    let dayLow = p.prices[0];
    for (let i = 0; i <= lo; i++) {
      if (p.prices[i] > dayHigh) dayHigh = p.prices[i];
      if (p.prices[i] < dayLow) dayLow = p.prices[i];
    }
    dayHigh = Math.max(dayHigh, price);
    dayLow = Math.min(dayLow, price);

    // A spread that widens with volatility and narrows with liquidity.
    const e = this.entry(symbol);
    const relSpread = Math.min(0.006, 0.0004 + 3_000_000 / (e.avgVolume + 3_000_000) * 0.0012);
    const half = (price * relSpread) / 2;

    return {
      symbol,
      price: round2(price),
      previousClose: round2(p.previousClose),
      open: round2(p.open),
      dayHigh: round2(dayHigh),
      dayLow: round2(dayLow),
      volume: Math.round(volume),
      asOf,
      bid: round2(price - half),
      ask: round2(price + half),
      halted: false,
      // Indian equities commonly carry 10 or 20 percent bands; we expose 20%
      // for the more volatile names so the circuit signal is reachable in a demo.
      upperCircuit: round2(p.previousClose * (e.dailySigma > 0.025 ? 1.2 : 1.1)),
      lowerCircuit: round2(p.previousClose * (e.dailySigma > 0.025 ? 0.8 : 0.9)),
    };
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/* --------------------------------------------------------- session clock -- */

export interface SimClockReading {
  sessionDate: SessionDate;
  /** Minutes into the session, 0..375. */
  minute: number;
  /** True when we are pretending, because the real market is shut. */
  synthetic: boolean;
}

/**
 * Map wall-clock time onto a simulated session.
 *
 * During real NSE hours this is the identity. Outside them — which is when a
 * hackathon judge will open the app — it runs back-to-back synthetic sessions
 * forward from the last real close, optionally sped up, so the product is
 * never a screen of frozen numbers. The UI always states which mode it is in;
 * pretending a simulated tick is a real one would be exactly the dishonesty
 * this product is supposed to be against.
 */
export function simClock(
  cal: Calendar,
  now: number,
  opts: { alwaysOpen: boolean; speedup: number; realPhaseOpen: boolean; today: SessionDate },
): SimClockReading {
  if (opts.realPhaseOpen) {
    const minute = (now - openInstant(opts.today)) / 60_000;
    return { sessionDate: opts.today, minute: clampMinute(minute), synthetic: false };
  }
  if (!opts.alwaysOpen) {
    // Market shut and we are not faking: freeze at the last close.
    const last = mostRecentCompletedSession(cal, now, opts.today);
    return { sessionDate: last, minute: SESSION_MINUTES, synthetic: false };
  }

  const anchorDate = mostRecentCompletedSession(cal, now, opts.today);
  const anchorInstant = openInstant(anchorDate) + SESSION_MINUTES * 60_000;
  const elapsedMinutes = Math.max(0, ((now - anchorInstant) / 60_000) * opts.speedup);
  const sessionsElapsed = Math.min(400, Math.floor(elapsedMinutes / SESSION_MINUTES));
  const minute = elapsedMinutes - sessionsElapsed * SESSION_MINUTES;

  let date = anchorDate;
  for (let i = 0; i < sessionsElapsed + 1; i++) date = nextTradingDate(cal, date);
  return { sessionDate: date, minute: clampMinute(minute), synthetic: true };
}

function clampMinute(m: number): number {
  if (!Number.isFinite(m)) return 0;
  return Math.max(0, Math.min(SESSION_MINUTES, m));
}

export function nextTradingDate(cal: Calendar, date: SessionDate): SessionDate {
  let d = addDays(date, 1);
  for (let i = 0; i < 30 && !isTradingDay(cal, d); i++) d = addDays(d, 1);
  return d;
}

/** The most recent session whose close is already in the past. */
export function mostRecentCompletedSession(
  cal: Calendar,
  now: number,
  today: SessionDate,
): SessionDate {
  let d = today;
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(cal, d) && now >= openInstant(d) + SESSION_MINUTES * 60_000) return d;
    d = addDays(d, -1);
  }
  return d;
}
