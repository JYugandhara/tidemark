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

import { isMarketOpen, makeCalendar } from "@/core/market/calendar";
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
  // Which clock to believe follows which provider is actually *driving*, not
  // which one is listed first. Configuring a live feed does not mean a live
  // feed is answering: outside exchange hours it declines and the simulator
  // takes over. Believing the real calendar then would mean scoring generated
  // intraday movement against a market-time horizon of nearly zero, which is
  // how you get 5σ out of a 0.2% move — the same failure ADR-6 documents, and
  // it would also drop the "this is simulated" banner while simulated prices
  // were still on screen.
  const hasLiveFeed = config.MARKET_PROVIDERS.some((p) => p !== "simulated");
  const simulatorIsDriving = !hasLiveFeed || !isMarketOpen(calendar, Date.now());
  if (!simulatorIsDriving) return realClock(calendar);
  return syntheticClock(calendar, () => {
    const r = sim().clockReading();
    return { sessionDate: r.sessionDate, minute: r.minute, synthetic: r.synthetic };
  });
}

export function currentSession(now = Date.now()) {
  return marketClock().session(now);
}
