"use client";

/**
 * The instrument.
 *
 * Arranged the way a monitoring instrument is, not the way a document is:
 *
 *   masthead   — is data arriving, what session is this, how much is above the line
 *   the field  — every watched name plotted at once, with the tide line drawn
 *   channels   — the handful that cleared it, each one taking its score apart
 *   sub-tide   — everything that did not, and the reason
 *
 * Deliberately not a grid of equal tiles. A grid claims everything matters
 * equally, which is the claim this product exists to argue against.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DigestEntryDTO } from "@/server/services/digest";
import { api, ApiClientError } from "@/lib/api";
import { useLiveDigest } from "@/lib/useLiveDigest";
import { relative, sigma as fmtSigma } from "@/lib/format";
import { PulseTrace } from "./PulseTrace";
import { SigmaField } from "./SigmaField";
import { SignalStrip } from "./SignalStrip";
import { SubThreshold } from "./SubThreshold";
import { AddInstrument } from "./AddInstrument";
import { FeedRoom } from "./FeedRoom";
import { ScenarioLab } from "./ScenarioLab";
import { DeviceHandoff } from "./DeviceHandoff";

const CONVICTION_CYCLE = ["core", "tracking", "background"] as const;

export function App() {
  const live = useLiveDigest();
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [thresholdOverride, setThresholdOverride] = useState<number | null>(null);
  const [watchlistId, setWatchlistId] = useState<string | null>(null);
  const [healthNonce, setHealthNonce] = useState(0);
  const [acking, setAcking] = useState(false);

  const say = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 4200);
  }, []);

  // The first watchlist is the one the add box writes into.
  useEffect(() => {
    if (!live.user) return;
    void api
      .watchlists()
      .then((res) => setWatchlistId(res.watchlists[0]?.id ?? null))
      .catch(() => setWatchlistId(null));
  }, [live.user, live.lastRefreshedAt]);

  // Derived, not synchronised: the slider's local position wins while the
  // reader is dragging it, and the server's value is the answer otherwise.
  const threshold = thresholdOverride ?? live.user?.attentionThreshold ?? 45;

  const attention = useMemo(() => live.digest?.attention ?? [], [live.digest]);
  const quiet = useMemo(() => live.digest?.quiet ?? [], [live.digest]);
  const all = useMemo(() => [...attention, ...quiet], [attention, quiet]);

  const peakSigma = useMemo(() => {
    const xs = all.map((e) => Math.abs(e.sigmaMultiple ?? 0));
    return xs.length ? Math.max(...xs) : null;
  }, [all]);

  const acknowledge = useCallback(async () => {
    if (acking) return;
    setAcking(true);
    try {
      const n = await live.acknowledge();
      say(
        n > 0
          ? `Marked ${n} ${n === 1 ? "story" : "stories"} as seen. From here, "since you last checked" means now.`
          : "Nothing outstanding — your reference point has been moved to now.",
      );
    } catch (err) {
      say(err instanceof Error ? err.message : "Could not save your position");
    } finally {
      setAcking(false);
    }
  }, [live, say, acking]);

  const patchItem = useCallback(
    async (entry: DigestEntryDTO, patch: { conviction?: string; mutedUntil?: number | null }) => {
      try {
        await api.patchItem(entry.itemId, { ...patch, version: entry.version });
        await live.refresh();
      } catch (err) {
        // The 409 path is the interesting one: another device got there first,
        // and the server told us exactly what it now holds.
        if (err instanceof ApiClientError && err.isConflict) {
          say("That item was changed on another device — reloading the current version.");
          await live.refresh();
          return;
        }
        say(err instanceof Error ? err.message : "Could not update that item");
      }
    },
    [live, say],
  );

  const onConviction = useCallback(
    (entry: DigestEntryDTO) => {
      const idx = CONVICTION_CYCLE.indexOf(entry.conviction);
      const next = CONVICTION_CYCLE[(idx + 1) % CONVICTION_CYCLE.length];
      void patchItem(entry, { conviction: next });
    },
    [patchItem],
  );

  const onMute = useCallback(
    (entry: DigestEntryDTO) => {
      const muted = entry.mutedUntil !== null && entry.mutedUntil > Date.now();
      void patchItem(entry, { mutedUntil: muted ? null : Date.now() + 3_600_000 });
    },
    [patchItem],
  );

  const onRemove = useCallback(
    async (entry: DigestEntryDTO) => {
      try {
        await api.removeItem(entry.itemId);
        say(`${entry.symbol} removed. It stops being polled within a minute.`);
        await live.refresh();
      } catch (err) {
        say(err instanceof Error ? err.message : "Could not remove that");
      }
    },
    [live, say],
  );

  // Keyboard navigation. This is a page people keep open, and reaching for a
  // mouse to say "I've seen it" is friction on the one action that matters most.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const ids = all.map((a) => a.instrumentId);
        if (ids.length === 0) return;
        const at = selected ? ids.indexOf(selected) : -1;
        const next =
          e.key === "j" ? Math.min(at + 1, ids.length - 1) : Math.max(at <= 0 ? 0 : at - 1, 0);
        setSelected(ids[next]);
        document
          .querySelector(`[data-instrument="${ids[next]}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (e.key === "a") {
        e.preventDefault();
        void acknowledge();
      } else if (e.key === "r") {
        e.preventDefault();
        void live.refresh();
      } else if (e.key === "m" && selected) {
        const entry = all.find((x) => x.instrumentId === selected);
        if (entry) onMute(entry);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [all, selected, acknowledge, live, onMute]);

  const streaming = live.streamState === "open";
  const phaseLabel = live.digest?.simulated
    ? "simulated"
    : (live.digest?.marketPhase ?? "").toLowerCase().replace(/_/g, " ") || "—";

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <h1 className="wordmark">
            TIDE<b>MARK</b>
          </h1>
          <span className="masthead-tag">significance, not size</span>

          <div className="masthead-readouts">
            <PulseTrace beat={live.beat} live={streaming} />
            <div className="readout" data-k="stream">
              <span>stream</span>
              <span>
                <span className="lamp" data-live={streaming} data-state={streaming ? "ok" : "warn"} />
                {streaming ? "live" : "reconnecting"}
              </span>
            </div>
            <div className="readout" data-k="session">
              <span>session</span>
              <span>{phaseLabel}</span>
            </div>
            <div className="readout" data-k="above">
              <span>above line</span>
              <span>
                {attention.length}
                <span style={{ color: "var(--text-ghost)" }}> / {all.length}</span>
              </span>
            </div>
            <div className="readout" data-k="peak">
              <span>peak</span>
              <span>{fmtSigma(peakSigma)}</span>
            </div>
            <div className="readout" data-k="read">
              <span>last read</span>
              <span>{relative(live.lastRefreshedAt)}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="shell">
        <section className="readline">
          <div>
            <h2>
              {live.status === "loading" ? (
                "Working out what changed…"
              ) : attention.length === 0 ? (
                <>
                  Nothing meaningful <b>has changed</b>.
                </>
              ) : (
                <>
                  <b>
                    {attention.length} thing{attention.length === 1 ? "" : "s"}
                  </b>{" "}
                  crossed the line.
                </>
              )}
            </h2>
            <p>
              measured against where you left off {relative(live.digest?.lastCheckedAt ?? null)}
              {live.digest
                ? ` · ${live.digest.summary.watched} watched · ${quiet.length} held back${
                    live.digest.summary.unavailable > 0
                      ? ` · ${live.digest.summary.unavailable} with no usable data`
                      : ""
                  }`
                : ""}
            </p>
          </div>

          <div className="readline-actions">
            {live.pendingChanges > 0 && (
              <span className="label" style={{ color: "var(--accent)" }}>
                {live.pendingChanges} arriving
              </span>
            )}
            <button className="btn" onClick={() => void live.refresh()}>
              refresh
            </button>
            <button
              className="btn"
              data-variant="primary"
              onClick={() => void acknowledge()}
              disabled={acking || live.status !== "ready"}
            >
              {acking ? "saving…" : "I've seen this"}
            </button>
          </div>
        </section>

        {live.error && (
          <div className="banner">
            <span>{live.error} — showing the last good read rather than a blank page.</span>
            <button className="btn" data-variant="micro" onClick={() => void live.refresh()}>
              retry
            </button>
          </div>
        )}
        {live.digest?.simulated && (
          <div className="banner">
            <span>
              NSE is shut, so prices come from the deterministic simulator and are labelled
              as such everywhere. Point <code>MARKET_PROVIDERS</code> at a real feed and
              nothing above this line changes.
            </span>
          </div>
        )}

        <div className="field">
          <div className="field-head">
            <span className="field-title">the field</span>
            <span className="field-note">
              unusualness across, significance up — the line across it is your threshold
            </span>
            <div className="field-stats">
              <span>
                watched <b>{all.length}</b>
              </span>
              <span>
                above <b>{attention.length}</b>
              </span>
              <span>
                peak <b>{fmtSigma(peakSigma)}</b>
              </span>
            </div>
          </div>
          <SigmaField
            attention={attention}
            quiet={quiet}
            quotes={live.quotes}
            threshold={threshold}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              document
                .querySelector(`[data-instrument="${id}"]`)
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}
          />
        </div>

        <div className="columns" style={{ marginTop: 6 }}>
          <div>
            <div className="section-rule" data-tone="tide">
              <span className="label">
                above the tide line · {threshold}
              </span>
            </div>

            {live.status === "loading" && <LoadingRows />}

            {live.status !== "loading" && attention.length === 0 && (
              <div className="nullstate">
                <h3>Quiet is the correct answer.</h3>
                <p>
                  Every name on your list moved inside its own normal range. The channels
                  below show each one and how far it got, so the silence reads as a
                  decision rather than a failure.
                </p>
              </div>
            )}

            {attention.map((e) => (
              <div key={e.instrumentId} data-instrument={e.instrumentId}>
                <SignalStrip
                  entry={e}
                  live={live.quotes[e.instrumentId]}
                  flash={live.flashes[e.instrumentId]}
                  selected={selected === e.instrumentId}
                  onMute={onMute}
                  onConviction={onConviction}
                  onRemove={onRemove}
                  onSelect={setSelected}
                />
              </div>
            ))}

            {quiet.length > 0 && (
              <>
                <div className="section-rule">
                  <span className="label">
                    considered and held back · {quiet.length}
                  </span>
                </div>
                <SubThreshold
                  entries={quiet}
                  quotes={live.quotes}
                  selected={selected}
                  onSelect={setSelected}
                />
              </>
            )}

            <div className="keys">
              <span>
                <kbd>j</kbd>
                <kbd>k</kbd> move
              </span>
              <span>
                <kbd>a</kbd> mark seen
              </span>
              <span>
                <kbd>m</kbd> mute
              </span>
              <span>
                <kbd>r</kbd> refresh
              </span>
              <span>
                <kbd>/</kbd> add a ticker
              </span>
            </div>
          </div>

          <aside className="rail">
            <div className="module">
              <div className="module-head">
                <span className="label">attention dial</span>
              </div>
              <div className="module-body">
                <span className="dial-readout num">{threshold}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={threshold}
                  onChange={(e) => setThresholdOverride(Number(e.target.value))}
                  onMouseUp={(e) =>
                    void live.setThreshold(Number((e.target as HTMLInputElement).value))
                  }
                  onTouchEnd={(e) =>
                    void live.setThreshold(Number((e.target as HTMLInputElement).value))
                  }
                  onKeyUp={(e) =>
                    void live.setThreshold(Number((e.target as HTMLInputElement).value))
                  }
                  aria-label="Attention threshold"
                />
                <p style={{ margin: 0 }}>
                  Where the tide line sits, on the field above. Lower it to be told more;
                  raise it to be told only about the extraordinary.
                </p>
              </div>
            </div>

            <div className="module">
              <div className="module-head">
                <span className="label">watchlist</span>
              </div>
              <div className="module-body">
                <AddInstrument
                  watchlistId={watchlistId}
                  onAdded={() => {
                    say("Added. It joins the hot polling tier immediately.");
                    void live.refresh();
                  }}
                  onError={say}
                />
              </div>
            </div>

            {live.user && <FeedRoom nonce={healthNonce} />}

            {live.user && (
              <ScenarioLab
                entries={all}
                onChanged={() => {
                  setHealthNonce((n) => n + 1);
                  setTimeout(() => void live.refresh(), 2500);
                }}
                onToast={say}
              />
            )}

            {live.user && (
              <DeviceHandoff
                handle={live.user.handle}
                onAdopted={() => window.location.reload()}
                onToast={say}
              />
            )}
          </aside>
        </div>
      </main>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

function LoadingRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="strip" style={{ height: 132 }}>
          <div className="gauge">
            <div className="skeleton" style={{ height: 22, width: 30 }} />
            <div className="skeleton" style={{ height: 4, width: 26 }} />
          </div>
          <div className="strip-main" style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <div className="skeleton" style={{ height: 14, width: "38%" }} />
            <div className="skeleton" style={{ height: 16, width: "72%" }} />
            <div className="skeleton" style={{ height: 22, width: "56%" }} />
          </div>
          <div className="strip-metrics">
            <div className="skeleton" style={{ height: 30 }} />
            <div className="skeleton" style={{ height: 30 }} />
          </div>
        </div>
      ))}
    </>
  );
}
