"use client";

import { useEffect, useState } from "react";

/**
 * A ticking clock as state.
 *
 * Reading `Date.now()` during render makes a component impure: two renders
 * with identical props can disagree, which React 19 is right to complain
 * about. Holding "now" in state fixes that and has a nicer side effect — the
 * relative timestamps on the page ("happened 11 min ago") stay honest without
 * anybody refreshing.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return now;
}
