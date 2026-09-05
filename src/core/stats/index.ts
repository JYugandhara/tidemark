/**
 * Small, dependency-free statistics used by the significance engine.
 *
 * Every function here is total: it is defined for empty inputs, constant
 * inputs, and inputs containing zeros or negatives, because market data
 * contains all of those and a NaN escaping into a score would silently
 * mis-rank a user's whole watchlist.
 */

/** Guard against divide-by-zero on a name that has not moved in weeks. */
export const MIN_SIGMA = 0.0015; // 0.15% per day
export const MAX_SIGMA = 0.35; // 35% per day; beyond this the input is junk

export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

export function isFinitePositive(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than two points. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Log return, defined only for two positive prices. */
export function logReturn(from: number, to: number): number {
  if (!isFinitePositive(from) || !isFinitePositive(to)) return 0;
  return Math.log(to / from);
}

/** Simple return as a fraction. */
export function pctChange(from: number, to: number): number {
  if (!isFinitePositive(from) || !Number.isFinite(to)) return 0;
  return (to - from) / from;
}

/**
 * RiskMetrics-style EWMA volatility of log returns.
 *
 * Chosen over a plain rolling stdev because volatility clusters: a name that
 * was calm for six months and violent for the last four days should be judged
 * against the last four days. lambda = 0.94 is the standard daily decay.
 */
export function ewmaVolatility(
  returns: readonly number[],
  lambda = 0.94,
): number {
  const usable = returns.filter((r) => Number.isFinite(r));
  if (usable.length === 0) return MIN_SIGMA;
  if (usable.length === 1) return clamp(Math.abs(usable[0]), MIN_SIGMA, MAX_SIGMA);

  // Seed with the sample variance of the oldest third so the recursion starts
  // from something better than the first observation alone.
  const seedLen = Math.max(2, Math.floor(usable.length / 3));
  const seed = usable.slice(0, seedLen);
  let variance = stdev(seed) ** 2;
  if (!Number.isFinite(variance) || variance <= 0) variance = MIN_SIGMA ** 2;

  for (let i = seedLen; i < usable.length; i++) {
    variance = lambda * variance + (1 - lambda) * usable[i] ** 2;
  }
  return clamp(Math.sqrt(variance), MIN_SIGMA, MAX_SIGMA);
}

/**
 * Widen sigma when we have barely any history.
 *
 * With eight daily bars behind it, a sigma estimate is mostly noise, and a
 * naive z-score would declare everything a 4-sigma event on day one. The
 * inflation factor shrinks towards 1 as the sample grows.
 */
export function shrinkageAdjustedSigma(sigma: number, sampleSize: number): number {
  if (sampleSize >= 60) return sigma;
  const n = Math.max(1, sampleSize);
  const inflation = 1 + 2 / Math.sqrt(n);
  return clamp(sigma * inflation, MIN_SIGMA, MAX_SIGMA);
}

/**
 * Square-root-of-time scaling of a daily sigma to an arbitrary horizon.
 *
 * `tradingDays` is measured in *market* time, not wall time: a move that took
 * four hours of a live session is a much bigger deal than the same move spread
 * across a long weekend.
 */
export function scaleSigma(dailySigma: number, tradingDays: number): number {
  const t = Math.max(tradingDays, 1 / (6.25 * 60 * 60)); // floor at one second of session
  return dailySigma * Math.sqrt(t);
}

/** Standard score, guarded so a zero-sigma baseline cannot produce Infinity. */
export function zScore(value: number, sigma: number): number {
  const s = Math.max(sigma, MIN_SIGMA);
  const z = value / s;
  return Number.isFinite(z) ? clamp(z, -50, 50) : 0;
}

/**
 * Bounded strength transform.
 *
 * Maps |z| onto 0..1 with tanh so that a 12-sigma print (almost always a data
 * error) cannot outvote every other signal combined. `scale` sets where the
 * curve bends: at |z| == scale the strength is ~0.76.
 */
export function saturate(z: number, scale = 2.5): number {
  return Math.tanh(Math.abs(z) / Math.max(scale, 1e-6));
}

/** Welford's online mean/variance; used by the volume-profile builder. */
export class RunningStats {
  private n = 0;
  private m = 0;
  private m2 = 0;

  push(x: number): void {
    if (!Number.isFinite(x)) return;
    this.n += 1;
    const delta = x - this.m;
    this.m += delta / this.n;
    this.m2 += delta * (x - this.m);
  }

  get count(): number {
    return this.n;
  }
  get mean(): number {
    return this.n ? this.m : 0;
  }
  get variance(): number {
    return this.n > 1 ? this.m2 / (this.n - 1) : 0;
  }
  get stdev(): number {
    return Math.sqrt(this.variance);
  }
}
