"use client";

/**
 * The sigma ruler.
 *
 * The single most important idea in this product is that percentages are not
 * comparable across instruments and sigmas are. This is that idea drawn: a
 * fixed −3σ…+3σ scale with the instrument's ordinary range shaded, and today's
 * move marked on it.
 *
 * Put two of these side by side and the point makes itself — a +3.1% day on a
 * habitually violent name lands inside the shaded band, while a −2.0% day on a
 * quiet one lands well outside it.
 */

interface Props {
  /** Signed move in sigma units. */
  sigmaMultiple: number;
  direction: "up" | "down" | "flat";
  /** The instrument's own daily sigma, shown as the scale's unit. */
  dailySigmaPct: number;
  label?: string;
}

const W = 420;
const H = 26;
const PAD = 8;
const MAX_SIGMA = 3;

function xFor(sigma: number): number {
  const clamped = Math.max(-MAX_SIGMA, Math.min(MAX_SIGMA, sigma));
  return PAD + ((clamped + MAX_SIGMA) / (2 * MAX_SIGMA)) * (W - PAD * 2);
}

export function SigmaRuler({ sigmaMultiple, direction, dailySigmaPct, label }: Props) {
  const signed = direction === "down" ? -Math.abs(sigmaMultiple) : Math.abs(sigmaMultiple);
  const x = xFor(signed);
  const beyond = Math.abs(signed) > MAX_SIGMA;
  const stroke =
    direction === "up" ? "var(--up)" : direction === "down" ? "var(--down)" : "var(--text-dim)";

  return (
    <div className="ruler">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`Move of ${signed.toFixed(1)} sigma on a scale where one sigma is ${dailySigmaPct}% for this instrument`}
        preserveAspectRatio="none"
      >
        {/* The band inside which this name lives on an ordinary day. */}
        <rect
          x={xFor(-1)}
          y={6}
          width={xFor(1) - xFor(-1)}
          height={12}
          fill="var(--raised)"
        />
        <line
          x1={PAD}
          y1={18}
          x2={W - PAD}
          y2={18}
          stroke="var(--edge-hot)"
          strokeWidth={1}
        />
        {[-3, -2, -1, 0, 1, 2, 3].map((s) => (
          <line
            key={s}
            x1={xFor(s)}
            y1={s === 0 ? 4 : 12}
            x2={xFor(s)}
            y2={18}
            stroke={s === 0 ? "var(--text-faint)" : "var(--edge-hot)"}
            strokeWidth={1}
          />
        ))}
        {/* The move itself: a stem from zero plus a head, so both the size and
            the direction read without colour. */}
        <line x1={xFor(0)} y1={18} x2={x} y2={18} stroke={stroke} strokeWidth={2} />
        <polygon
          points={`${x},${9} ${x - 4},${18} ${x + 4},${18}`}
          fill={stroke}
        />
        {beyond && (
          <text
            x={signed > 0 ? W - PAD - 2 : PAD + 2}
            y={9}
            fontSize={9}
            textAnchor={signed > 0 ? "end" : "start"}
            fill={stroke}
            fontFamily="var(--mono)"
          >
            {signed > 0 ? "▸ off scale" : "off scale ◂"}
          </text>
        )}
      </svg>
      <div className="ruler-caption">
        <span>−3σ</span>
        <span>{label ?? `1σ = ${dailySigmaPct.toFixed(2)}% for this name`}</span>
        <span>+3σ</span>
      </div>
    </div>
  );
}
