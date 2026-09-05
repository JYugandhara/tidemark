/**
 * Postgres access.
 *
 * Hand-written SQL over `pg` rather than an ORM. The queries that matter in
 * this system — a conditional upsert that enforces monotonic timestamps, an
 * `ON CONFLICT DO UPDATE` that carries escalation logic, an advisory lock —
 * are the ones ORMs express worst, and they are the ones worth reading.
 */

import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import { config, isProd } from "../config";

// `pg` returns bigint and numeric as strings to avoid precision loss. Our
// bigints are sequence numbers well inside Number.MAX_SAFE_INTEGER, and our
// numerics are prices; parsing them here keeps the rest of the code honest
// about types instead of sprinkling Number() at every call site.
types.setTypeParser(20, (v) => Number(v)); // int8
types.setTypeParser(1700, (v) => Number(v)); // numeric

declare global {
  // Next.js hot-reloads modules in development; without this the pool is
  // recreated on every edit until Postgres runs out of connections.
  var __tidemarkPool: Pool | undefined;
}

function createPool(): Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.PGSSL ? { rejectUnauthorized: false } : undefined,
    // Sized so the read path (four concurrent queries) does not queue behind
    // itself under load. Postgres handles far more, but a bounded pool is what
    // keeps a bad minute from turning into connection exhaustion.
    max: isProd ? 24 : 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    // Any single statement that runs longer than this is a bug, not a slow day.
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
  pool.on("error", (err) => {
    // An idle client erroring out is normal (server restart, network blip).
    // Log and let the pool replace it rather than crashing the process.
    console.error("[db] idle client error:", err.message);
  });
  return pool;
}

/**
 * The pool is created on first use, not at import time. Importing a module
 * that transitively touches the database — a provider, a scoring helper —
 * should not open sockets, which keeps unit tests hermetic and keeps the
 * Next.js build from connecting to Postgres while collecting page data.
 */
export function getPool(): Pool {
  globalThis.__tidemarkPool ??= createPool();
  return globalThis.__tidemarkPool;
}

export type SqlValue = string | number | boolean | Date | null | undefined | object;

export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly SqlValue[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as unknown[]);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly SqlValue[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function execute(
  text: string,
  params: readonly SqlValue[] = [],
): Promise<number> {
  const res = await getPool().query(text, params as unknown[]);
  return res.rowCount ?? 0;
}

export interface Tx {
  query<T extends QueryResultRow>(text: string, params?: readonly SqlValue[]): Promise<T[]>;
  queryOne<T extends QueryResultRow>(
    text: string,
    params?: readonly SqlValue[],
  ): Promise<T | null>;
  execute(text: string, params?: readonly SqlValue[]): Promise<number>;
  client: PoolClient;
}

/**
 * Run `fn` inside a transaction. Rolls back on any throw, and always releases
 * the client — including when the rollback itself fails, which is the case
 * that leaks connections in most hand-rolled versions of this helper.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const tx: Tx = {
    client,
    async query<R extends QueryResultRow>(text: string, params: readonly SqlValue[] = []) {
      const r = await client.query<R>(text, params as unknown[]);
      return r.rows;
    },
    async queryOne<R extends QueryResultRow>(
      text: string,
      params: readonly SqlValue[] = [],
    ): Promise<R | null> {
      const r = await client.query<R>(text, params as unknown[]);
      return r.rows[0] ?? null;
    },
    async execute(text: string, params: readonly SqlValue[] = []) {
      const r = await client.query(text, params as unknown[]);
      return r.rowCount ?? 0;
    },
  };

  try {
    await client.query("BEGIN");
    const out = await fn(tx);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[db] rollback failed:", rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transaction-scoped advisory lock.
 *
 * Used so exactly one worker processes a given instrument at a time. Returns
 * false immediately if someone else holds it, rather than queueing: for a
 * poller, skipping this tick is strictly better than piling up.
 */
export async function tryAdvisoryLock(tx: Tx, key: string): Promise<boolean> {
  const row = await tx.queryOne<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
    [key],
  );
  return row?.locked === true;
}

export async function healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function closePool(): Promise<void> {
  if (globalThis.__tidemarkPool) {
    await globalThis.__tidemarkPool.end();
    globalThis.__tidemarkPool = undefined;
  }
}
