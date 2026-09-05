/**
 * Standalone ingestion worker.
 *
 * Run this when the worker should scale separately from the web tier
 * (RUN_WORKER_IN_WEB=false). Several copies can run at once: instruments are
 * claimed with FOR UPDATE SKIP LOCKED and each one is processed under an
 * advisory lock, so adding a worker adds throughput rather than duplicates.
 */

import { migrate } from "../src/server/db/migrate";
import { closePool } from "../src/server/db/client";
import { ensureUniverseSeeded } from "../src/server/services/seed";
import { refreshBaselines } from "../src/server/ingest/baselines";
import { worker } from "../src/server/ingest/scheduler";

async function main() {
  await migrate((m: string) => console.log(`[migrate] ${m}`));
  const seed = await ensureUniverseSeeded();
  console.log(`[worker] universe ready (${seed.instruments} instruments)`);
  await refreshBaselines({ limit: 20 });

  const w = worker();
  w.start();
  console.log("[worker] running — Ctrl-C to stop");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[worker] ${signal} received, stopping cleanly`);
    w.stop();
    // Give an in-flight tick a moment to finish its transaction.
    await new Promise((r) => setTimeout(r, 500));
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  setInterval(() => {
    const s = w.snapshot();
    console.log(
      `[worker] tick=${s.ticks} due=${s.instrumentsDue} ` +
        `accepted=${s.lastReport?.quotesAccepted ?? 0} ` +
        `events=+${s.lastReport?.eventsCreated ?? 0}/~${s.lastReport?.eventsUpdated ?? 0} ` +
        `errors=${s.errors}`,
    );
  }, 15_000);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
