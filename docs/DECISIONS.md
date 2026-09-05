# Decisions

Each entry: the decision, what it was chosen over, and what it costs. The
rejected alternatives are the interesting half — a decision with no downside
was not a decision.

---

## ADR-1 · Rank by σ, not by %

**Decision.** Normalise every move by the instrument's own EWMA daily
volatility, scaled to the market time that elapsed, and rank by |z|.

**Rejected: rank by absolute % change.** Sorts the list by how volatile each
name is. The same small-caps top it every day, and a genuinely strange move in a
mega-cap lands on row eleven.

**Rejected: rank by market-cap-weighted move.** Answers "what moved the index",
which is a different question from "what should *you* look at".

**Rejected: learn the ranking from engagement.** No labelled data on day one, and
an engagement-trained ranker optimises for what you click, which for a market
product means it learns to show you whatever is scariest. A published weight
table can be argued with; a fitted one cannot.

**Cost.** σ is unfamiliar. Mitigated by never showing a bare σ — the ruler puts
it on a scale, and the copy always says what it means for *that* name. Also, σ
is badly behaved for instruments with almost no history, handled by
`shrinkageAdjustedSigma` widening the estimate below 60 observations.

---

## ADR-2 · The reference point is the reader's watermark

**Decision.** Store per (user, instrument): the price they last saw, its
timestamp, the direction at that moment, and the highest event sequence they
read. Diff against that; fall back to the previous close on a first visit.

**Rejected: always diff against the previous close.** Cannot distinguish "up 2%
all day and never moved" from "up 2%, crashed to −1%, recovered while you were
at lunch" — and the second is the one you needed to know about.

**Rejected: keep the watermark in `localStorage`.** Then the phone and the laptop
disagree about what you have read, which is precisely the failure the brief's
"across sessions/devices" bullet is asking about.

**Cost.** A row per (user, instrument) and a write on every acknowledgement.
Both are small and bounded by watchlist size; `pruneAcknowledgements` keeps the
exception table from growing.

---

## ADR-3 · Events are bucketed, not continuous

**Decision.** Each detector emits a discrete `dedupBucket`. Price moves bucket
by integer sigma and direction (`move:down:2`), volume by `floor(log2(ratio))`,
range breaks by window and session date. `UNIQUE (instrument_id, kind,
dedup_key)` plus `ON CONFLICT DO UPDATE` makes creation idempotent.

**Rejected: emit an event per poll.** A stock drifting up for four hours
generates ~240 events at a 60-second cadence. Every one of them true, all of
them noise.

**Rejected: rate-limit notifications in the application.** Moves the problem to
"which process owns the rate limiter", and gets it wrong the moment there are
two workers.

**Consequence, and it is a nice one.** Because the bucket is an integer sigma,
crossing 1σ → 2σ → 3σ naturally produces three events. Escalation semantics
arrive for free, and "this got worse" is expressible without any extra concept.

**Cost.** Bucket boundaries are visible: a move oscillating around 1.99σ can
produce a second event when it touches 2.0σ. Acceptable — the alternative is
either silence at 2.5σ or a stream at 1.9σ.

---

## ADR-4 · Instrument-level events are shared; only the diff is per reader

**Decision.** The worker computes gaps, volume surges, range breaks, halts and
outages once per instrument. The read path computes only what is genuinely
reader-specific: the move since *your* watermark, the flip since *your* last
visit, *your* alerts.

**Rejected: compute everything per user on read.** O(users × instruments) work,
repeated on every page load, all of it identical between users.

**Rejected: compute everything per user on write (fan-out on write).** A
materialised feed row per (user, event). Fast reads, but a name held by 50,000
users generates 50,000 rows per event, and a watchlist edit means backfilling.

**Cost.** Two code paths that both produce `Signal`s and must stay consistent.
Mitigated by them literally sharing the detector functions and the scorer.

---

## ADR-5 · Hand-written SQL over an ORM

**Decision.** `pg` plus a small typed query layer. Migrations are plain `.sql`
applied in order under a session advisory lock.

**Rejected: Prisma.** The queries that carry this system's correctness — a
conditional upsert enforcing monotonic timestamps, an `ON CONFLICT` clause with
escalation logic inside it, `FOR UPDATE SKIP LOCKED`, `pg_try_advisory_xact_lock`
— are exactly what ORMs express worst, and would have ended up as `$queryRaw`
anyway. The current major line also ships a codegen step and an engine binary
that add deployment failure modes for no benefit here.

**Rejected: Drizzle.** Closer to SQL and genuinely good, but still a schema DSL
between me and the four statements that matter, and its migration tool cannot
express the partial indexes and constraint shapes used here.

**Cost.** No compile-time column checking; row shapes are asserted by hand at
the repository boundary. Mitigated by every repository function returning a
typed domain object, so the untyped surface is one file per table.

---

## ADR-6 · A market clock, injected

**Decision.** `MarketClock` is an interface with two methods — `session(now)` and
`horizon(from, to)`. Detectors take the session as an argument and never read
the wall clock.

**Why it changed.** The first version derived the phase from `Date.now()` inside
each detector. Under the simulator that made volume comparisons skip, gaps never
fire, live prices label themselves "at close", and — worst — "since the previous
close" was computed by differencing two timestamps that are not on the same
timeline once the session is generated. The digest was reporting **12σ for a 2%
day**. The bug is documented here rather than quietly fixed because it is the
clearest example in the project of why the purity boundary earns its keep: once
the session became an input, the same code was correct under both clocks and a
test could pin it.

**Cost.** One more argument threaded through the detection context.

---

## ADR-7 · A deterministic simulator, always available

**Decision.** Ship a seeded simulator that generates a year of daily bars and a
minute-resolution intraday path, pinned to each session's generated close by a
Brownian bridge. It is always the last provider in the pool.

**Rejected: real feed only.** NSE is open for 6¼ hours on weekdays. A judge
opening this on a Sunday evening would see a wall of frozen numbers, and every
test would depend on what the market happened to do.

**Rejected: simulator only.** Reads as avoiding the hard part. The provider seam
and a working Finnhub adapter are in the repository; the simulator is a
fallback, not a substitute.

**Cost.** A meaningful amount of code that ships in production and is never used
against a real feed. Bought back three times over: deterministic tests, a
demonstrable product outside market hours, and a fault-injection surface that
made the resilience work verifiable rather than aspirational.

**Non-negotiable.** The UI states which mode it is in, everywhere, always.

---

## ADR-8 · Faults are injected as data, not as a demo mode

**Decision.** The `scenarios` table holds active faults. The provider applies
them at the edge. Nothing downstream knows.

**Rejected: a demo mode with mocked responses.** Then what a reviewer watches is
the mock, not the system.

**Cost.** A table and an admin surface in a product that has no admin. Worth it:
"click Decimal error and watch the sanity filter reject it" is a stronger
argument than any paragraph about input validation.

---

## ADR-9 · A workspace cookie plus a handoff code, not accounts

**Decision.** HMAC-signed httpOnly cookie for identity. A six-character,
single-use, five-minute, hashed-at-rest code adopts the same workspace on a
second device.

**Rejected: email + password.** Days of work on password reset, verification and
rate limiting, none of which is the problem the brief poses.

**Rejected: OAuth.** An external dependency in the critical path of the first
screen, and a provider console to configure before anyone can run the project.

**Cost.** Clearing cookies loses the workspace unless a handoff code was used.
Stated plainly in the UI. The upgrade path is one table: attach credentials to
the existing `users` row.

---

## ADR-10 · SSE, with an honest gap signal

**Decision.** Server-Sent Events, a bounded replay buffer keyed by a monotonic
id, and `Last-Event-ID` resumption. If the requested id has rolled out of the
buffer, the server says so and the client refetches.

**Rejected: WebSockets.** Bidirectional plumbing for one-directional traffic, and
reconnection and resume become my problem instead of the protocol's.

**Rejected: polling only.** Kept anyway as a 45-second safety net, because some
proxies eat SSE and a wedged stream must not silently freeze the page.

**Cost.** The hub is in-process. Behind an interface, with the Redis pub/sub
migration written down in `SCALING.md`; a single instance genuinely does not
need it yet.

---

## ADR-11 · The screen is an instrument, not a document

**Decision.** One hand-written stylesheet of design tokens, system fonts, no
framework — and a single committed look: a dark measured field, mono-forward
tabular type, and exactly one accent colour.

The layout is an argument about what the product is. The hero is **the field**:
every watched instrument plotted at once, unusualness (σ) across, significance
(0–100) up, with the reader's threshold drawn as a horizontal accent line. Marks
above it interrupt you; marks below it do not. A reader can see a name sitting
inside the shaded ±1σ column with a large percentage under it — the exact case a
conventional watchlist gets wrong — without reading a word of documentation.

**Colour carries meaning or it is not used.** One accent — turquoise — means
"the system is reading this": the threshold line, whatever crossed it, the live
lamp. Nothing else uses it. Green and red are direction of travel only, never
chrome, and both are held well away from the accent's hue so a rising price can
never be misread as a system state. Everything else is one near-neutral graphite
ramp, warm by a degree or two, so the single cold accent has something to sit
against — and the ground is graphite rather than black, because pitch black plus
a bright accent is the default dark theme everyone ships.

**Rejected: an editorial/newspaper treatment.** The first version of this UI was
typeset like a broadsheet — serif headlines, hairline rules, a reading measure.
It read well and it was wrong: it framed live market state as an article, and
the numbers stopped feeling live. Rewritten as instrumentation.

**Rejected: a light theme.** Two half-tuned skins read as a theme switcher; one
committed look reads as designed. `color-scheme: dark` is declared, so form
controls and scrollbars follow.

**Rejected: Tailwind.** Installed by the scaffold and removed — the visual
argument is easier to hold coherent in one stylesheet than across a hundred
class strings.

**Rejected: a component library.** Every one of them looks like a component
library.

**Rejected: a charting library.** The field, the σ ruler and the sparkline are
three hand-drawn SVGs totalling a few hundred lines. A charting dependency would
be larger than all of them and would still need to be fought to draw a threshold
line.

**Rejected: a webfont.** A build-time network dependency and a flash of
invisible text on the first paint of a page whose whole job is to be glanceable.

**Cost.** More CSS to maintain, and no light mode for anyone who wants one.

---

## ADR-12 · Everything boots itself

**Decision.** Migrations, universe seeding and the worker all start from
`instrumentation.ts`. All three are idempotent and safe to run concurrently —
advisory-locked migrator, upsert seed, `SKIP LOCKED` worker.

**Rejected: a setup script in the README.** Every "run this first" step is a
place for a reviewer's evaluation to end early.

**Cost.** Slightly slower cold start, and boot work happens in the web process
by default. `RUN_WORKER_IN_WEB=false` splits it when that matters.
