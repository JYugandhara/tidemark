"use client";

/**
 * The score, taken apart, in line.
 *
 * The old design hid this behind a disclosure. That was a mistake: the whole
 * claim of the ranking is that it can be interrogated, and a claim you have to
 * click to see is one most readers never test. So the decomposition is always
 * on screen — each segment as wide as the points it contributed, the hatched
 * remainder showing how much of the 0–100 scale is still unused.
 *
 * The drawer behind "the arithmetic" still exists, for the evidence.
 */

import { humanKind } from "@/lib/format";

/* One hue, stepping down in luminance. A rainbow here would imply the
   detectors are different *kinds* of thing; they are the same kind, in
   descending order of how much they contributed. */
const RAMP = ["#1f8580", "#1a6f6b", "#155a57", "#114744", "#0e3a38"];

interface Props {
  contributions: Array<{ kind: string; points: number; detail: string }>;
  score: number;
}

export function ContributionStack({ contributions, score }: Props) {
  if (contributions.length === 0) return null;
  // Four is what fits legibly at the width this bar actually gets. A fifth
  // segment squeezes every label into an unreadable stub, which loses more
  // information than folding it into the remainder does.
  const shown = contributions.slice(0, 4);
  const hidden = contributions.slice(4);

  return (
    <div className="stack" aria-label={`Score ${Math.round(score)} out of 100, by contribution`}>
      {shown.map((c, i) => (
        <div
          key={`${c.kind}-${i}`}
          className="stack-seg"
          style={{
            // Basis only — shrink stays in CSS so narrow screens can turn it
            // off and scroll instead of truncating every label.
            flexGrow: 0,
            flexBasis: `${Math.max(3, c.points)}%`,
            background: RAMP[Math.min(i, RAMP.length - 1)],
          }}
          title={`${humanKind(c.kind)} +${c.points.toFixed(1)} — ${c.detail}`}
        >
          <span>
            {humanKind(c.kind)} +{c.points.toFixed(0)}
          </span>
        </div>
      ))}
      <div
        className="stack-rest"
        title={
          (hidden.length > 0
            ? `${hidden.length} smaller contribution${hidden.length === 1 ? "" : "s"}: ` +
              hidden.map((c) => `${humanKind(c.kind)} +${c.points.toFixed(1)}`).join(", ") + " · "
            : "") + `${(100 - score).toFixed(0)} points of headroom left on the scale`
        }
      />
    </div>
  );
}
