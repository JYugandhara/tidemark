/**
 * Migration runner.
 *
 * Plain `.sql` files applied in filename order, each in its own transaction,
 * with the whole run guarded by a session advisory lock so that two instances
 * booting at the same moment (rolling deploy, `next dev` plus the worker)
 * cannot race each other into a half-applied schema.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getPool } from "./client";

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");
const LOCK_KEY = 0x7164_6d6b; // "tdmk"

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(log: (m: string) => void = () => {}): Promise<MigrationResult> {
  const client = await getPool().connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM _migrations",
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 32);
      const previous = seen.get(file);

      if (previous) {
        if (previous !== checksum) {
          // Silently running a changed migration is how environments drift.
          throw new Error(
            `Migration ${file} has changed since it was applied. ` +
              `Add a new migration instead of editing an applied one.`,
          );
        }
        alreadyApplied.push(file);
        continue;
      }

      log(`applying ${file}`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [
          file,
          checksum,
        ]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(
          `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { applied, alreadyApplied };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** Idempotent, safe to call from multiple entrypoints; runs at most once. */
let migrationPromise: Promise<MigrationResult> | null = null;
export function ensureMigrated(): Promise<MigrationResult> {
  migrationPromise ??= migrate((m) => console.log(`[migrate] ${m}`));
  return migrationPromise;
}
