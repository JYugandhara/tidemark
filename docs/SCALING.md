# Scaling

## The cost model

Two independent axes, deliberately kept independent.

```
ingestion cost  ∝  instruments subscribed by at least one user
read cost       ∝  digest requests
```

Nothing in the system is proportional to `users × instruments`. That is the
whole point of computing instrument-level events once and only the reader-relative
diff per request.

| | unit of work | grows with |
|---|---|---|
| Polling | 1 provider call per batch of ≤50 instruments per tier interval | breadth of the market being watched |
| Detection | 8 detectors × 1 instrument | same |
| Baselines | ~260 daily bars per instrument, once a day | same |
| Digest | 4 indexed queries + ~10² floating-point ops per watched instrument | how often readers refresh |
| Streaming | 1 fan-out per event to matching subscribers | concurrent open tabs |

Concretely: 60 readers watching the same 40 names cost the same to poll as one
reader watching 40 names. Measured in the load test output — 16 hot instruments
regardless of reader count.

## Measured

Production build, single Node process, Postgres on the same machine, 60 readers
over 40 instruments, **36.5 KB per digest** (a deliberately unkind payload — a
database with a full session of accumulated events behind it, not a fresh one).

| concurrency | throughput | p50 | p95 | p99 | max | errors |
|---|---|---|---|---|---|---|
| 1 | 116/s | 8.0 ms | 12.0 ms | 17.4 ms | 38 ms | 0 / 1,392 |
| 8 | 151/s | 51.4 ms | 72.8 ms | 86.9 ms | 248 ms | 0 / 1,812 |
| 30 | 154/s | 192.6 ms | 228.3 ms | 251.5 ms | 619 ms | 0 / 3,102 |

Reproduce with `npm run loadtest -- --users 60 --concurrency 30 --seconds 20`.

Reading those numbers honestly: **8 ms is the actual cost of a digest.** At
concurrency 30 the box is saturated — 30 in flight ÷ 0.193 s ≈ 155/s, exactly
what Little's law predicts — so the p99 there is queueing, not work. The useful
capacity figure is ~150 digests/second per process on this hardware, and roughly
a third of the wall time at that payload is JSON serialisation rather than
database work, which is why item 4 below (paginating the digest) is the cheapest
win available if it ever matters.

That was not the first number. The read path originally made seven database
round trips and measured p99 = 944 ms at concurrency 25. Collapsing watchlist
items, instruments and quotes into a single join (`repo/snapshot.ts`) and sizing
the pool to match cut it by roughly a factor of four. With a bounded pool, each connection a
request holds is a chance for it to queue behind somebody else, and reducing
held connections mattered more than making any individual query faster.

## What breaks first, and what to do about it

### 1. SSE fan-out across instances — the real first limit

The hub is in-process. Two web instances behind a load balancer means a reader
connected to instance A never sees events published on instance B.

**Fix, in order of effort:** sticky sessions on the SSE route buys time; the
correct answer is Redis pub/sub. The seam already exists — `hub()` exposes
`publish` / `subscribe` / `replay`, and the outbox drainer is already the only
publisher. A Redis implementation replaces the class body and nothing else
changes. `Last-Event-ID` resumption keeps working if ids stay monotonic, which a
Redis stream gives for free.

### 2. Poll budget against a real vendor

At 40 instruments and a 5-second hot tier that is 8 requests/second — fine. At
5,000 instruments it is 1,000/s, which no free tier allows.

**Fix:** the tiering already exists and is the right lever. Beyond it: widen
batches (the pool already chunks by `capabilities.maxBatchSize`), demote the hot
tier when no session is open (`retier` already keys off `users.last_checked_at`),
and move to a streaming vendor — the provider interface is `getQuotes` today but
`ProviderPool` is the only caller, so a push provider becomes an adapter that
writes into the same monotonic upsert.

### 3. Table growth

`quote_ticks` is the fastest-growing table: instruments × ticks. Already trimmed
to `TAPE_LENGTH` per instrument by the worker. `change_events` is purged after 30
days, `outbox` after 2, `user_event_state` rows below the watermark are pruned
continuously.

**Next step at real volume:** partition `quote_ticks` by day and drop partitions
rather than deleting rows, or move the tape to a time-series store. The tape is
read only for sparklines, so it is the easiest thing to move out.

### 4. Digest fan-in for very large watchlists

A 500-instrument watchlist means a 500-row snapshot query and a 500-entry JSON
payload (~1.5 MB). Fine at 40, not at 500.

**Fix:** the digest is already ranked, so it paginates naturally — return the top
N above the tide line plus a count, and fetch the quiet list on demand. The
`highWaterSeq` acknowledgement protocol already handles partial acknowledgement
correctly, so this is a UI change rather than a protocol change.

### 5. Single Postgres

Every write is small and indexed; reads are all primary-key or index lookups.

**Fix, in order:** read replicas for the digest path (it reads nothing it just
wrote, except `markShown`, which is fire-and-forget and can move to the
outbox), then partition `change_events` by session date, then shard by
instrument if ingestion volume ever justifies it.

## Horizontal scaling today

The system is already safe to run as N identical containers:

- **Migrations** take a session advisory lock; whoever gets there first applies
  them, the rest wait and continue.
- **Seeding** is an upsert.
- **Instrument claiming** uses `FOR UPDATE SKIP LOCKED`, so workers take
  disjoint slices with no leader election.
- **Per-instrument processing** takes `pg_try_advisory_xact_lock` and skips
  rather than queues.
- **Outbox draining** uses `FOR UPDATE SKIP LOCKED` for the same reason.
- **Quote writes** are monotonic, so even a duplicate poll cannot corrupt state.

The only thing that is *not* multi-instance-correct is SSE fan-out, which is
item 1 above and is stated in the UI's own Feed Room rather than hidden.

Splitting the tiers:

```bash
# web instances
RUN_WORKER_IN_WEB=false npm run start
# one or more worker instances
npm run worker
```

## Back-of-envelope for a real deployment

Assume NSE's ~2,000 actively-watched equities and 100,000 readers, 10% of them
looking at any moment.

| | estimate |
|---|---|
| Hot instruments (someone actively watching) | ~600 |
| Poll load | 600 / 5s ÷ 50 per batch ≈ 2.4 requests/s upstream |
| Warm instruments | ~1,400 at 60s ≈ 0.5 requests/s |
| Digest requests | 10,000 active readers refreshing every 30s ≈ 330/s |
| Web instances needed | ~2, at the measured 190/s per process |
| Detection work | 2,000 instruments × 8 detectors per poll — microseconds each, single worker sufficient |
| Postgres | writes are one upsert + a handful of event upserts per instrument-poll; comfortably single-node |

The read path is the thing that scales with users, and it is stateless — which is
the useful property, because stateless is the cheap kind of scaling.
