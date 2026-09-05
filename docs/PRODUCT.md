# The product argument

## What the brief actually asks

> Build a smart market watchlist that helps users not just track stocks, but
> quickly understand what has "meaningfully changed" since they last checked,
> and what deserves their attention now.

Two words in that sentence do the work. **Meaningfully** — which means the
system has to have an opinion about what counts. And **attention** — which means
the scarce resource is not data, it is the reader.

Every other decision in this project follows from taking those two words
literally.

---

## Why the obvious watchlist fails

A conventional watchlist shows last price and percentage change, sorted by
whatever order you added things in. It has three problems, and they compound.

**1. A percentage is not comparable across instruments.**

The same −2% means completely different things:

| instrument | typical daily move (σ) | −2% expressed in σ |
|---|---|---|
| HINDUNILVR | 1.04% | −1.9σ — unusual |
| TCS | 1.18% | −1.7σ — notable |
| TATAMOTORS | 2.24% | −0.9σ — ordinary |
| SUZLON | 3.86% | −0.5σ — noise |

Sorting by `% change` sorts by volatility. The same five small-caps sit at the
top every day, and the one time a mega-cap does something genuinely strange, it
is on row eleven.

**2. "Today" is the wrong window.**

You last looked at 11:40. It is now 15:10. A stock that was up 2% and is now up
2.1% shows as `+2.1%` — the same as one that has been up 2.1% since the open and
never moved. One of those had a violent afternoon and came back; the other did
nothing. A day-anchored view cannot tell them apart, and the afternoon is the
part you missed.

**3. Everything is shown at once, so nothing is ranked.**

A grid of tiles is a claim that all forty rows deserve equal attention. If that
were true, you would not need the product.

---

## The three decisions

### 1. Significance is a σ, not a %

Every move is divided by the instrument's own recent volatility, scaled to the
market time that actually elapsed. The output is "this is a 2.8σ move" — a
number that means the same thing for a utility and for a penny stock.

Three details that turned out to matter more than expected:

- **Volatility clusters**, so the baseline is an EWMA (λ = 0.94) rather than a
  flat 250-day standard deviation. A name that has been violent for four days is
  judged against those four days.
- **Elapsed time must be market time.** Three hours of a live session is a much
  larger opportunity for change than three hours on a Sunday. The clock counts
  session minutes and charges each overnight gap a fixed share (25%) of a day's
  variance — which is also what makes a gap open scoreable instead of dividing
  by zero elapsed time.
- **Thin history has to widen the estimate**, or a name with eight bars of
  history reports every move as a 4σ event on its first day.

### 2. The reference point is *you*, not the calendar

Each reader has a per-instrument watermark holding the price they last saw and
the highest event they read. "Since you last checked" is a diff against that.

This is what makes the third bullet of the brief — *return later and see what has
changed* — a real feature rather than a re-render. It also means a stock that is
flat on the day but swung ±3% while you were at lunch is correctly at the top of
your list, which no day-anchored watchlist can express.

The watermark lives on the server, keyed by workspace rather than by browser, so
opening the app on a phone does not reset what your laptop already showed you.

### 3. Silence is an answer, and it has to explain itself

The most valuable output of this product is "nothing needs you". A blank screen
is not trustworthy, so every quiet instrument is listed with the reason it is
quiet — the move, its σ, and the verdict:

> SUZLON +3.10% — 0.8σ, an ordinary move for this name

A reader can check the model's homework in one glance. That is the difference
between an empty state people trust and one they work around by opening another
tab.

---

## The interface follows from that

**The tide line.** A single horizontal rule across the page. Above it, what
cleared the bar; below it, what did not, with reasons. The attention dial moves
the line, so "how much do you want to be interrupted?" is one control with a
visible consequence rather than a settings page.

**The σ-ruler.** Under every entry, a fixed −3σ…+3σ scale with the instrument's
ordinary range shaded and today's move marked on it. Two of them side by side
make the entire thesis self-evident without a paragraph of explanation.

**The sparkline shades what you missed.** The region after your watermark is
shaded. It is the smallest possible drawing of "since you last checked".

**"Why is this here?"** expands into the full arithmetic: every point of the
score attributed to a named signal, with the evidence. Weights are hand-set and
published rather than learned — on day one there is no labelled data, and a
transparent prior is something a user can argue with, which a fitted model
is not.

**Conviction, set by the reader.** Core / tracking / background scales the score.
Nothing here infers what you "probably" care about from your clicks. The one
place the model is overridden entirely is a price alert you set yourself: you
named a number, so it wins.

---

## What "meaningful" means, precisely

Ten detectors, each answering one narrow question. Each emits a *bucketed*
signal, so a developing story is one escalating event rather than a stream:

| signal | what it notices | why it earns a place |
|---|---|---|
| `PRICE_MOVE` | σ-normalised move vs your watermark or the previous close | the core question |
| `GAP` | overnight gap vs previous close, scaled to overnight variance | the move you had no chance to react to |
| `VOLUME_SURGE` | volume vs the *shape* of a normal day — a shape learned per instrument | at 09:45 every stock has "low volume"; that is not news |
| `RANGE_BREAK` | 52-week and 20-day highs and lows | round-number levels people actually act on |
| `TREND_REVERSAL` | direction flip since *your* last visit | "was up, now down" is a bigger change than "up a bit more" |
| `LEVEL_CROSS` | your own price alerts | you asked by name |
| `CIRCUIT` / `HALT` | band hit, trading stopped | you cannot trade; you need to know now |
| `LIQUIDITY_DROP` | spread blow-out | the price is real but you cannot get it |
| `DATA_STALE` | feed silent while the market is open | missing data is information |
| `CORPORATE_ACTION` | ex-dividend, split, earnings within five days | tomorrow's price gap has a known cause |

Scores saturate per signal and again in aggregate, so a single 12σ print — almost
always a bad tick — cannot outrank a name with three genuine signals.

---

## Deliberate omissions

**No news or sentiment feed.** It would be the easiest way to look impressive and
the fastest way to become unfalsifiable. Every signal here is computed from
prices and volumes we can defend arithmetically.

**No portfolio, P&L or order placement.** Adjacent products. The brief is about
attention.

**No infinite scroll of every ticker.** The universe search exists to add names
to a list. Browsing the whole market is a different product.

**No push notifications.** The interesting problem — deciding what is worth
interrupting someone for — is solved here; the delivery channel is plumbing, and
the transactional outbox is already the correct seam for it.
