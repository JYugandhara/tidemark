"use client";

/**
 * The feed room.
 *
 * A product whose pitch is "we will be honest with you about data" has to be
 * willing to show its own plumbing. This panel is the health endpoint, made
 * legible: which upstreams are configured, whether their circuit breakers are
 * closed, how many instruments are in each polling tier, and whether the
 * session on screen is real or generated.
 *
 * It is also the fastest way for a sceptical reviewer to confirm that the
 * resilience machinery is real rather than described.
 */

import { useEffect, useState } from "react";
import { api, type HealthDTO } from "@/lib/api";

/** "closed" is correct breaker vocabulary and confusing next to a closed market. */
const BREAKER_LABEL: Record<string, string> = {
  closed: "healthy",
  open: "tripped",
  half_open: "probing",
};

export function FeedRoom({ nonce }: { nonce: number }) {
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const h = await api.health();
        if (alive) {
          setHealth(h);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const t = setInterval(load, 8_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [nonce]);

  if (failed && !health) {
    return (
      <div className="module">
        <div className="module-head">
          <span className="label">feed room</span>
        </div>
        <div className="module-body">
          <p>Cannot reach the server right now.</p>
        </div>
      </div>
    );
  }
  if (!health) {
    return (
      <div className="module">
        <div className="module-head">
          <span className="label">feed room</span>
        </div>
        <div className="module-body">
          <div className="skeleton" style={{ height: 96 }} />
        </div>
      </div>
    );
  }

  const tiers = Object.fromEntries(health.ingest.tiers.map((t) => [t.tier, t.n]));
  const worst =
    health.providers.breakers.find((b) => b.state === "open")?.state ??
    health.providers.breakers.find((b) => b.state === "half_open")?.state ??
    "closed";

  return (
    <div className="module">
      <div className="module-head">
        <span className="label">feed room</span>
        <span className="pill" data-s={worst} style={{ marginLeft: "auto" }}>
          {BREAKER_LABEL[worst] ?? worst}
        </span>
      </div>
      <div className="module-body">
      <p>
        {health.simulation.synthetic ? (
          <>
            The real market is shut, so prices come from the deterministic
            simulator (seed <span className="num">{health.simulation.seed}</span>). Everything
            downstream — scoring, dedup, alerts — runs exactly as it would on a
            live feed.
          </>
        ) : (
          <>Live session. {health.market.label}, {health.market.istTime} IST.</>
        )}
      </p>

      {health.providers.breakers.map((b) => (
        <div className="readrow" key={b.name}>
          <span>{b.name}</span>
          <span className="pill" data-s={b.state} title={`circuit breaker: ${b.state}`}>
            {BREAKER_LABEL[b.state] ?? b.state}
          </span>
        </div>
      ))}

      <div className="readrow">
        <span>db</span>
        <span>
          {health.database.ok ? "ok" : "down"} · {health.database.latencyMs}ms
        </span>
      </div>
      <div className="readrow">
        <span>polling</span>
        <span>
          {tiers.hot ?? 0} hot / {tiers.warm ?? 0} warm / {tiers.cold ?? 0} cold
        </span>
      </div>
      <div className="readrow">
        <span>worker</span>
        <span>
          {health.ingest.worker.running ? "running" : "stopped"} · tick{" "}
          {health.ingest.worker.ticks}
        </span>
      </div>
      <div className="readrow">
        <span>events / hr</span>
        <span>{health.ingest.eventsLastHour}</span>
      </div>
      <div className="readrow">
        <span>stream</span>
        <span>
          {health.stream.subscribers} open · id {health.stream.lastEventId}
        </span>
      </div>

      {health.providers.persisted.some((p) => p.last_error) && (
        <p style={{ marginTop: 10, color: "var(--accent)" }}>
          Last upstream error:{" "}
          {health.providers.persisted.find((p) => p.last_error)?.last_error}
        </p>
      )}
      </div>
    </div>
  );
}
