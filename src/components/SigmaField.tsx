"use client";

/**
 * The field.
 *
 * Every watched instrument, plotted once, on the two axes the product actually
 * ranks by:
 *
 *   x — how unusual the move is, in that instrument's own sigmas
 *   y — the significance score built from every detector that fired
 *
 * and one horizontal line in the accent: the tide line. Whatever rises above it
 * interrupts you; whatever does not, does not. That is the entire argument of
 * the product, drawn once, and it updates live.
 *
 * The shaded column in the middle is ±1σ — the range each name lives in on an
 * ordinary day. A mark sitting inside that column with a large percentage under
 * it is the case a conventional watchlist gets wrong, and here you can see it.
 */

import { useMemo } from "react";
import type { DigestEntryDTO } from "@/server/services/digest";
import type { LiveQuote } from "@/lib/useLiveDigest";
import { direction as dirOf } from "@/lib/format";

interface Props {
  attention: DigestEntryDTO[];
  quiet: DigestEntryDTO[];
  quotes: Record<string, LiveQuote>;
  threshold: number;
  selected: string | null;
  onSelect: (instrumentId: string) => void;
}

const W = 1000;
const H = 214;
const BASE = 170; // score 0
const TOP = 26; // score 100
const LEFT = 46;
const RIGHT = 954;
const MAX_SIGMA = 3;
/** Mono at 9.5px with the tracking below measures ~6.1px per character. */
const CHAR_WIDTH = 6.1;
const LABEL_GAP = 8;
const LANE_HEIGHT = 12;
const MAX_LANES = 4;

const xFor = (s: number) =>
  LEFT + ((Math.max(-MAX_SIGMA, Math.min(MAX_SIGMA, s)) + MAX_SIGMA) / (2 * MAX_SIGMA)) * (RIGHT - LEFT);
const yFor = (score: number) => BASE - (Math.max(0, Math.min(100, score)) / 100) * (BASE - TOP);

interface Mark {
  id: string;
  symbol: string;
  sigma: number;
  offScale: boolean;
  score: number;
  band: string;
  above: boolean;
  x: number;
  y: number;
  labelY: number;
}

function signedSigma(e: DigestEntryDTO, live: LiveQuote | undefined): number | null {
  if (e.sigmaMultiple === null || !Number.isFinite(e.sigmaMultiple)) return null;
  const price = live?.price ?? e.price;
  const pct =
    price !== null && e.referencePrice
      ? (price - e.referencePrice) / e.referencePrice
      : e.changeSinceReferencePct;
  return dirOf(pct) === "down" ? -Math.abs(e.sigmaMultiple) : Math.abs(e.sigmaMultiple);
}

export function SigmaField({ attention, quiet, quotes, threshold, selected, onSelect }: Props) {
  const { marks, unplottable } = useMemo(() => {
    const rows: Mark[] = [];
    let dropped = 0;

    for (const e of [...attention, ...quiet]) {
      const s = signedSigma(e, quotes[e.instrumentId]);
      if (s === null) {
        dropped += 1;
        continue;
      }
      rows.push({
        id: e.instrumentId,
        symbol: e.symbol,
        sigma: s,
        offScale: Math.abs(s) > MAX_SIGMA,
        score: e.score,
        band: e.band,
        above: !e.quiet,
        x: xFor(s),
        y: yFor(e.score),
        labelY: 0,
      });
    }

    // Label placement. Only marks above the line get one, and only those can
    // collide — but they collide by *width*, not by centre distance: IDEA and
    // HINDUNILVR sit far enough apart to pass a fixed-gap test and still
    // overlap, because one of them is nearly three times as wide. So each label
    // claims an interval, and a lane is reused only once its previous occupant
    // has genuinely ended.
    const labelled = rows.filter((r) => r.above).sort((a, b) => a.x - b.x);
    const placed: Array<{ left: number; right: number; y: number }> = [];
    for (const r of labelled) {
      const halfWidth = (r.symbol.length * CHAR_WIDTH) / 2;
      const left = r.x - halfWidth;
      const right = r.x + halfWidth;

      // Lanes are offsets from each label's *own* dot, so a lane number is not
      // a row: two dots at different heights can sit in different lanes and
      // still land on the same pixels. So test the box that would actually be
      // drawn, and take the first lane that is clear in both axes at once.
      let y = Math.max(11, r.y - 9);
      for (let lane = 0; lane < MAX_LANES; lane++) {
        const candidate = Math.max(11, r.y - 9 - lane * LANE_HEIGHT);
        const clashes = placed.some(
          (p) =>
            left < p.right + LABEL_GAP &&
            right > p.left - LABEL_GAP &&
            Math.abs(candidate - p.y) < LANE_HEIGHT,
        );
        if (!clashes) {
          y = candidate;
          break;
        }
        y = candidate; // last resort: the topmost lane, even if tight
      }

      placed.push({ left, right, y });
      r.labelY = y;
    }

    return { marks: rows, unplottable: dropped };
  }, [attention, quiet, quotes]);

  const tideY = yFor(threshold);

  return (
    <>
      <div className="field-body">
      <svg
        className="field-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Significance against unusualness for ${marks.length} instruments, with the tide line at ${threshold}`}
      >
        <defs>
          <pattern id="ordinary" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--grid)" strokeWidth="1" />
          </pattern>
        </defs>

        {/* ±1σ — where each name spends an ordinary day. */}
        <rect x={xFor(-1)} y={TOP - 8} width={xFor(1) - xFor(-1)} height={BASE - TOP + 8} fill="url(#ordinary)" />

        {/* σ grid */}
        {[-3, -2, -1, 0, 1, 2, 3].map((s) => (
          <g key={s}>
            <line
              x1={xFor(s)}
              y1={TOP - 8}
              x2={xFor(s)}
              y2={BASE}
              stroke={s === 0 ? "var(--edge-hot)" : "var(--grid)"}
              strokeWidth={1}
            />
            <text
              x={xFor(s)}
              y={BASE + 16}
              fontSize={9}
              textAnchor="middle"
              fill={s === 0 ? "var(--text-faint)" : "var(--text-ghost)"}
              fontFamily="var(--mono)"
              letterSpacing="0.08em"
            >
              {s > 0 ? `+${s}σ` : s === 0 ? "0σ" : `−${Math.abs(s)}σ`}
            </text>
          </g>
        ))}

        {/* the baseline */}
        <line x1={LEFT} y1={BASE} x2={RIGHT} y2={BASE} stroke="var(--edge)" strokeWidth={1} />

        {/* score axis */}
        {[0, 50, 100].map((v) => (
          <text
            key={v}
            x={LEFT - 10}
            y={yFor(v) + 3}
            fontSize={8.5}
            textAnchor="end"
            fill="var(--text-ghost)"
            fontFamily="var(--mono)"
          >
            {v}
          </text>
        ))}

        {/* the tide line */}
        <line
          x1={LEFT}
          y1={tideY}
          x2={RIGHT}
          y2={tideY}
          stroke="var(--accent)"
          strokeWidth={1}
          strokeDasharray="5 4"
        />
        <text
          x={RIGHT}
          y={tideY - 6}
          fontSize={9}
          textAnchor="end"
          fill="var(--accent)"
          fontFamily="var(--mono)"
          letterSpacing="0.16em"
        >
          TIDE LINE {threshold}
        </text>

        {/* the instruments */}
        {marks.map((m) => {
          // Colour is spent on the mark, not on the stem and not on the type.
          // Six bright stems and six bright labels is a chart shouting; a dot
          // that is the only saturated thing at that x is a chart pointing.
          const critical = m.band === "critical";
          const colour = m.above
            ? critical
              ? "var(--critical)"
              : "var(--accent)"
            : "var(--text-faint)";
          const stem = m.above
            ? critical
              ? "var(--critical)"
              : "var(--accent-deep)"
            : "var(--text-ghost)";
          return (
            <g
              key={m.id}
              onClick={() => onSelect(m.id)}
              style={{ cursor: "pointer" }}
              opacity={selected && selected !== m.id ? 0.45 : 1}
            >
              <title>{`${m.symbol} — score ${Math.round(m.score)}, ${m.sigma.toFixed(1)}σ`}</title>
              <line
                x1={m.x}
                y1={BASE}
                x2={m.x}
                y2={m.y}
                stroke={stem}
                strokeWidth={m.above ? 1.25 : 1}
                opacity={m.above ? (critical ? 0.55 : 0.85) : 0.6}
              />
              <circle cx={m.x} cy={m.y} r={m.above ? 3.2 : 2} fill={colour} />
              {selected === m.id && (
                <circle cx={m.x} cy={m.y} r={7} fill="none" stroke={colour} strokeWidth={1} opacity={0.7} />
              )}
              {m.offScale && (
                <text
                  x={m.sigma > 0 ? m.x + 7 : m.x - 7}
                  y={m.y + 3}
                  fontSize={9}
                  textAnchor={m.sigma > 0 ? "start" : "end"}
                  fill={colour}
                  fontFamily="var(--mono)"
                >
                  {m.sigma > 0 ? "▸" : "◂"}
                </text>
              )}
              {m.above && (
                <text
                  x={m.x}
                  y={m.labelY}
                  fontSize={9.5}
                  textAnchor="middle"
                  fill={critical ? "var(--critical)" : "var(--text)"}
                  fontFamily="var(--mono)"
                  letterSpacing="0.06em"
                >
                  {m.symbol}
                </text>
              )}
            </g>
          );
        })}

        {marks.length === 0 && (
          <text
            x={W / 2}
            y={(BASE + TOP) / 2}
            fontSize={11}
            textAnchor="middle"
            fill="var(--text-ghost)"
            fontFamily="var(--mono)"
            letterSpacing="0.16em"
          >
            NO SCORED INSTRUMENTS YET
          </text>
        )}
      </svg>
      </div>

      <div className="field-legend">
        <span>
          <i style={{ background: "var(--accent)" }} />
          above the line
        </span>
        <span>
          <i style={{ background: "var(--text-faint)" }} />
          considered, held back
        </span>
        <span>
          <i style={{ background: "var(--edge-hot)" }} />
          the shaded column is ±1 sigma — an ordinary day for that name
        </span>
        {unplottable > 0 && <span>{unplottable} not scored — no usable data</span>}
      </div>
    </>
  );
}
