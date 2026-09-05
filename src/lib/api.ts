/**
 * Typed client for the JSON API.
 *
 * Every call goes through one function so error handling is uniform: the
 * server's `{ error: { code, message, details } }` envelope becomes an
 * `ApiClientError` the UI can branch on — in particular a 409, which carries
 * the current server state and is the difference between "your edit was lost"
 * and "the other device won, here is what it says".
 */

import type { DigestResponse } from "@/server/services/digest";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  /** For a 409, the server's current version of the thing you tried to edit. */
  get current(): unknown {
    return (this.details as { current?: unknown } | undefined)?.current;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? "unknown",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return body as T;
}

export interface SessionUserDTO {
  id: string;
  handle: string;
  attentionThreshold: number;
  lastCheckedAt: number;
}

export interface WatchlistItemDTO {
  id: string;
  watchlistId: string;
  instrumentId: string;
  symbol: string;
  name: string;
  sector: string | null;
  conviction: "core" | "tracking" | "background";
  mutedUntil: number | null;
  position: number;
  note: string | null;
  version: number;
}

export interface WatchlistDTO {
  id: string;
  name: string;
  position: number;
  version: number;
  items: WatchlistItemDTO[];
}

export interface SearchResultDTO {
  id: string;
  symbol: string;
  name: string;
  sector: string | null;
  exchange: string;
  dailySigmaPct: number;
}

export interface HealthDTO {
  status: string;
  now: number;
  market: { phase: string; label: string; istTime: string };
  simulation: {
    active: boolean;
    synthetic: boolean;
    sessionDate: string;
    minuteOfSession: number;
    seed: number;
  };
  database: { ok: boolean; latencyMs: number };
  providers: {
    configured: string[];
    breakers: Array<{ name: string; state: string; failures: number; tokensAvailable: number }>;
    persisted: Array<{
      provider: string;
      state: string;
      calls: number;
      failures: number;
      last_error: string | null;
    }>;
  };
  ingest: {
    worker: { ticks: number; running: boolean; instrumentsDue: number; errors: number };
    tiers: Array<{ tier: string; n: number; stale: number }>;
    eventsLastHour: number;
  };
  stream: { subscribers: number; lastEventId: number };
}

export interface ScenarioDTO {
  id: string;
  kind: string;
  symbol: string | null;
  params: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

export const api = {
  session: () =>
    request<{ user: SessionUserDTO; isNew: boolean; devices: Array<{ id: string; label: string }> }>(
      "/api/session",
      {
        method: "POST",
        body: JSON.stringify({ deviceLabel: describeDevice() }),
      },
    ),

  digest: () => request<DigestResponse>("/api/digest"),

  ack: (entries: AckEntry[]) =>
    request<{ acknowledged: number; watermarks: number; boundary: number }>("/api/digest/ack", {
      method: "POST",
      body: JSON.stringify({ entries }),
    }),

  watchlists: () => request<{ watchlists: WatchlistDTO[] }>("/api/watchlists"),

  addItem: (watchlistId: string, body: { symbol?: string; instrumentId?: string }) =>
    request<{ item: WatchlistItemDTO }>(`/api/watchlists/${watchlistId}/items`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  removeItem: (itemId: string) =>
    request<{ deleted: boolean }>(`/api/items/${itemId}`, { method: "DELETE" }),

  patchItem: (
    itemId: string,
    patch: { conviction?: string; mutedUntil?: number | null; version: number },
  ) =>
    request<{ item: WatchlistItemDTO }>(`/api/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  search: (q: string) =>
    request<{ results: SearchResultDTO[] }>(`/api/instruments/search?q=${encodeURIComponent(q)}`),

  instrument: (id: string) => request<InstrumentDetailDTO>(`/api/instruments/${id}`),

  health: () => request<HealthDTO>("/api/health"),

  settings: (attentionThreshold: number) =>
    request<{ user: SessionUserDTO }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ attentionThreshold }),
    }),

  scenarios: () => request<{ scenarios: ScenarioDTO[] }>("/api/scenarios"),

  createScenario: (body: {
    kind: string;
    instrumentId?: string | null;
    params?: Record<string, unknown>;
    ttlSeconds?: number;
  }) => request<{ id: string; expiresAt: number }>("/api/scenarios", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  clearScenario: (id: string) =>
    request<{ deleted: boolean }>(`/api/scenarios/${id}`, { method: "DELETE" }),

  handoff: () =>
    request<{ code: string; expiresAt: number; validForSeconds: number }>("/api/session/handoff", {
      method: "POST",
    }),

  adopt: (code: string) =>
    request<{ user: SessionUserDTO }>("/api/session/adopt", {
      method: "POST",
      body: JSON.stringify({ code, deviceLabel: describeDevice() }),
    }),
};

export interface AckEntry {
  instrumentId: string;
  refPrice: number | null;
  refAsOf: number | null;
  refDirection: "up" | "down" | "flat";
  seq: number;
  eventIds: string[];
}

export interface InstrumentDetailDTO {
  instrument: { id: string; symbol: string; name: string; sector: string | null };
  baseline: {
    dailySigmaPct: number;
    sampleSize: number;
    typicalDailyVolume: number | null;
    high52w: number | null;
    low52w: number | null;
  };
  quote: {
    price: number;
    previousClose: number;
    volume: number | null;
    freshness: string;
    ageLabel: string;
    provider: string;
  } | null;
  bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  tape: Array<{ t: number; p: number }>;
  events: Array<{
    id: string;
    kind: string;
    headline: string;
    magnitude: number;
    firstSeenAt: number;
  }>;
}

function describeDevice(): string {
  if (typeof navigator === "undefined") return "unknown device";
  const ua = navigator.userAgent;
  const platform =
    /iPhone|iPad|Android/i.exec(ua)?.[0] ??
    /Mac|Windows|Linux/i.exec(ua)?.[0] ??
    "device";
  const browser = /Firefox|Edg|Chrome|Safari/i.exec(ua)?.[0] ?? "browser";
  return `${platform} · ${browser}`;
}
