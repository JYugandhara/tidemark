/** Seed the instrument universe and build baselines. Idempotent. */

import { migrate } from "../src/server/db/migrate";
import { closePool } from "../src/server/db/client";
import { ensureUniverseSeeded } from "../src/server/services/seed";
import { refreshBaselines } from "../src/server/ingest/baselines";

async function main() {
  await migrate((m: string) => console.log(`[migrate] ${m}`));
  const seed = await ensureUniverseSeeded();
  console.log(
    `[seed] ${seed.instruments} instruments, ${seed.corporateActions} corporate actions`,
  );

  console.log("[seed] building baselines (this backfills a year of daily bars)...");
  const startedAt = Date.now();
  let total = 0;
  // Refresh anything not already computed during *this* run, so the loop
  // terminates as soon as the universe is covered instead of churning.
  for (let round = 0; round < 200; round++) {
    const ageHours = (Date.now() - startedAt) / 3_600_000;
    const res = await refreshBaselines({ limit: 8, maxAgeHours: ageHours });
    total += res.refreshed;
    for (const f of res.failures) console.warn(`[seed] ${f.symbol}: ${f.error}`);
    if (res.refreshed === 0 && res.failures.length === 0) break;
    process.stdout.write(`  ${total} baselines\r`);
  }
  console.log(`\n[seed] ${total} baselines computed`);
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await closePool();
});
