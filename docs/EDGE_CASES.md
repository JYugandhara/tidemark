# Edge cases, failures and races

Every row below is handled in code, and most are reproducible from the UI or the
test suite. "Where" is the file that owns the behaviour.

---

## Unreliable upstreams

| Case | What happens | Where | Reproduce |
|---|---|---|---|
| Provider times out | AbortController fires at 4s; counted as a failure | `providers/resilience.ts` | Break something → **Slow upstream** |
| Provider 5xx / 429 | Retried with exponential backoff and **full jitter**; 4xx other than 429 is not retried (it will not succeed and would burn quota) | `resilience.ts` `retry`, `finnhub.ts` | — |
| Provider down for good | Circuit breaker opens after 5 failures, fails fast for 30s, half-opens, needs 2 clean probes to close | `resilience.ts` `CircuitBreaker` | Break something → **Provider down**; watch the Feed Room pill go `tripped → probing → healthy` |
| Provider partially answers | Only the symbols still missing fall through to the next provider | `providers/pool.ts` | — |
| Every provider fails | Last known quote stays on screen, marked with its true age; a `DATA_STALE` event is raised if the market is open | `pipeline.ts` `recordMissing` | Break something → **Feed goes silent** |
| Upstream returns HTML with a 200 | Body fails `JSON.parse` → retryable `ProviderError`, never reaches the domain | `finnhub.ts` `fetchJson` | — |
| Upstream returns valid JSON, wrong shape | Zod rejects it; symbol reported missing, not crashed | `finnhub.ts` | — |
| Rate limit approached | Token bucket makes the caller wait rather than fail — a quote 200ms late beats one that never arrives | `resilience.ts` `TokenBucket` | `tests/resilience.test.ts` |
| Synchronised recovery stampede | Full jitter on retries, ±15% jitter on every next-poll time | `resilience.ts`, `scheduler.ts` | — |

## Bad data

| Case | What happens | Where | Reproduce |
|---|---|---|---|
| Decimal-point error (price 10× too low) | Rejected against a tolerance derived from the instrument's own volatility (12σ, floor 35%); the quote is discarded whole | `pool.ts` `validateQuote` | Break something → **Decimal error** |
| Real 20% circuit move | **Accepted** — the tolerance floor exists precisely so genuine violence gets through | `pool.ts` | `tests/resilience.test.ts` |
| Zero or negative price | Rejected | `pool.ts` | — |
| Timestamp in the future | Rejected beyond 2 minutes of clock skew | `pool.ts` | — |
| Timestamp weeks old | Rejected beyond 30 days | `pool.ts` | — |
| `high < low`, negative volume | Rejected | `pool.ts` | — |
| Missing previous close | Rejected — every downstream percentage depends on it | `pool.ts` | — |
| Divide-by-zero on a flat instrument | σ floored at 0.15%/day and capped at 35%/day | `core/stats` `MIN_SIGMA` | `tests/stats.test.ts` |
| Instrument with 8 bars of history | σ inflated by `1 + 2/√n`, so day one does not report everything as 4σ | `core/stats` `shrinkageAdjustedSigma` | `tests/stats.test.ts` |
| `NaN` anywhere in the pipeline | Every stats primitive is total; `clamp` maps non-finite input to its lower bound | `core/stats` | `tests/stats.test.ts` |

## Races and concurrency

| Case | What happens | Where |
|---|---|---|
| Late tick overwrites a newer one | `WHERE quotes.as_of < EXCLUDED.as_of` on the upsert — the database refuses it | `repo/quotes.ts` |
| Two workers poll the same instrument | `pg_try_advisory_xact_lock`; the loser skips this tick rather than queueing | `db/client.ts`, `pipeline.ts` |
| Two workers claim the same batch | `FOR UPDATE SKIP LOCKED` gives each a disjoint slice | `scheduler.ts` `claimDue` |
| Duplicate event from concurrent detection | `UNIQUE (instrument_id, kind, dedup_key)` + `ON CONFLICT DO UPDATE` | `db/migrations/0001_init.sql` |
| Two devices edit the same watchlist item | `version` check; 409 carrying the current server state so the client can merge | `repo/watchlists.ts`, `api/items/[id]` |
| Two devices acknowledge concurrently | `GREATEST(...)` on the cursor and a timestamp guard on the reference — both advance monotonically, last writer cannot regress it | `repo/watermarks.ts` |
| Acknowledging skips an event whose seq committed late | Explicit per-event acknowledgement rows **plus** a 5-second settling boundary on the cursor jump | `repo/events.ts` `safeAckBoundary` |
| Same code redeemed on two devices | `UPDATE ... WHERE consumed_at IS NULL RETURNING` — exactly one wins | `session/index.ts` |
| Same symbol added twice | `ON CONFLICT DO NOTHING`, returns the existing row; a double-tap is not an error | `repo/watchlists.ts` |
| Overlapping worker ticks | `inFlight` guard; a slow tick is skipped, not stacked | `scheduler.ts` |
| Process dies between commit and notify | Transactional outbox — worst case a duplicate, de-duplicated by event id | `events/outbox.ts` |
| Two instances boot and migrate together | Session advisory lock around the whole migration run | `db/migrate.ts` |
| An applied migration is edited later | Checksum mismatch fails the boot loudly instead of drifting | `db/migrate.ts` |

## Market-structure cases

| Case | What happens | Where |
|---|---|---|
| Weekend / exchange holiday | Calendar knows; no session, no variance charged, no stale-feed complaints | `core/market/calendar.ts` |
| Pre-open, closing auction, post-close | Distinct phases; gap and volume detectors stay quiet before the open | `calendar.ts`, `detect.ts` |
| Overnight gap | Charged a fixed 25% of a day's variance, so a gap is scoreable instead of dividing by ~0 elapsed session time | `calendar.ts` `OVERNIGHT_VARIANCE_SHARE` |
| Long weekend between visits | `varianceHorizon` counts session minutes and overnight boundaries, never wall-clock hours | `calendar.ts` | 
| Trading halt | `HALT` signal, weight 1.3, flagged in the UI | `detect.ts` |
| Circuit band hit | `CIRCUIT` signal when within 0.25% of the band | `detect.ts` |
| Volume judged at 09:45 | Compared against the intraday volume *profile*, not the daily average | `detect.ts` `expectedVolumeShare` |
| An instrument that does not trade in a U-shape | Its own observed shape is learned from completed sessions and blended in, weighted by how many have been seen | `core/significance/volume-profile.ts`, `ingest/volume-profile.ts` |
| Half a session observed (app restarted midday) | Refused — a partial day would teach the model that the afternoon does not exist | `volume-profile.ts` `sessionShares` |
| Provider resets its volume counter mid-session | Cumulative readings are forced monotonic on write (`GREATEST`) and again on read | `ingest/volume-profile.ts`, `sessionShares` |
| Ex-dividend / split / earnings | Surfaced up to 5 days ahead so tomorrow's gap has a known cause | `detect.ts` |
| 52-week and 20-day break at once | The 52-week statement suppresses the 20-day one — one fact, not two | `detect.ts` `detectRangeBreak` |
| Spread blows out | `LIQUIDITY_DROP` — the price is real but you cannot get it | `detect.ts` |
| IST has no DST | Fixed +05:30 arithmetic; no timezone library, no DST-transition bug class | `calendar.ts` |
| Holiday list goes stale | Fixed national holidays are built in; exchange-specific dates are injectable, and a non-trading weekday shows up as absent bars rather than as wrong data | `calendar.ts` |

## Reader-facing cases

| Case | What happens |
|---|---|
| Nothing changed | The empty state is the feature: every quiet name is listed with its σ and the verdict |
| Same story shown repeatedly | Novelty multiplier `1/(1+0.6·timesShown)` suppresses repeats |
| Away for two days | Absence boost, capped at ×1.25 — coming back to more news raises the bar slightly rather than flooding the page |
| Instrument muted | Score forced to zero; the row still appears, labelled "Muted by you" — never silently dropped |
| A single absurd σ | Per-signal `tanh` saturation and an aggregate squash; three genuine signals outrank one 40σ print |
| Watchlist empty | Search box, and the starter list seeds a working product on first run |
| Feed dark for one instrument | Row stays, price blank, "no fresh data — not scored" |
| Alert level straddled repeatedly | Rules disarm on fire and re-arm only after a 0.5% hysteresis band |
| Stream drops mid-session | SSE reconnects with `Last-Event-ID`; on a buffer gap the server says so and the client refetches |
| A digest fetch fails | The last good digest stays on screen with a banner — never a blank page |
| An old event is still unread | Labelled "happened 11 min ago — still unread by you", so history is not mistaken for a live claim |
| Reduced motion | All animation disabled via `prefers-reduced-motion` |

## What is knowingly not handled

- **Multi-instance SSE fan-out.** The hub is in-process. Migration path in `SCALING.md`.
- **Corporate-action price adjustment.** A 1:5 split will read as an 80% drop until the next daily bar rebases the baseline. Correct handling means adjusted history, which needs a data source that supplies it.
- **Per-user rate limiting on the API.** Not needed for a cookie-scoped workspace, and adding it without a real threat model would be theatre.
- **Exchange holiday auto-refresh.** The calendar takes an injectable list; nothing fetches next year's circular.
