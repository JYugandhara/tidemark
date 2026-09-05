/**
 * Which clock the engine should believe.
 *
 * When a real feed is primary we use the exchange calendar. When the simulator
 * is driving — because there is no API key, or because the market is shut and
 * the app would otherwise be a wall of frozen numbers — we use the generated
 * session instead, so gaps, volume profiles and staleness all mean what they
 * say. The UI is told which of the two is in force and says so on screen; the
 * one thing this must never do is quietly present generated data as live.
 */

import { makeCalendar } from "@/core/market/calendar";
import { realClock, syntheticClock, type MarketClock } from "@/core/market/clock";
import { config } from "../config";
import { SimulatedProvider } from "../providers/simulated";

export const calendar = makeCalendar();

let simulator: SimulatedProvider | null = null;

function sim(): SimulatedProvider {
  simulator ??= new SimulatedProvider();
  return simulator;
}

export function marketClock(): MarketClock {
  const simulatorIsPrimary = config.MARKET_PROVIDERS[0] === "simulated";
  if (!simulatorIsPrimary) return realClock(calendar);
  return syntheticClock(calendar, () => {
    const r = sim().clockReading();
    return { sessionDate: r.sessionDate, minute: r.minute, synthetic: r.synthetic };
  });
}

export function currentSession(now = Date.now()) {
  return marketClock().session(now);
}
