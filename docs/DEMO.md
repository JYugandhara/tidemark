# Demo script

Five minutes of demo, five minutes of questions. This is what to show, in what
order, and what to say — plus the questions to expect and the honest answers.

---

## Before you start

```bash
docker compose up --build     # or: npm run db:seed && npm run dev
```

Open `http://localhost:3000`. Check the masthead says **live** with a pulsing
dot. If the Feed Room says the session is simulated, that is expected outside
09:15–15:30 IST and the banner already says so on screen — do not apologise for
it, it is a deliberate feature and one of the strongest things to show.

Have the Break something panel visible in the right rail.

---

## Minute 1 — the claim

> "This is a watchlist. The screen you'd expect is a table of tickers, last
> price, and a red or green percent. Here's what it actually says."

Read the headline aloud. Ideally it says something like *"1 thing crossed the
line"* with seven names held back below it.

Then point at **the field** — the chart directly underneath.

> "Every name I watch is on this plot. Left to right is how unusual the move is,
> in that name's own sigmas. Up is how significant it scored. The amber dashed
> line is my threshold. Anything that pokes above it interrupts me; anything
> below it doesn't. The hatched column in the middle is plus or minus one sigma —
> an ordinary day. Most of the market lives in there, most days."

> "The interesting part is not the one at the top. It's this."

Point at the held-back table. Find the name with the **largest** percentage move —
usually SUZLON or TATAMOTORS — and read its row:

> "SUZLON is up 3.1% and the app is deliberately not telling me about it,
> because 3.1% is 0.8σ for SUZLON — that's a Tuesday. Meanwhile RELIANCE is down
> 2.0% and it's the one thing at the top, because 2% is a 1.4σ day for RELIANCE.
>
> Percentages aren't comparable across instruments. Sorting a watchlist by
> percent sorts it by volatility, which is why the same five small-caps are at
> the top of yours every single day. This ranks by how unusual a move is, not
> how big it is."

**That is the entire pitch.** Everything after this is evidence.

---

## Minute 2 — the decomposition, the ruler and the "why"

Point at the segmented bar under the top strip.

> "That's the score taking itself apart, in line, without me clicking anything.
> Halt contributed 42 points, the range break 18, the gap 16, the volume surge
> 15. The hatched remainder is how much of the 0–100 scale is still unused."

Point at the σ-ruler below it.

> "Fixed −3σ to +3σ scale, and the shaded band is where this name lives on an
> ordinary day. Same scale as the field above, so the two agree."

Click **Why is this here?**

> "Every point of the score is attributed. Halt contributed 30.9, the price move
> 12.9, the volume surge 9.5 — and under each one, the evidence: the actual
> return, the interval sigma, the variance horizon, the expected volume for this
> time of day.
>
> The weights are fixed and published, not learned. On day one there's no
> labelled data, and I'd rather ship a prior a user can argue with than a fitted
> model nobody can debug. Engagement-trained ranking on a market product learns
> to show you whatever's scariest."

---

## Minute 3 — "since you last checked"

Click **I've seen this**.

> "That just wrote a watermark — the price I saw and the events I read — for
> every instrument, on the server."

Point at a sparkline.

> "Now the reference point moves. The shaded region on these sparklines is what
> happened while I was away. And the column header changes from 'since
> yesterday's close' to 'since you last checked'.
>
> This matters more than it looks. A stock that's flat on the day but swung ±3%
> over lunch is invisible on every day-anchored watchlist, and it's exactly the
> thing you needed to know about."

If you have a second device or browser: click **Get a handoff code**, enter it
elsewhere.

> "The watermark is server-side and keyed to the workspace, not the browser. My
> phone knows what my laptop already showed me. That's what 'persists across
> sessions and devices' has to mean — not localStorage."

---

## Minute 4 — break it

This is the part that separates a description of resilience from a demonstration
of it.

**Decimal error** (on any instrument):

> "That just made the feed send a price ten times too low — the classic vendor
> defect."

Wait ~10 seconds, refresh.

> "The price didn't move. The sanity filter rejected it, because the implied
> move is far outside anything this instrument has ever done in a day — the
> tolerance comes from its own volatility, so a real 20% circuit move still gets
> through. And notice it doesn't silently pretend everything's fine: the
> instrument now says it has no fresh data. A missing price is information."

**Provider down:**

> "That takes the upstream out entirely."

Point at the Feed Room.

> "Circuit breaker just went from healthy to tripped. It fails fast for thirty
> seconds instead of queueing four hundred requests against a dead service, then
> half-opens and needs two clean probes before it trusts it again."

Wait, then click **Clear all faults**.

> "And it recovers on its own. None of that is a demo mode — those buttons write
> a row to a table, the provider applies it at the edge, and ingestion has no
> idea it's being tested. What you just watched is the production path meeting a
> fault."

---

## Minute 5 — the engineering underneath

Slide the **attention dial** down.

> "One control, one visible consequence — the tide line moves and things come
> up from below it."

Then, quickly:

> "Two things worth knowing about how this is built.
>
> **First, polling is fanned in by instrument, not by user.** Sixty readers
> watching the same forty names cost exactly the same to poll as one reader.
> Instrument-level facts — gaps, halts, volume, 52-week breaks — are computed
> once and shared; only the diff against *your* watermark is per reader. The
> read path is four indexed queries: 8.6 milliseconds unloaded, about 150
> digests a second per process.
>
> **Second, the correctness lives in the database, not in my application code,
> because my application code runs in more than one process.** Quotes have a
> monotonic timestamp guard so a late tick can't overwrite a newer one. Events
> have a unique dedup key, so a stock drifting up all afternoon produces one
> event that escalates 1σ, 2σ, 3σ — not two hundred and forty notifications.
> Watchlist edits use optimistic concurrency and return a 409 with the current
> server state so two devices can't silently clobber each other."

---

## Questions you will get, and honest answers

**"Is this real market data?"**
Not right now — NSE is shut, so it's a seeded simulator, and the UI says so in
three places. There's a working Finnhub adapter in the repo;
`MARKET_PROVIDERS=finnhub,simulated` switches it and nothing in the domain, the
API or the UI changes. The simulator exists for three reasons: the product has to
be demonstrable outside market hours, tests have to be deterministic, and
resilience claims should be shown rather than described.

**"How did you pick the weights?"**
By hand, and they're published in the UI. With no labelled data a transparent
prior beats a fitted model nobody can debug. The saturation curves matter more
than the exact weights — each signal is bounded before weighting, so one absurd
print can't outrank a name with three genuine signals.

**"Why sigma and not a percentage threshold?"**
Because a threshold that's right for HINDUNILVR is wrong for SUZLON by a factor
of four. A percentage threshold is a volatility filter wearing a disguise.

**"What breaks if this gets 100× the traffic?"**
SSE fan-out, first and by a distance — the pub/sub hub is in-process, so two web
instances don't see each other's events. It's behind an interface and the Redis
migration is written down. Everything else is already multi-instance-safe:
`SKIP LOCKED` claiming, advisory locks per instrument, monotonic writes.

**"Isn't the watermark just a read receipt?"**
Yes — and getting read receipts right is harder than it looks. A bigserial is
allocated before commit, so sequence 97 can become visible after 98–100 were
already read; naively advancing the cursor buries 97 forever. There are explicit
per-event acknowledgement rows plus a settling boundary on the cursor jump.

**"What would you do next?"**
Three things. Redis pub/sub, so it runs multi-instance. Corporate-action price
adjustment, which currently reads a 1:5 split as an 80% drop until the daily
bars rebase. And per-user calibration of the tide line: I have the data to learn
where each reader's threshold *should* be from what they acknowledge without
opening, and I deliberately didn't ship a learned model without being able to
explain it.

**"What are you least happy with?"**
Corporate-action price adjustment. A 1:5 split currently reads as an 80% drop
until the next day's bars rebase the baseline — the sanity filter catches the
absurd case, but a 1:2 split would slip through as a genuine-looking −50% day.
Doing it properly needs adjusted history from the data source, so I chose to
document the gap rather than half-fix it. Second on the list: the SSE hub is
single-process, which is stated in the app's own Feed Room rather than hidden in
a README.

**"Does the volume comparison actually adapt, or is it a fixed curve?"**
It adapts. Every poll records cumulative volume in the current 15-minute bucket;
completed sessions are folded into a per-instrument running mean and the raw
rows are dropped. The baseline blends that observed shape with a generic
U-curve, weighted by how many sessions have been seen — so a name with three
days of history is judged mostly by the prior and one with two months mostly by
itself. The fold is a plain incremental mean rather than an EWMA, because
intraday shape is structural and shouldn't be rewritten by one expiry day.
