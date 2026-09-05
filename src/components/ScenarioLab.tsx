"use client";

/**
 * The scenario lab.
 *
 * Buttons that break things on purpose. Each one writes a row to the
 * `scenarios` table; the provider applies it at the edge and nothing
 * downstream is aware it is being tested. That is the point — what you watch
 * happen next is not a demo mode, it is the production path meeting a fault.
 *
 * Injecting a halt, a decimal-point error or a silent feed and watching the
 * digest respond is a far better argument for the resilience work than any
 * paragraph about it.
 */

import { useEffect, useState } from "react";
import { api, type ScenarioDTO } from "@/lib/api";
import { useNow } from "@/lib/useNow";
import type { DigestEntryDTO } from "@/server/services/digest";

interface Props {
  entries: DigestEntryDTO[];
  onChanged: () => void;
  onToast: (m: string) => void;
}

const FAULTS: Array<{
  kind: string;
  label: string;
  hint: string;
  params?: Record<string, unknown>;
  global?: boolean;
}> = [
  { kind: "spike", label: "Sudden move", hint: "+4% over 20 seconds", params: { pct: 4, rampMs: 20_000 } },
  { kind: "halt", label: "Trading halt", hint: "exchange stops the stock" },
  { kind: "circuit", label: "Upper circuit", hint: "pinned at the band", params: { side: "upper" } },
  { kind: "volume_surge", label: "Volume surge", hint: "6× normal for the time of day", params: { factor: 6 } },
  { kind: "stale", label: "Feed goes silent", hint: "no prints at all" },
  { kind: "bad_print", label: "Decimal error", hint: "price arrives 10× too low", params: { factor: 0.1 } },
  { kind: "latency", label: "Slow upstream", hint: "1.5s added per call", params: { ms: 1500 }, global: true },
  { kind: "provider_outage", label: "Provider down", hint: "trips the circuit breaker", global: true },
];

export function ScenarioLab({ entries, onChanged, onToast }: Props) {
  const [chosen, setChosen] = useState<string>("");
  const [active, setActive] = useState<ScenarioDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const now = useNow(1_000);

  // The list of live faults is external state we subscribe to. Bumping
  // `reloadNonce` is how an action asks for an immediate re-read without a
  // second code path that also writes state.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const res = await api.scenarios();
        if (alive) setActive(res.scenarios);
      } catch {
        /* the lab is optional; never let it break the page */
      }
    };
    void read();
    const t = setInterval(read, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [reloadNonce]);

  const reload = () => setReloadNonce((n) => n + 1);

  // Derived so an empty selection falls back to the first entry without a
  // state write inside an effect.
  const target = chosen || entries[0]?.instrumentId || "";

  async function inject(f: (typeof FAULTS)[number]) {
    setBusy(true);
    try {
      await api.createScenario({
        kind: f.kind,
        instrumentId: f.global ? null : target,
        params: f.params ?? {},
        ttlSeconds: 120,
      });
      const who = f.global ? "the feed" : entries.find((e) => e.instrumentId === target)?.symbol;
      onToast(`Injected: ${f.label} on ${who}. Watch the next poll.`);
      reload();
      onChanged();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Could not inject that scenario");
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    setBusy(true);
    try {
      await Promise.all(active.map((s) => api.clearScenario(s.id)));
      onToast("Faults cleared. The feed recovers on the next poll.");
      reload();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="module">
      <div className="module-head">
        <span className="label">break something</span>
        {active.length > 0 && (
          <span className="pill" data-s="open" style={{ marginLeft: "auto" }}>
            {active.length} live
          </span>
        )}
      </div>
      <div className="module-body">
      <p>
        These write a real fault into the feed. Ingestion has no idea it is a
        test, so what happens next is what would happen at 2pm on a bad
        Wednesday.
      </p>

      <select
        className="input"
        value={target}
        onChange={(e) => setChosen(e.target.value)}
        aria-label="Instrument to disrupt"
        style={{ marginBottom: 10 }}
      >
        {entries.map((e) => (
          <option key={e.instrumentId} value={e.instrumentId}>
            {e.symbol} — {e.name}
          </option>
        ))}
      </select>

      <div className="btn-grid">
        {FAULTS.map((f) => (
          <button
            key={f.kind}
            className="btn"
            disabled={busy || (!f.global && !target)}
            title={f.hint}
            onClick={() => void inject(f)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {active.length > 0 && (
        <>
          <div style={{ marginTop: 12 }}>
            {active.map((s) => (
              <div className="readrow" key={s.id}>
                <span>
                  {s.kind}
                  {s.symbol ? ` · ${s.symbol}` : " · all"}
                </span>
                <span>{Math.max(0, Math.round((s.expiresAt - now) / 1000))}s</span>
              </div>
            ))}
          </div>
          <button
            className="btn"
            data-variant="primary"
            style={{ marginTop: 10, width: "100%" }}
            onClick={() => void clearAll()}
            disabled={busy}
          >
            Clear all faults
          </button>
        </>
      )}
      </div>
    </div>
  );
}
