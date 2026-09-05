# Architecture

## The shape of it

```mermaid
flowchart TB
  subgraph Upstream
    F[Real feed<br/>Finnhub / any vendor]
    S[Deterministic simulator]
  end

  subgraph Pool["ProviderPool — one place for every upstream rule"]
    RL[token bucket] --> TO[timeout] --> RT[retry + full jitter] --> CB[circuit breaker] --> VA[schema + sanity validation]
  end

  F --> Pool
  S --> Pool

  subgraph Worker["Ingestion worker — cost is O(instruments)"]
    SCH[tiered scheduler<br/>hot 5s / warm 60s / cold 15m]
    PIPE[per-instrument pipeline<br/>advisory lock]
    DET[instrument-level detectors]
    SCH --> PIPE --> DET
  end

  Pool --> PIPE

  subgraph PG[(PostgreSQL)]
    Q[quotes<br/>monotonic as_of guard]
    E[change_events<br/>unique dedup key + bigserial seq]
    W[watermarks<br/>per user per instrument]
    OB[outbox]
    B[instruments<br/>cached baselines]
  end

  PIPE --> Q
  DET --> E
  DET --> OB

  subgraph Read["Read path — cost is O(readers), 4 queries"]
    SNAP[watched snapshot<br/>items+instruments+quotes in one query]
    USER[reader-relative detectors<br/>move since YOUR watermark, YOUR alerts]
    SCORE[scoring + tide line]
    SNAP --> USER --> SCORE
  end

  Q --> SNAP
  B --> SNAP
  E --> SCORE
  W --> USER

  OB --> HUB[SSE hub<br/>replay buffer]
  SCORE --> UI[Browser]
  HUB -- quotes + change events --> UI
  UI -- acknowledge --> W
```

## The split that everything else follows from

There are two kinds of "what changed", and conflating them is what makes naive
implementations quadratic.

**Instrument-level facts** — a gap, a volume surge, a 52-week break, a halt, a
feed outage — are facts about the market. They do not depend on who is watching.
They are computed **once per instrument** by the worker, stored as
`change_events`, and shared by every reader. A name held by one person and a
name held by fifty thousand cost exactly the same.

**Reader-relative facts** — the move since *you* last looked, the direction flip
since *you* last looked, *your* price alerts — cannot be shared, because they are
defined against your watermark. They are computed at read time, from data already
in memory, in a few hundred floating-point operations.

`buildDigest` merges the two, scores them with your conviction weighting, and
splits the result at the tide line.

| | work per unit | scales with |
|---|---|---|
| Polling + detection | one poll, one detector pass per instrument | size of the market |
| Digest | 4 indexed queries + arithmetic per request | how often readers look |

## Purity boundary

Everything in `src/core` is pure. No `Date.now()`, no database, no fetch. Time
arrives as an argument; so does the session; so does the instrument's baseline.

```ts
detectSignals(ctx: DetectionContext): { signals, failures }
scoreSignals(signals, weighting, novelty, now): Significance
buildDigest(items, { now, clock, session, attentionThreshold, ... }): Digest
```

That boundary is what makes 116 unit tests possible without a fixture database,
and it is what let the market clock be swapped for a simulated one without the
significance engine noticing.

### The market clock

An early version had each detector work out the session phase from `Date.now()`.
That was wrong in a way that only showed up under the simulator: the wall clock
said the market was shut, so volume comparisons were skipped, gaps never fired,
and every live price was labelled "at close". Worse, "since the previous close"
was computed by differencing two timestamps that are not on the same timeline
once the session is generated — which produced variance horizons near zero and
therefore **12σ readings on a 2% day**.

The fix was to make the session an explicit input:

```ts
interface MarketClock {
  session(now): { phase, sessionDate, progress, synthetic }
  horizon(from, to): number      // fraction of a day's variance between two instants
}
```

`realClock` reads the NSE calendar; `syntheticClock` reads the generated
session. The engine asks rather than assumes, and "today's change" is answered
from session *progress* (`overnightShare + progress × (1 − overnightShare)`),
which is exact under both.

## Data model, and what the database enforces

Application code runs in more than one process, so anything that must be true is
a constraint rather than a convention.

**`quotes.as_of` is monotonic.**

```sql
INSERT INTO quotes (...) VALUES (...)
ON CONFLICT (instrument_id) DO UPDATE SET ...
WHERE quotes.as_of < EXCLUDED.as_of        -- a late tick is discarded, not applied
```

Providers deliver out of order: a retry that lands after the retry-of-the-retry,
a failover to a slower feed, two workers a moment apart. Without this guard the
newest price on screen is whichever write finished last.

**`change_events` is idempotent and escalating.**

```sql
UNIQUE (instrument_id, kind, dedup_key)
ON CONFLICT DO UPDATE SET
  magnitude      = EXCLUDED.magnitude,
  peak_magnitude = GREATEST(change_events.peak_magnitude, EXCLUDED.magnitude),
  update_count   = change_events.update_count + 1
```

The dedup key for a price move is `move:<direction>:<floor(|z|)>`. A stock
drifting up all afternoon keeps landing in the same bucket and updates one row;
crossing into the next integer sigma creates a new one. Escalation semantics for
free, enforced by an index rather than by hoping the worker ran exactly once.

**Watchlist edits use optimistic concurrency.** `version` on the row, `WHERE
version = $expected`, and a 409 that carries the current server state so the
client can merge instead of reloading.

**The read cursor is a bigserial plus an exception list.** A watermark stores the
highest `change_events.seq` a reader has seen. A bigserial is allocated before
commit, so sequence 97 can become visible *after* 98–100 were already read;
advancing a cursor straight to 100 would bury 97 forever. Two things prevent
that:

1. Acknowledgement writes an explicit `user_event_state` row for every event the
   client actually rendered, and the digest filters on it.
2. The cursor only jumps as far as a **settling boundary** — the highest seq
   among events that committed more than five seconds ago.

The cursor keeps the query fast; the exception rows keep it correct.

**Notifications go through a transactional outbox.** Events are written in the
same transaction as the data that caused them, then published by a separate
drain using `FOR UPDATE SKIP LOCKED`. A crash between commit and notify costs a
duplicate delivery, which subscribers de-duplicate by event id — as opposed to a
lost delivery, which nothing downstream can recover from.

## The ingestion loop

```
retier (every ~15s)      one statement assigns every instrument hot/warm/cold
claimDue                 FOR UPDATE SKIP LOCKED — several workers share the rotation
ingest(batch)            one provider call for the batch
  per instrument:
    advisory lock        pg_try_advisory_xact_lock; skip rather than queue
    monotonic upsert     late tick discarded
    detectors            instrument-level only
    event upsert         idempotent, escalating
    outbox insert        same transaction
drainOutbox              publish to SSE subscribers
maintenance              baselines, tape trim, ack pruning, purges — spread across ticks
```

Tiering follows attention: an instrument someone has looked at in the last five
minutes polls every 5s, one on a watchlist nobody is looking at every 60s, one on
nobody's list every 15 minutes. Next-poll times carry ±15% jitter, without which
every instrument added in the same second polls in the same second forever.

## The read path

```
GET /api/digest
  ├─ watchedSnapshot(user)     items + instruments + quotes in ONE query
  ├─ getWatermarks(user)       ┐
  ├─ unseenEventsForUser(user) │ in parallel
  ├─ alertsByInstrument(user)  │
  └─ getTape(instruments)      ┘
  → buildDigest(...)           pure: reader-relative detectors, scoring, tide line
  → markShown(...)             fire-and-forget; drives repeat suppression
```

Four round trips. It was seven until the snapshot query collapsed items,
instruments and quotes into one join — under load that was the difference
between p99 = 944 ms and p99 = 296 ms, because each held connection is a chance
to queue behind somebody else.

## Streaming

SSE rather than WebSockets: the traffic is one-directional and bursty, and the
protocol carries reconnection and a resume cursor (`Last-Event-ID`) for free.

The hub keeps a bounded replay buffer. On reconnect the server replays what the
client missed; if the requested id has rolled out of the buffer, the `hello`
frame says `gap: true` and the client refetches the digest — a visible, handled
gap instead of a silent one.

Quote frames update prices **as an overlay** and never re-rank the page. A
watchlist that re-sorts under your cursor every two seconds is the exact
twitchiness this product argues against; `change` frames mark the ranking stale
and trigger a debounced refetch instead.

## Identity

No passwords. An HMAC-signed, httpOnly, SameSite=Lax cookie identifies a
*workspace*; a six-character, single-use, five-minute, hashed-at-rest handoff
code moves that workspace onto a second device. Because the watermark is
server-side, both devices then agree about what you have already seen — which is
the actual requirement in "how state persists across sessions and devices". A
half-hearted account system would have answered it worse.

## Module map

| path | responsibility |
|---|---|
| `core/stats` | volatility, z-scores, saturation, streaming moments |
| `core/market/calendar` | NSE sessions, holidays, IST arithmetic, variance horizons |
| `core/market/clock` | the `MarketClock` seam: real vs generated sessions |
| `core/market/freshness` | LIVE / DELAYED / STALE / AT_CLOSE / UNAVAILABLE |
| `core/significance/baseline` | per-instrument baselines, profile blending, plausibility |
| `core/significance/volume-profile` | turning observed sessions into a learned intraday shape |
| `core/significance/detect` | the ten detectors |
| `core/significance/score` | weighting, saturation, bands, the quiet reason |
| `core/diff/digest` | merges shared events with reader-relative signals |
| `server/providers` | provider seam, resilience primitives, simulator, scenarios |
| `server/ingest` | scheduler, pipeline, baseline maintenance |
| `server/repo` | hand-written SQL |
| `server/events` | SSE hub, transactional outbox |
| `server/services` | read path, clock selection, seeding, onboarding |
| `app/api` | Zod-validated route handlers, one error envelope |
| `components` | the UI |
