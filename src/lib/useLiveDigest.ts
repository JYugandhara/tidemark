"use client";

/**
 * The client's view of the world.
 *
 * Three sources have to be reconciled here and the order matters:
 *
 *   1. `/api/digest` — the scored, ranked answer. Authoritative, but a
 *      snapshot.
 *   2. The SSE quote stream — high frequency, low meaning. Kept as an overlay
 *      on top of the digest so prices stay live without re-ranking the page
 *      under the reader's cursor every two seconds, which is exactly the
 *      twitchiness this product exists to avoid.
 *   3. SSE `change` events — meaning changed, so the ranking is stale.
 *      Debounced into a refetch rather than applied locally, because the
 *      scoring model lives on the server and should stay there.
 *
 * The stream is a native `EventSource`: it reconnects on its own and replays
 * `Last-Event-ID` for us. When the server says the replay buffer no longer
 * covers the gap, we refetch instead of pretending we are up to date.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DigestResponse } from "@/server/services/digest";
import { api, ApiClientError, type AckEntry, type SessionUserDTO } from "./api";

export interface LiveQuote {
  price: number;
  previousClose: number;
  volume: number | null;
  halted: boolean;
  asOf: number;
  provider: string;
}

export type StreamState = "connecting" | "open" | "closed";

export interface LiveDigest {
  status: "loading" | "ready" | "error";
  error: string | null;
  user: SessionUserDTO | null;
  digest: DigestResponse | null;
  quotes: Record<string, LiveQuote>;
  flashes: Record<string, "up" | "down">;
  streamState: StreamState;
  /**
   * Monotonic count of frames received on the stream. Nothing depends on the
   * value; the masthead trace uses the *increment* as its heartbeat, so the
   * instrument visibly moves when — and only when — data is actually arriving.
   */
  beat: number;
  /** Change events that arrived since the last refetch. */
  pendingChanges: number;
  lastRefreshedAt: number | null;
  refresh: () => Promise<void>;
  acknowledge: () => Promise<number>;
  setThreshold: (v: number) => Promise<void>;
  setUser: (u: SessionUserDTO) => void;
}

const REFRESH_DEBOUNCE_MS = 1_200;
const SAFETY_REFRESH_MS = 45_000;
/** How far a live price may drift from the scored price before we re-rank. */
const RESCORE_SIGMA_FRACTION = 0.35;
const FLASH_MS = 900;

export function useLiveDigest(): LiveDigest {
  const [status, setStatus] = useState<LiveDigest["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUserDTO | null>(null);
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [flashes, setFlashes] = useState<Record<string, "up" | "down">>({});
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [beat, setBeat] = useState(0);
  const [pendingChanges, setPendingChanges] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const d = await api.digest();
      setDigest(d);
      setPendingChanges(0);
      setLastRefreshedAt(Date.now());
      setError(null);
      setStatus("ready");
    } catch (err) {
      // A failed refresh must not blank the screen: the previous digest is
      // still the best information we have, so keep it and say so.
      const message =
        err instanceof ApiClientError ? err.message : "Could not reach the server";
      setError(message);
      setStatus((s) => (s === "loading" ? "error" : s));
    } finally {
      inFlight.current = false;
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  // Bootstrap: session first (it sets the cookie and seeds a starter list),
  // then the first digest.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.session();
        if (cancelled) return;
        setUser(s.user);
        await refresh();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not start a session");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Live stream.
  useEffect(() => {
    if (!user) return;
    const es = new EventSource("/api/stream");

    es.addEventListener("open", () => setStreamState("open"));
    es.addEventListener("error", () => setStreamState("connecting"));

    es.addEventListener("hello", (ev) => {
      setStreamState("open");
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { gap?: boolean };
        // We were away long enough that the replay buffer rolled over. Rather
        // than silently miss those events, go and get the truth.
        if (data.gap) void refresh();
      } catch {
        /* a malformed frame is not worth breaking the stream over */
      }
    });

    es.addEventListener("quote", (ev) => {
      try {
        const q = JSON.parse((ev as MessageEvent).data) as LiveQuote & { instrumentId: string };
        setBeat((b) => b + 1);
        setQuotes((prev) => {
          const before = prev[q.instrumentId];
          if (before && before.asOf > q.asOf) return prev; // ignore an out-of-order frame
          if (before && before.price !== q.price) {
            flash(q.instrumentId, q.price > before.price ? "up" : "down");
          }
          return { ...prev, [q.instrumentId]: q };
        });
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("change", () => {
      setBeat((b) => b + 1);
      setPendingChanges((n) => n + 1);
      scheduleRefresh();
    });

    return () => {
      es.close();
      setStreamState("closed");
    };

    function flash(id: string, dir: "up" | "down") {
      setFlashes((f) => ({ ...f, [id]: dir }));
      clearTimeout(flashTimers.current[id]);
      flashTimers.current[id] = setTimeout(() => {
        setFlashes((f) => {
          const next = { ...f };
          delete next[id];
          return next;
        });
      }, FLASH_MS);
    }
  }, [user, refresh, scheduleRefresh]);

  // The ranking is a snapshot, and it is only honest while the prices it was
  // scored from are still roughly true. A quote that has drifted a meaningful
  // fraction of its own daily sigma away from the scored price is a reason to
  // go and get a new digest — measured in sigmas, like everything else, so a
  // habitually violent name does not trigger a refetch every few seconds.
  useEffect(() => {
    if (!digest) return;
    const drifted = [...digest.attention, ...digest.quiet].some((e) => {
      const q = quotes[e.instrumentId];
      if (!q || e.price === null || e.price === 0) return false;
      const moved = Math.abs(q.price - e.price) / Math.abs(e.price);
      return moved > (e.dailySigmaPct / 100) * RESCORE_SIGMA_FRACTION;
    });
    if (drifted) scheduleRefresh();
  }, [quotes, digest, scheduleRefresh]);

  // Safety net: if the stream is wedged behind a proxy that eats SSE, the page
  // still stays roughly current.
  useEffect(() => {
    const t = setInterval(() => void refresh(), SAFETY_REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const timers = flashTimers.current;
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  const acknowledge = useCallback(async (): Promise<number> => {
    if (!digest) return 0;
    const all = [...digest.attention, ...digest.quiet];
    const entries: AckEntry[] = all.map((e) => {
      const live = quotes[e.instrumentId];
      const price = live?.price ?? e.price;
      const previousClose = live?.previousClose ?? e.previousClose;
      const dir: AckEntry["refDirection"] =
        price === null || previousClose === null || price === previousClose
          ? "flat"
          : price > previousClose
            ? "up"
            : "down";
      return {
        instrumentId: e.instrumentId,
        // Acknowledge the price that was actually on screen, not whatever the
        // server thinks is current a moment later.
        refPrice: price,
        refAsOf: live?.asOf ?? e.asOf,
        refDirection: dir,
        seq: e.eventSeqs.length ? Math.max(...e.eventSeqs) : 0,
        eventIds: e.eventIds,
      };
    });
    const res = await api.ack(entries);
    await refresh();
    return res.acknowledged;
  }, [digest, quotes, refresh]);

  const setThreshold = useCallback(
    async (v: number) => {
      const res = await api.settings(v);
      setUser(res.user);
      await refresh();
    },
    [refresh],
  );

  return useMemo(
    () => ({
      status,
      error,
      user,
      digest,
      quotes,
      flashes,
      streamState,
      beat,
      pendingChanges,
      lastRefreshedAt,
      refresh,
      acknowledge,
      setThreshold,
      setUser,
    }),
    [
      status,
      error,
      user,
      digest,
      quotes,
      flashes,
      streamState,
      beat,
      pendingChanges,
      lastRefreshedAt,
      refresh,
      acknowledge,
      setThreshold,
    ],
  );
}
