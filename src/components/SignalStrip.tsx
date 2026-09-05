"use client";

/**
 * One instrument that cleared the line.
 *
 * Read left to right, the strip is a single instrument channel: the gauge that
 * says how far it deflected, the identity and the sentence explaining it, the
 * decomposition of the score in line, and then the hard numbers in their own
 * column where they stay comparable down the page.
 *
 * Nothing here re-sorts on a price tick. The live overlay moves the price and
 * flashes the row; the ranking belongs to the server's model and changing it
 * under the reader's cursor every two seconds is the exact twitchiness this
 * product exists to remove.
 */

import { useState } from "react";
import { useNow } from "@/lib/useNow";
import type { DigestEntryDTO } from "@/server/services/digest";
import type { LiveQuote } from "@/lib/useLiveDigest";
import {
  direction as dirOf,
  formatEvidenceValue,
  humanEvidenceKey,
  humanKind,
  money,
  relative,
  sigma as fmtSigma,
  signedPct,
} from "@/lib/format";
import { ContributionStack } from "./ContributionStack";
import { SigmaRuler } from "./SigmaRuler";
import { Sparkline } from "./Sparkline";

interface Props {
  entry: DigestEntryDTO;
  live: LiveQuote | undefined;
  flash: "up" | "down" | undefined;
  selected: boolean;
  onMute: (entry: DigestEntryDTO) => void;
  onConviction: (entry: DigestEntryDTO) => void;
  onRemove: (entry: DigestEntryDTO) => void;
  onSelect: (instrumentId: string) => void;
}

const BAND_COLOR: Record<string, string> = {
  critical: "var(--critical)",
  high: "var(--accent)",
  moderate: "var(--accent-deep)",
  low: "var(--text-faint)",
  noise: "var(--text-ghost)",
};

export function SignalStrip({
  entry,
  live,
  flash,
  selected,
  onMute,
  onConviction,
  onRemove,
  onSelect,
}: Props) {
  const [open, setOpen] = useState(false);
  const now = useNow(20_000);

  const price = live?.price ?? entry.price;
  const previousClose = live?.previousClose ?? entry.previousClose;
  const halted = live?.halted ?? entry.halted;
  const todayPct =
    price !== null && previousClose ? (price - previousClose) / previousClose : entry.changeTodayPct;
  const sinceRefPct =
    price !== null && entry.referencePrice
      ? (price - entry.referencePrice) / entry.referencePrice
      : entry.changeSinceReferencePct;

  const dir = dirOf(sinceRefPct);
  const colour = BAND_COLOR[entry.band] ?? "var(--text-faint)";
  const muted = entry.mutedUntil !== null && entry.mutedUntil > now;
  // The sigma figure is measured over the same window as the percentage beside
  // it, so both metrics carry the same label rather than an unqualified
  // "unusual?" that quietly means something different after you acknowledge.
  const sinceLabel =
    entry.referenceLabel === "since you last checked" ? "since you left" : "since close";

  return (
    <article
      className="strip"
      data-band={entry.band}
      data-flash={flash}
      data-selected={selected}
      onClick={() => onSelect(entry.instrumentId)}
    >
      <div className="gauge">
        <span className="gauge-value" style={{ color: colour }}>
          {Math.round(entry.score)}
        </span>
        <div className="gauge-track">
          <div
            className="gauge-fill"
            style={{ width: `${Math.max(4, Math.min(100, entry.score))}%`, background: colour }}
          />
        </div>
        <span className="gauge-band">{entry.band}</span>
      </div>

      <div className="strip-main">
        <div className="strip-id">
          <span className="ticker">{entry.symbol}</span>
          <span className="company">{entry.name}</span>
          <span className="chip" data-c={entry.conviction}>
            {entry.conviction}
          </span>
          {halted && (
            <span className="chip" data-tone="alarm">
              halted
            </span>
          )}
          {muted && <span className="chip">muted</span>}
        </div>

        <p className="strip-headline">{entry.headline}</p>
        {/*
          A stored event describes what happened, not what the price is doing
          right now — an alert can outlive the move that caused it. So a story
          always carries its own timestamps rather than reading as a live claim
          that the numbers to the right then appear to contradict.
        */}
        {entry.eventFirstSeenAt !== null && (
          <p className="strip-sub">
            story first seen {relative(entry.eventFirstSeenAt, now)}
            {entry.eventLastUpdatedAt !== null &&
              entry.eventLastUpdatedAt - entry.eventFirstSeenAt > 30_000 &&
              ` · escalated ${relative(entry.eventLastUpdatedAt, now)}`}
            {" · unread by you"}
          </p>
        )}

        <ContributionStack contributions={entry.contributions} score={entry.score} />

        {entry.sigmaMultiple !== null && (
          <SigmaRuler
            sigmaMultiple={entry.sigmaMultiple}
            direction={dir}
            dailySigmaPct={entry.dailySigmaPct}
          />
        )}

        <div className="strip-actions">
          <button
            className="btn"
            data-variant="micro"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            aria-expanded={open}
          >
            {open ? "hide the arithmetic" : "why is this here?"}
          </button>
          <span style={{ flex: 1 }} />
          <button
            className="btn"
            data-variant="micro"
            onClick={(e) => {
              e.stopPropagation();
              onConviction(entry);
            }}
            title="Cycle conviction: core → tracking → background"
          >
            conviction
          </button>
          <button
            className="btn"
            data-variant="micro"
            onClick={(e) => {
              e.stopPropagation();
              onMute(entry);
            }}
          >
            {muted ? "unmute" : "mute 1h"}
          </button>
          <button
            className="btn"
            data-variant="micro"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(entry);
            }}
          >
            remove
          </button>
        </div>
      </div>

      <div className="strip-metrics">
        <div className="metric">
          <span>Last</span>
          <span className="num">{money(price)}</span>
        </div>
        <div className="metric">
          <span>Today</span>
          <span className={`num ${dirOf(todayPct)}`}>{signedPct(todayPct)}</span>
        </div>
        <div className="metric">
          <span>{sinceLabel}</span>
          <span className={`num ${dir}`}>{signedPct(sinceRefPct)}</span>
        </div>
        <div className="metric">
          <span>that, in sigma</span>
          <span className="num" style={{ color: colour }}>
            {fmtSigma(entry.sigmaMultiple)}
          </span>
        </div>

        <div className="metric" data-wide="true">
          <span>Feed</span>
          <span className="freshness" data-f={entry.freshness}>
            {entry.freshness.toLowerCase().replace("_", " ")} · {entry.ageLabel}
            {entry.provider ? ` · ${entry.provider}` : ""}
          </span>
        </div>

        <div className="spark-wrap">
          <Sparkline
            points={entry.tape}
            since={entry.referenceLabel === "since you last checked" ? entry.referenceAsOf : null}
            direction={dir}
            width={112}
            height={26}
          />
          <span className="spark-note">
            {entry.tape.length > 1
              ? entry.referenceLabel === "since you last checked"
                ? "shaded: while away"
                : "today"
              : "no tape yet"}
          </span>
        </div>
      </div>

      {open && <Why entry={entry} />}
    </article>
  );
}

function Why({ entry }: { entry: DigestEntryDTO }) {
  const maxPoints = Math.max(1, ...entry.contributions.map((c) => c.points));
  return (
    <div className="why" onClick={(e) => e.stopPropagation()}>
      <h4>Score {entry.score.toFixed(1)} — where every point came from</h4>
      {entry.contributions.map((c) => (
        <div key={`${c.kind}-${c.detail}`}>
          <div className="contrib">
            <span className="contrib-kind">{humanKind(c.kind)}</span>
            <div className="contrib-track">
              <div className="contrib-fill" style={{ width: `${(c.points / maxPoints) * 100}%` }} />
            </div>
            <span className="contrib-points">+{c.points.toFixed(1)}</span>
          </div>
          <div className="contrib-detail">{c.detail}</div>
        </div>
      ))}

      {entry.signals.map((s) => (
        <div key={`${s.kind}-${s.headline}`}>
          <h4>{humanKind(s.kind)} — evidence</h4>
          <div className="evidence">
            {Object.entries(s.evidence).map(([k, v]) => (
              <div key={k}>
                <span>{humanEvidenceKey(k)}</span>
                <span>{formatEvidenceValue(v, k)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <p className="why-foot">
        Weights are fixed and published, not learned: with no labelled data a transparent
        prior beats a model nobody can argue with. Your conviction setting scales the
        total; repeated sightings of the same story scale it down.
      </p>
    </div>
  );
}
