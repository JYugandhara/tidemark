/**
 * Drop every table this app owns and re-migrate.
 *
 * Refuses to run against a database whose URL does not look local unless
 * ALLOW_DESTRUCTIVE=1 is set — the one guard that stops a muscle-memory
 * `npm run db:reset` from being the worst thirty seconds of someone's week.
 */

import { execute, closePool } from "../src/server/db/client";
import { migrate } from "../src/server/db/migrate";
import { config } from "../src/server/config";

const LOCAL = /(localhost|127\.0\.0\.1|::1)/;

async function main() {
  if (!LOCAL.test(config.DATABASE_URL) && process.env.ALLOW_DESTRUCTIVE !== "1") {
    console.error(
      "[reset] refusing: DATABASE_URL does not look local. Set ALLOW_DESTRUCTIVE=1 to override.",
    );
    process.exitCode = 1;
    return;
  }
  await execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  console.log("[reset] schema dropped");
  const res = await migrate((m) => console.log(`[migrate] ${m}`));
  console.log(`[reset] re-applied ${res.applied.length} migrations`);
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await closePool();
});
