/**
 * Load test for the read path.
 *
 * The claim this is here to check is the scaling argument: because polling is
 * fanned in by instrument, adding readers should cost the *read* path only,
 * and the read path is four indexed queries plus arithmetic. So the experiment
 * is: create N independent workspaces, give each a watchlist, then hammer
 * /api/digest and watch what the latency distribution does.
 *
 *   npm run loadtest -- --users 50 --concurrency 25 --seconds 20
 */

const BASE = process.env.LOADTEST_BASE_URL ?? "http://localhost:3000";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const USERS = arg("users", 25);
const CONCURRENCY = arg("concurrency", 20);
const SECONDS = arg("seconds", 15);
const EXTRA_SYMBOLS = ["INFY", "SBIN", "LT", "ITC", "MARUTI", "WIPRO", "BEL", "HAL", "NTPC", "ONGC"];

interface Session {
  cookie: string;
  watchlistId: string;
}

async function createSession(index: number): Promise<Session | null> {
  const res = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const cookie = setCookie.split(";")[0];

  const lists = await (await fetch(`${BASE}/api/watchlists`, { headers: { cookie } })).json();
  const watchlistId: string | undefined = lists.watchlists?.[0]?.id;
  if (!watchlistId) return null;

  // Widen the list a little so the digest is doing real work per request.
  const extras = EXTRA_SYMBOLS.slice(0, 3 + (index % 6));
  await Promise.all(
    extras.map((symbol) =>
      fetch(`${BASE}/api/watchlists/${watchlistId}/items`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ symbol }),
      }).catch(() => null),
    ),
  );
  return { cookie, watchlistId };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main() {
  console.log(
    `\nLoad test → ${BASE}\n  users=${USERS} concurrency=${CONCURRENCY} duration=${SECONDS}s\n`,
  );

  process.stdout.write("  provisioning workspaces… ");
  const sessions: Session[] = [];
  for (let i = 0; i < USERS; i++) {
    const s = await createSession(i);
    if (s) sessions.push(s);
  }
  console.log(`${sessions.length} ready`);
  if (sessions.length === 0) {
    console.error("could not create any sessions — is the server running?");
    process.exit(1);
  }

  // Let the worker pick up the newly-subscribed instruments before measuring.
  process.stdout.write("  warming the ingest rotation… ");
  await new Promise((r) => setTimeout(r, 6_000));
  console.log("done\n");

  const latencies: number[] = [];
  let ok = 0;
  let failed = 0;
  let bytes = 0;
  const deadline = Date.now() + SECONDS * 1000;

  async function worker(id: number) {
    let i = id;
    while (Date.now() < deadline) {
      const s = sessions[i % sessions.length];
      i += CONCURRENCY;
      const started = performance.now();
      try {
        const res = await fetch(`${BASE}/api/digest`, { headers: { cookie: s.cookie } });
        const body = await res.text();
        bytes += body.length;
        if (res.ok) {
          latencies.push(performance.now() - started);
          ok += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const elapsed = (Date.now() - started) / 1000;

  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  console.log("  results");
  console.log(`    requests        ${ok} ok, ${failed} failed`);
  console.log(`    throughput      ${(ok / elapsed).toFixed(1)} digests/sec`);
  console.log(`    payload         ${(bytes / ok / 1024).toFixed(1)} KB average`);
  console.log(`    latency  mean   ${mean.toFixed(1)} ms`);
  console.log(`             p50    ${percentile(latencies, 50).toFixed(1)} ms`);
  console.log(`             p95    ${percentile(latencies, 95).toFixed(1)} ms`);
  console.log(`             p99    ${percentile(latencies, 99).toFixed(1)} ms`);
  console.log(`             max    ${(latencies.at(-1) ?? 0).toFixed(1)} ms`);

  try {
    const health = await (await fetch(`${BASE}/api/health`)).json();
    const tiers = health.ingest?.tiers ?? [];
    console.log(
      `\n  ingest tiers    ${tiers.map((t: { tier: string; n: number }) => `${t.n} ${t.tier}`).join(", ")}`,
    );
    console.log(`  worker ticks    ${health.ingest?.worker?.ticks}`);
    console.log(
      `  note            polling cost is per instrument, so ${sessions.length} readers`,
    );
    console.log(
      `                  share the same ${tiers.reduce((a: number, t: { n: number }) => a + t.n, 0)} polled symbols.\n`,
    );
  } catch {
    console.log("");
  }

  process.exit(failed > ok * 0.01 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
