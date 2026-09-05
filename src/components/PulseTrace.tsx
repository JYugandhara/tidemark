"use client";

/**
 * The masthead trace.
 *
 * A one-line oscilloscope that deflects once per frame arriving on the SSE
 * stream. It is not decoration: a flat trace means no data is reaching this tab,
 * which is exactly the failure a status dot that says "live" will happily lie
 * about. The trace scrolls whether or not anything arrives, so flat is visibly
 * flat rather than frozen.
 */

import { useEffect, useRef, useState } from "react";

const SAMPLES = 42;
const W = 96;
const H = 22;
const MID = H / 2;
const AMPLITUDE = 8;
const TICK_MS = 110;

/** One deflection, spread over consecutive samples so it reads as a pulse. */
const DEFLECTION = [0.14, -0.24, 1, -0.55, 0.2, 0.07];

export function PulseTrace({ beat, live }: { beat: number; live: boolean }) {
  const [samples, setSamples] = useState<number[]>(() => new Array<number>(SAMPLES).fill(0));
  const queue = useRef<number[]>([]);
  const lastBeat = useRef(beat);

  // A new frame arms a deflection; the scroll loop below plays it out.
  useEffect(() => {
    if (beat !== lastBeat.current) {
      lastBeat.current = beat;
      queue.current = [...DEFLECTION];
    }
  }, [beat]);

  useEffect(() => {
    const t = setInterval(() => {
      const next = queue.current.length > 0 ? queue.current.shift()! : 0;
      setSamples((prev) => [...prev.slice(1), next]);
    }, TICK_MS);
    return () => clearInterval(t);
  }, []);

  const step = W / (SAMPLES - 1);
  const path = samples
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(MID - v * AMPLITUDE).toFixed(1)}`)
    .join(" ");
  const stroke = live ? "var(--live)" : "var(--text-ghost)";
  const head = MID - samples[samples.length - 1] * AMPLITUDE;

  return (
    <svg
      className="pulse-trace"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={live ? "Stream connected; trace deflects on each frame" : "Stream not connected"}
    >
      <line x1={0} y1={MID} x2={W} y2={MID} stroke="var(--grid)" strokeWidth={1} />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={W} cy={head} r={1.8} fill={stroke} />
    </svg>
  );
}
