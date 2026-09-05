/**
 * The simulated provider.
 *
 * Wraps the deterministic engine in the same interface a real vendor gets, and
 * applies any injected scenarios on the way out. Because scenarios are applied
 * *here* — at the edge, in the provider — everything downstream reacts to a
 * forced halt or a bad print exactly as it would to a real one.
 */

import type { DailyBar, Quote } from "@/core/types";
import { makeCalendar, phaseAt, sessionDateOf } from "@/core/market/calendar";
import { config } from "../config";
import { MarketSimulator, simClock } from "./sim-engine";
import { activeScenarios, num, scenariosFor, type Scenario } from "./scenarios";
import { ProviderError, type Clock, systemClock } from "./resilience";
import type { MarketDataProvider, ProviderCapabilities, QuoteResult } from "./types";

const calendar = makeCalendar();

export interface SimulatedProviderOptions {
  clock?: Clock;
  /** Injected for tests; defaults to reading the scenarios table. */
  scenarioSource?: (now: number) => Promise<Scenario[]>;
  seed?: number;
  volatilityScale?: number;
  speedup?: number;
  alwaysOpen?: boolean;
}

export class SimulatedProvider implements MarketDataProvider {
  readonly name = "simulated";
  readonly capabilities: ProviderCapabilities = {
    quotesIncludeBook: true,
    dailyHistory: true,
    maxBatchSize: 200,
    requestsPerSecond: 50,
  };

  private readonly sim: MarketSimulator;
  private readonly clock: Clock;
  private readonly scenarioSource: (now: number) => Promise<Scenario[]>;
  private readonly speedup: number;
  private readonly alwaysOpen: boolean;

  constructor(opts: SimulatedProviderOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.scenarioSource = opts.scenarioSource ?? ((now) => activeScenarios(now));
    this.speedup = opts.speedup ?? 1;
    this.alwaysOpen = opts.alwaysOpen ?? config.SIM_ALWAYS_OPEN;

    const today = sessionDateOf(this.clock());
    this.sim = new MarketSimulator({
      seed: opts.seed ?? config.SIM_SEED,
      volatilityScale: opts.volatilityScale ?? config.SIM_VOLATILITY,
      calendar,
      // Two trading years of history ending well past today, so synthetic
      // sessions running ahead of the wall clock still have generated data.
      anchorDate: shiftYears(today, -2),
      horizonDays: 620,
    });
  }

  isConfigured(): boolean {
    return true;
  }

  /** Where the simulated market currently is. Also surfaced on /api/health. */
  clockReading() {
    const now = this.clock();
    const today = sessionDateOf(now);
    return simClock(calendar, now, {
      alwaysOpen: this.alwaysOpen,
      speedup: this.speedup,
      realPhaseOpen: phaseAt(calendar, now) === "OPEN",
      today,
    });
  }

  async getQuotes(symbols: readonly string[]): Promise<QuoteResult> {
    const now = this.clock();
    const scenarios = await this.scenarioSource(now);

    const outage = scenarios.find(
      (s) => s.kind === "provider_outage" && (s.params.provider ?? "simulated") === "simulated",
    );
    if (outage) {
      throw new ProviderError("simulated provider outage (injected)", true, 503);
    }

    const latency = scenarios.find((s) => s.kind === "latency");
    if (latency) {
      await sleep(num(latency.params, "ms", 500));
    }

    const reading = this.clockReading();
    const quotes: Quote[] = [];
    const missing: Array<{ symbol: string; reason: string }> = [];

    for (const symbol of symbols) {
      const mine = scenariosFor(scenarios, symbol);
      if (mine.some((s) => s.kind === "stale")) {
        missing.push({ symbol, reason: "feed silent (injected)" });
        continue;
      }
      const base = this.sim.quoteAt(symbol, reading.sessionDate, reading.minute, now);
      if (!base) {
        missing.push({ symbol, reason: "unknown symbol" });
        continue;
      }
      quotes.push(applyScenarios(base, mine, now));
    }

    return { quotes, missing };
  }

  async getDailyBars(symbol: string, days: number): Promise<DailyBar[]> {
    const reading = this.clockReading();
    const bars = this.sim.bars(symbol, reading.sessionDate, days + 1);
    // Exclude the session currently in progress; a half-formed bar would
    // contaminate the volatility baseline.
    return bars.filter((b) => b.date < reading.sessionDate);
  }
}

function applyScenarios(quote: Quote, scenarios: readonly Scenario[], now: number): Quote {
  let q: Quote = { ...quote };

  for (const s of scenarios) {
    switch (s.kind) {
      case "halt":
        q = { ...q, halted: true };
        break;

      case "gap": {
        // Shift the whole session as if it had opened at a different level.
        const pct = num(s.params, "pct", 4) / 100;
        q = {
          ...q,
          price: round2(q.price * (1 + pct)),
          open: q.open === null ? null : round2(q.open * (1 + pct)),
          dayHigh: q.dayHigh === null ? null : round2(q.dayHigh * (1 + pct)),
          dayLow: q.dayLow === null ? null : round2(q.dayLow * (1 + pct)),
        };
        break;
      }

      case "spike": {
        // A step change that ramps in over `rampMs` so the UI shows movement
        // rather than teleporting.
        const pct = num(s.params, "pct", 3) / 100;
        const ramp = Math.max(1, num(s.params, "rampMs", 20_000));
        const progress = Math.min(1, (now - s.createdAt) / ramp);
        const applied = pct * progress;
        const price = round2(q.price * (1 + applied));
        q = {
          ...q,
          price,
          dayHigh: Math.max(q.dayHigh ?? price, price),
          dayLow: Math.min(q.dayLow ?? price, price),
        };
        break;
      }

      case "circuit": {
        const side = s.params.side === "lower" ? "lower" : "upper";
        const band = side === "upper" ? q.upperCircuit : q.lowerCircuit;
        if (band) q = { ...q, price: round2(band) };
        break;
      }

      case "volume_surge": {
        const factor = Math.max(1, num(s.params, "factor", 5));
        q = { ...q, volume: q.volume === null ? null : Math.round(q.volume * factor) };
        break;
      }

      case "bad_print": {
        // The classic feed defect: a decimal in the wrong place. The pipeline
        // is supposed to reject this before it becomes a 52-week low.
        const factor = num(s.params, "factor", 0.1);
        q = { ...q, price: round2(q.price * factor) };
        break;
      }

      default:
        break;
    }
  }
  return q;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, 5_000))));
}

function shiftYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
