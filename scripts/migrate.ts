/** Apply pending SQL migrations. Usage: npm run db:migrate */
import { migrate } from "../src/server/db/migrate";
import { closePool } from "../src/server/db/client";

async function main() {
  const res = await migrate((m) => console.log(`[migrate] ${m}`));
  console.log(
    `[migrate] applied ${res.applied.length} (${res.applied.join(", ") || "none"}), ` +
      `already applied ${res.alreadyApplied.length}`,
  );
  await closePool();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
  void closePool();
});
