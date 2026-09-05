"use client";

/**
 * Everything below the tide line.
 *
 * Not a leftovers bin. Showing the names that were considered and held back —
 * each with its sigma, its score, and the reason — is what makes the silence
 * trustworthy. A reader can see that SUZLON moved 3.1%, that the system knows,
 * and that for SUZLON it decided this is a Tuesday. Without this list the only
 * way to audit the model is to go and look at the prices yourself, which is the
 * job the product claims to have taken off your hands.
 */

import type { DigestEntryDTO } from "@/server/services/digest";
import type { LiveQuote } from "@/lib/useLiveDigest";
import { direction as dirOf, money, sigma as fmtSigma, signedPct } from "@/lib/format";

interface Props {
  entries: DigestEntryDTO[];
  quotes: Record<string, LiveQuote>;
  selected: string | null;
  onSelect: (instrumentId: string) => void;
}

export function SubThreshold({ entries, quotes, selected, onSelect }: Props) {
  if (entries.length === 0) return null;

  return (
    <section className="subtide" aria-label="Instruments held below the tide line">
      <div className="sub-row" style={{ cursor: "default" }}>
        <span className="label">instrument</span>
        <span className="label">in sigma</span>
        <span className="label" style={{ textAlign: "right" }}>
          score
        </span>
        <span className="label">why it stayed quiet</span>
        <span className="label" style={{ textAlign: "right" }}>
          today
        </span>
        <span className="label" style={{ textAlign: "right" }}>
          last
        </span>
      </div>

      {entries.map((e) => {
        const live = quotes[e.instrumentId];
        const price = live?.price ?? e.price;
        const previousClose = live?.previousClose ?? e.previousClose;
        const todayPct =
          price !== null && previousClose
            ? (price - previousClose) / previousClose
            : e.changeTodayPct;

        return (
          <div
            key={e.instrumentId}
            className="sub-row"
            data-instrument={e.instrumentId}
            data-selected={selected === e.instrumentId}
            style={selected === e.instrumentId ? { background: "var(--panel-2)" } : undefined}
            onClick={() => onSelect(e.instrumentId)}
            role="button"
            tabIndex={0}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") onSelect(e.instrumentId);
            }}
          >
            <span className="ticker" style={{ fontSize: 12 }}>
              {e.symbol}
            </span>
            <span className="num flat">{fmtSigma(e.sigmaMultiple)}</span>
            <span className="num sub-score">{Math.round(e.score)}</span>
            <span className="sub-reason" title={e.quietReason ?? undefined}>
              {e.quietReason}
            </span>
            <span className={`num ${dirOf(todayPct)}`} style={{ textAlign: "right" }}>
              {signedPct(todayPct)}
            </span>
            <span className="num sub-price">{money(price)}</span>
          </div>
        );
      })}
    </section>
  );
}
