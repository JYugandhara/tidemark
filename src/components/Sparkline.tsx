"use client";

/**
 * A sparkline whose job is not "show the price" — the number above it already
 * does that — but "show the part you missed".
 *
 * Everything after the reader's watermark is shaded. Nothing else on the page
 * makes the phrase "since you last checked" as immediate as a line with a
 * visible boundary in it.
 */

interface Props {
  points: Array<{ t: number; p: number }>;
  /** Instant the reader last saw this instrument; the shading starts here. */
  since: number | null;
  direction: "up" | "down" | "flat";
  width?: number;
  height?: number;
}

export function Sparkline({ points, since, direction, width = 132, height = 30 }: Props) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--edge)"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const prices = points.map((p) => p.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || Math.max(max * 0.001, 0.01);
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tSpan = t1 - t0 || 1;

  const x = (t: number) => ((t - t0) / tSpan) * (width - 2) + 1;
  const y = (p: number) => height - 3 - ((p - min) / span) * (height - 6);

  const path = points.map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join(" ");

  const stroke =
    direction === "up" ? "var(--up)" : direction === "down" ? "var(--down)" : "var(--text-dim)";

  const boundaryX =
    since !== null && since > t0 && since < t1 ? x(since) : since !== null && since <= t0 ? 1 : null;

  const last = points[points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`Recent price path${boundaryX !== null ? ", shaded since your last visit" : ""}`}
    >
      {boundaryX !== null && (
        <>
          <rect
            x={boundaryX}
            y={0}
            width={Math.max(0, width - boundaryX)}
            height={height}
            fill="var(--raised)"
          />
          <line
            x1={boundaryX}
            y1={0}
            x2={boundaryX}
            y2={height}
            stroke="var(--edge-hot)"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        </>
      )}
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" />
      <circle cx={x(last.t)} cy={y(last.p)} r={1.9} fill={stroke} />
    </svg>
  );
}
