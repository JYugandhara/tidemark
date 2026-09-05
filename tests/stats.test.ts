import { describe, expect, it } from "vitest";
import {
  MAX_SIGMA,
  MIN_SIGMA,
  RunningStats,
  clamp,
  ewmaVolatility,
  logReturn,
  median,
  pctChange,
  saturate,
  scaleSigma,
  shrinkageAdjustedSigma,
  stdev,
  zScore,
} from "@/core/stats";

describe("stats primitives are total", () => {
  it("never returns NaN for degenerate input", () => {
    expect(stdev([])).toBe(0);
    expect(stdev([1])).toBe(0);
    expect(median([])).toBe(0);
    expect(pctChange(0, 10)).toBe(0);
    expect(logReturn(-5, 10)).toBe(0);
    expect(logReturn(10, 0)).toBe(0);
    expect(zScore(1, 0)).toBeGreaterThan(0);
    expect(Number.isFinite(zScore(1, 0))).toBe(true);
    expect(clamp(Number.NaN, 1, 5)).toBe(1);
  });

  it("clamps volatility into a sane band", () => {
    expect(ewmaVolatility([])).toBe(MIN_SIGMA);
    expect(ewmaVolatility([0, 0, 0, 0, 0, 0])).toBe(MIN_SIGMA);
    expect(ewmaVolatility(Array(50).fill(5))).toBe(MAX_SIGMA);
  });

  it("tracks a volatility regime change", () => {
    const calm = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.002 : -0.002));
    const calmSigma = ewmaVolatility(calm);
    const violent = [...calm, ...Array.from({ length: 10 }, (_, i) => (i % 2 ? 0.06 : -0.06))];
    expect(ewmaVolatility(violent)).toBeGreaterThan(calmSigma * 3);
  });

  it("widens sigma when the sample is thin", () => {
    expect(shrinkageAdjustedSigma(0.02, 4)).toBeGreaterThan(0.02);
    expect(shrinkageAdjustedSigma(0.02, 400)).toBe(0.02);
  });

  it("scales sigma by the square root of time", () => {
    const daily = 0.02;
    expect(scaleSigma(daily, 4)).toBeCloseTo(daily * 2, 10);
    expect(scaleSigma(daily, 0.25)).toBeCloseTo(daily / 2, 10);
  });

  it("saturates so an absurd z cannot dominate", () => {
    expect(saturate(2.5)).toBeCloseTo(Math.tanh(1), 6);
    expect(saturate(50)).toBeLessThanOrEqual(1);
    expect(saturate(-3)).toBe(saturate(3));
  });

  it("computes streaming mean and variance like the batch version", () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6];
    const rs = new RunningStats();
    xs.forEach((x) => rs.push(x));
    expect(rs.mean).toBeCloseTo(xs.reduce((a, b) => a + b) / xs.length, 10);
    expect(rs.stdev).toBeCloseTo(stdev(xs), 10);
    rs.push(Number.NaN);
    expect(rs.count).toBe(xs.length);
  });
});
