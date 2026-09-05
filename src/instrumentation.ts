/**
 * Process bootstrap.
 *
 * Next.js calls `register()` once per server process. Migrations, universe
 * seeding and the ingestion worker all start here so a single `npm run dev` or
 * one container is genuinely all that is required — no separate setup command
 * that a reviewer has to discover from a README before anything works.
 *
 * All three steps are idempotent and guarded, so running two instances is
 * safe: the migrator takes an advisory lock, the seed is an upsert, and the
 * worker claims instruments with FOR UPDATE SKIP LOCKED.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureMigrated } = await import("./server/db/migrate");
  const { ensureUniverseSeeded } = await import("./server/services/seed");
  const { startWorkerIfEnabled } = await import("./server/ingest/scheduler");
  const { refreshBaselines } = await import("./server/ingest/baselines");

  try {
    const migration = await ensureMigrated();
    if (migration.applied.length > 0) {
      console.log(`[boot] applied migrations: ${migration.applied.join(", ")}`);
    }
    const seed = await ensureUniverseSeeded();
    console.log(`[boot] universe ready (${seed.instruments} instruments)`);

    // Get a first batch of baselines in place before the worker starts, so the
    // very first digest is scored against real volatility rather than defaults.
    await refreshBaselines({ limit: 12 });

    startWorkerIfEnabled();
    console.log("[boot] ingestion worker started");
  } catch (err) {
    // A failed boot task must not take the web server down with it: the health
    // endpoint is more useful than a crash loop when something is misconfigured.
    console.error("[boot] startup task failed:", err);
  }
}
