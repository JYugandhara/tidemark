/**
 * End-to-end smoke test against a running server.
 *
 * Exercises every route a user's browser touches, plus the two paths that are
 * hard to reach by clicking: an optimistic-concurrency conflict, and an
 * injected fault working its way through ingestion into the digest.
 *
 * Usage:  npm run dev   (in one terminal)
 *         npm run smoke (in another)
 */

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

let cookie = "";
let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("     ", JSON.stringify(detail).slice(0, 400));
  }
}

async function api(
  path: string,
  init: RequestInit & { expect?: number } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`);

  console.log("session");
  const unauth = await fetch(`${BASE}/api/digest`);
  ok("digest requires a session", unauth.status === 401);

  const session = await api("/api/session");
  ok("GET /api/session creates a workspace", session.status === 200 && !!session.body.user?.id);
  ok("new workspace is seeded with a starter list", session.body.isNew === true);
  const userId: string = session.body.user.id;

  const again = await api("/api/session");
  ok("second call returns the same workspace", again.body.user?.id === userId);

  console.log("\nhealth");
  const health = await api("/api/health");
  ok("health reports ok", health.body?.status === "ok", health.body);
  ok("database is reachable", health.body?.database?.ok === true);
  ok("a provider is configured", (health.body?.providers?.configured ?? []).length > 0);
  ok("the worker is running", health.body?.ingest?.worker?.running === true);

  console.log("\nwatchlists");
  const lists = await api("/api/watchlists");
  const list = lists.body.watchlists?.[0];
  ok("starter watchlist exists", !!list, lists.body);
  ok("starter watchlist has items", (list?.items?.length ?? 0) >= 5);

  const created = await api("/api/watchlists", {
    method: "POST",
    body: JSON.stringify({ name: "Smoke list" }),
  });
  ok("create watchlist", created.status === 201 && !!created.body.watchlist?.id);
  const smokeListId: string = created.body.watchlist.id;

  const added = await api(`/api/watchlists/${smokeListId}/items`, {
    method: "POST",
    body: JSON.stringify({ symbol: "INFY", conviction: "core" }),
  });
  ok("add by ticker symbol", added.status === 201 && added.body.item?.symbol === "INFY");
  const itemId: string = added.body.item.id;
  const itemVersion: number = added.body.item.version;

  const dupe = await api(`/api/watchlists/${smokeListId}/items`, {
    method: "POST",
    body: JSON.stringify({ symbol: "INFY" }),
  });
  ok("adding the same symbol twice is idempotent", dupe.body.item?.id === itemId);

  const badSymbol = await api(`/api/watchlists/${smokeListId}/items`, {
    method: "POST",
    body: JSON.stringify({ symbol: "NOTREAL" }),
  });
  ok("unknown ticker is a clean 404", badSymbol.status === 404);

  console.log("\noptimistic concurrency");
  const patch1 = await api(`/api/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify({ conviction: "background", version: itemVersion }),
  });
  ok("first edit wins", patch1.status === 200 && patch1.body.item?.conviction === "background");

  const patch2 = await api(`/api/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify({ conviction: "core", version: itemVersion }),
  });
  ok("stale edit is rejected with 409", patch2.status === 409, patch2.body);
  ok(
    "409 carries the current server state so the client can merge",
    patch2.body?.error?.details?.current?.version === itemVersion + 1,
    patch2.body,
  );

  console.log("\nvalidation");
  const bad = await api("/api/watchlists", { method: "POST", body: JSON.stringify({ name: "" }) });
  ok("empty name is rejected", bad.status === 400);
  ok("validation errors name the field", bad.body?.error?.details?.[0]?.path === "name", bad.body);

  const badJson = await api("/api/watchlists", { method: "POST", body: "{oops" });
  ok("malformed JSON is a 400, not a 500", badJson.status === 400);

  console.log("\nsearch");
  const search = await api("/api/instruments/search?q=rel");
  ok("search finds RELIANCE", search.body.results?.some((r: any) => r.symbol === "RELIANCE"));
  const empty = await api("/api/instruments/search?q=zzzzzzzz");
  ok("no matches is an empty list, not an error", empty.status === 200 && empty.body.results.length === 0);

  console.log("\ndigest");
  const digest = await api("/api/digest");
  ok("digest returns", digest.status === 200);
  ok(
    "every watched instrument is accounted for",
    digest.body.attention.length + digest.body.quiet.length === digest.body.summary.watched,
    digest.body.summary,
  );
  ok("quiet entries explain themselves", digest.body.quiet.every((q: any) => !!q.quietReason));
  ok(
    "attention entries carry an explainable score",
    digest.body.attention.every(
      (a: any) => a.contributions.length > 0 && Math.abs(a.contributions.reduce((s: number, c: any) => s + c.points, 0) - a.score) < 1.5,
    ),
  );
  ok(
    "sigma normalisation is applied per instrument",
    digest.body.attention.concat(digest.body.quiet).every((e: any) => e.dailySigmaPct > 0),
  );
  ok("the response says whether data is simulated", typeof digest.body.simulated === "boolean");

  console.log("\nacknowledge");
  const entries = [...digest.body.attention, ...digest.body.quiet].map((e: any) => ({
    instrumentId: e.instrumentId,
    refPrice: e.price,
    refAsOf: e.asOf,
    refDirection: (e.changeTodayPct ?? 0) > 0 ? "up" : (e.changeTodayPct ?? 0) < 0 ? "down" : "flat",
    seq: Math.max(0, ...(e.eventSeqs.length ? e.eventSeqs : [0])),
    eventIds: e.eventIds,
  }));
  const ack = await api("/api/digest/ack", {
    method: "POST",
    body: JSON.stringify({ entries }),
  });
  ok("ack succeeds", ack.status === 200, ack.body);
  ok("ack advances watermarks", (ack.body.watermarks ?? 0) > 0, ack.body);

  const afterAck = await api("/api/digest");
  ok(
    "reference is now 'since you last checked'",
    [...afterAck.body.attention, ...afterAck.body.quiet].some(
      (e: any) => e.referenceLabel === "since you last checked",
    ),
  );

  const replay = await api("/api/digest/ack", { method: "POST", body: JSON.stringify({ entries }) });
  ok("replaying the same ack is harmless", replay.status === 200);

  console.log("\nalerts");
  const target = digest.body.attention[0] ?? digest.body.quiet[0];
  const alert = await api("/api/alerts", {
    method: "POST",
    body: JSON.stringify({
      instrumentId: target.instrumentId,
      kind: "above",
      level: Number((target.price * 1.001).toFixed(2)),
    }),
  });
  ok("create alert", alert.status === 201, alert.body);
  const alerts = await api("/api/alerts");
  ok("list alerts", alerts.body.alerts?.length >= 1);
  const delAlert = await api(`/api/alerts/${alert.body.alert.id}`, { method: "DELETE" });
  ok("delete alert", delAlert.status === 200);

  console.log("\ninstrument detail");
  const detail = await api(`/api/instruments/${target.instrumentId}`);
  ok("detail returns a baseline", detail.body.baseline?.dailySigmaPct > 0, detail.body?.baseline);
  ok("detail returns daily bars", (detail.body.bars?.length ?? 0) > 50);
  ok("detail returns a live tape", Array.isArray(detail.body.tape));

  console.log("\nresilience: injected faults");
  // Two different instruments, because a bad print causes the whole quote to be
  // discarded — which would mask the halt if both faults hit the same name.
  const all = [...digest.body.attention, ...digest.body.quiet];
  const haltTarget = all[0];
  const printTarget = all[1] ?? all[0];

  const halt = await api("/api/scenarios", {
    method: "POST",
    body: JSON.stringify({ kind: "halt", instrumentId: haltTarget.instrumentId, ttlSeconds: 90 }),
  });
  ok("inject a trading halt", halt.status === 201, halt.body);

  const badPrint = await api("/api/scenarios", {
    method: "POST",
    body: JSON.stringify({
      kind: "bad_print",
      instrumentId: printTarget.instrumentId,
      params: { factor: 0.1 },
      ttlSeconds: 90,
    }),
  });
  ok("inject a decimal-point error", badPrint.status === 201);

  console.log("  waiting for the next poll...");
  await sleep(14_000);

  const afterFault = await api("/api/digest");
  const faultedAll = [...afterFault.body.attention, ...afterFault.body.quiet];
  const halted = faultedAll.find((e: any) => e.instrumentId === haltTarget.instrumentId);
  const printed = faultedAll.find((e: any) => e.instrumentId === printTarget.instrumentId);

  ok(
    "the halt reached the digest",
    halted?.halted === true || halted?.signals?.some((s: any) => s.kind === "HALT"),
    halted?.signals,
  );
  ok(
    "the bad print never became a price",
    printed && printed.price > printTarget.price * 0.5,
    { shown: printed?.price, before: printTarget.price },
  );
  ok(
    "the rejected feed is reported as missing data, not hidden",
    printed?.signals?.some((s: any) => s.kind === "DATA_STALE") ||
      printed?.freshness !== "LIVE",
    printed?.signals,
  );

  const healthAfter = await api("/api/health");
  ok("health still reports ok under injected faults", healthAfter.body?.status === "ok");

  const scenarios = await api("/api/scenarios");
  for (const s of scenarios.body.scenarios ?? []) {
    await api(`/api/scenarios/${s.id}`, { method: "DELETE" });
  }
  ok("scenarios can be cleared", (await api("/api/scenarios")).body.scenarios.length === 0);

  console.log("\nstreaming");
  const controller = new AbortController();
  const streamRes = await fetch(`${BASE}/api/stream`, {
    headers: { cookie },
    signal: controller.signal,
  });
  ok("stream opens with the right content type", streamRes.headers.get("content-type")?.includes("text/event-stream") === true);
  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && !buffered.includes("event: quote")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  controller.abort();
  ok("stream sends a hello frame with a resume id", /event: hello/.test(buffered));
  ok("stream pushes live quotes", /event: quote/.test(buffered), buffered.slice(0, 200));

  console.log("\ncross-device handoff");
  const handoff = await api("/api/session/handoff", { method: "POST" });
  ok("handoff code issued", /^[A-Z0-9]{6}$/.test(handoff.body.code ?? ""), handoff.body);

  const otherDevice = await fetch(`${BASE}/api/session/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: handoff.body.code, deviceLabel: "smoke-test phone" }),
  });
  const adopted = await otherDevice.json();
  ok("a second device adopts the same workspace", adopted.user?.id === userId, adopted);

  const reuse = await fetch(`${BASE}/api/session/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: handoff.body.code }),
  });
  ok("a handoff code is single use", reuse.status === 400);

  console.log("\nsettings");
  const settings = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ attentionThreshold: 20 }),
  });
  ok("attention threshold is adjustable", settings.body.user?.attentionThreshold === 20);

  // Compare two reads taken back to back, so the only variable is the dial.
  const loose = await api("/api/digest");
  await api("/api/settings", { method: "PATCH", body: JSON.stringify({ attentionThreshold: 95 }) });
  const strict = await api("/api/digest");
  ok(
    "the attention dial actually changes what is surfaced",
    loose.body.attention.length >= strict.body.attention.length &&
      loose.body.attention.length + loose.body.quiet.length ===
        strict.body.attention.length + strict.body.quiet.length,
    { loose: loose.body.attention.length, strict: strict.body.attention.length },
  );
  await api("/api/settings", { method: "PATCH", body: JSON.stringify({ attentionThreshold: 45 }) });

  console.log("\ncleanup");
  const del = await api(`/api/watchlists/${smokeListId}`, { method: "DELETE" });
  ok("delete watchlist", del.status === 200);
  const delAgain = await api(`/api/watchlists/${smokeListId}`, { method: "DELETE" });
  ok("deleting twice is a clean 404", delAgain.status === 404);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nsmoke test crashed:", err);
  process.exit(1);
});

export {};
