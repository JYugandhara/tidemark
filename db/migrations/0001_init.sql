-- Tidemark schema.
--
-- Design notes that are enforced here rather than in application code, because
-- application code runs in more than one process and cannot be trusted to be
-- the only writer:
--
--   * quotes.as_of is monotonic. The upsert in src/server/repo/quotes.ts carries
--     a WHERE clause so a late-arriving tick from a slow provider can never
--     overwrite newer data. Correctness under out-of-order delivery is a
--     database guarantee, not a race we hope to win.
--   * change_events has a unique (instrument_id, kind, dedup_key). Two workers
--     that observe the same 2-sigma move produce one row, not two.
--   * watchlist_items.version gives optimistic concurrency, so two devices
--     editing the same list produce a visible 409 instead of a silent lost
--     update.
--   * change_events.seq is a bigserial read cursor. A user's watermark stores
--     the highest seq they have seen, which is what makes "since you last
--     checked" work identically across devices.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- identity --

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle             text NOT NULL,
  attention_threshold integer NOT NULL DEFAULT 45
                      CHECK (attention_threshold BETWEEN 0 AND 100),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- When the user last actually looked at the app. Drives the "since you last
  -- checked" reference and the absence boost in the novelty multiplier.
  last_checked_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL,
  user_agent    text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX devices_user_idx ON devices (user_id, last_seen_at DESC);

-- Short-lived, single-use codes for adopting an existing workspace on a second
-- device. Stored hashed: a leaked database row must not be a working credential.
CREATE TABLE handoff_codes (
  code_hash   text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX handoff_codes_expiry_idx ON handoff_codes (expires_at);

-- ------------------------------------------------------------- instruments --

CREATE TABLE instruments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol     text NOT NULL,
  exchange   text NOT NULL DEFAULT 'NSE',
  name       text NOT NULL,
  sector     text,
  currency   text NOT NULL DEFAULT 'INR',
  is_active  boolean NOT NULL DEFAULT true,

  -- Cached statistical baseline. Recomputed on a slow cadence; never per user.
  daily_sigma          double precision NOT NULL DEFAULT 0.02,
  sample_size          integer NOT NULL DEFAULT 0,
  log_volume_mean      double precision NOT NULL DEFAULT 0,
  log_volume_sigma     double precision NOT NULL DEFAULT 0.45,
  volume_profile       jsonb NOT NULL DEFAULT '[]'::jsonb,
  volume_profile_samples integer NOT NULL DEFAULT 0,
  high_52w             double precision,
  low_52w              double precision,
  high_20d             double precision,
  low_20d              double precision,
  median_abs_return    double precision NOT NULL DEFAULT 0.01,
  baseline_computed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange, symbol)
);
CREATE INDEX instruments_symbol_trgm_idx ON instruments (lower(symbol));
CREATE INDEX instruments_name_idx ON instruments (lower(name));

CREATE TABLE daily_bars (
  instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  session_date  date NOT NULL,
  open   double precision NOT NULL,
  high   double precision NOT NULL,
  low    double precision NOT NULL,
  close  double precision NOT NULL,
  volume double precision NOT NULL,
  PRIMARY KEY (instrument_id, session_date)
);

-- Current market state, one row per instrument. Deliberately not append-only:
-- the hot read path is "give me the latest for these 40 symbols", and a single
-- indexed row per instrument keeps that a primary-key lookup.
CREATE TABLE quotes (
  instrument_id  uuid PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  price          double precision NOT NULL,
  previous_close double precision NOT NULL,
  open           double precision,
  day_high       double precision,
  day_low        double precision,
  volume         double precision,
  bid            double precision,
  ask            double precision,
  halted         boolean NOT NULL DEFAULT false,
  upper_circuit  double precision,
  lower_circuit  double precision,
  as_of          timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  provider       text NOT NULL,
  CONSTRAINT quotes_price_positive CHECK (price > 0)
);

-- A short rolling tape per instrument, used for sparklines and for the
-- "what did it do while I was away" mini-chart. Trimmed by the worker.
CREATE TABLE quote_ticks (
  instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  as_of         timestamptz NOT NULL,
  price         double precision NOT NULL,
  volume        double precision,
  PRIMARY KEY (instrument_id, as_of)
);
CREATE INDEX quote_ticks_recent_idx ON quote_ticks (instrument_id, as_of DESC);

CREATE TABLE corporate_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id  uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('dividend','split','bonus','earnings','agm')),
  effective_date date NOT NULL,
  note           text,
  UNIQUE (instrument_id, kind, effective_date)
);
CREATE INDEX corporate_actions_date_idx ON corporate_actions (effective_date);

-- --------------------------------------------------------------- watchlist --

CREATE TABLE watchlists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watchlists_user_idx ON watchlists (user_id, position);

CREATE TABLE watchlist_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id  uuid NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  conviction    text NOT NULL DEFAULT 'tracking'
                CHECK (conviction IN ('core','tracking','background')),
  muted_until   timestamptz,
  position      integer NOT NULL DEFAULT 0,
  note          text,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watchlist_id, instrument_id)
);
CREATE INDEX watchlist_items_list_idx ON watchlist_items (watchlist_id, position);
CREATE INDEX watchlist_items_instrument_idx ON watchlist_items (instrument_id);

CREATE TABLE alert_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('above','below')),
  level         double precision NOT NULL CHECK (level > 0),
  armed         boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_fired_at timestamptz,
  UNIQUE (user_id, instrument_id, kind, level)
);
CREATE INDEX alert_rules_user_idx ON alert_rules (user_id, instrument_id);

-- ------------------------------------------------------------------ events --

-- Instrument-level facts about the market. Produced once per instrument no
-- matter how many users are watching it.
CREATE TABLE change_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigserial NOT NULL UNIQUE,
  instrument_id   uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('up','down','flat')),
  magnitude       double precision NOT NULL,
  peak_magnitude  double precision NOT NULL,
  dedup_key       text NOT NULL,
  headline        text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_date    date NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  update_count    integer NOT NULL DEFAULT 1,
  UNIQUE (instrument_id, kind, dedup_key)
);
CREATE INDEX change_events_seq_idx ON change_events (seq);
CREATE INDEX change_events_instrument_seq_idx ON change_events (instrument_id, seq DESC);
CREATE INDEX change_events_recent_idx ON change_events (last_updated_at DESC);

-- Per-reader state about an instrument-level event: how many times we have
-- already put it in front of them (drives repeat suppression) and whether they
-- explicitly dismissed it.
CREATE TABLE user_event_state (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES change_events(id) ON DELETE CASCADE,
  times_shown     integer NOT NULL DEFAULT 0,
  acknowledged_at timestamptz,
  PRIMARY KEY (user_id, event_id)
);

-- The read cursor. One row per (user, instrument).
--   last_event_seq : highest instrument-level event sequence this user has seen
--   ref_price      : the price on screen when they last looked
-- Both advance monotonically; see src/server/repo/watermarks.ts.
CREATE TABLE watermarks (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument_id  uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  seen_at        timestamptz NOT NULL DEFAULT now(),
  ref_price      double precision,
  ref_as_of      timestamptz,
  ref_direction  text NOT NULL DEFAULT 'flat' CHECK (ref_direction IN ('up','down','flat')),
  last_event_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, instrument_id)
);

-- ------------------------------------------------------ operations support --

-- Transactional outbox. Events are written in the same transaction as the data
-- that produced them, then published to SSE subscribers by a separate reader.
-- Without this, a crash between "commit event" and "notify" silently loses a
-- notification; with it, the worst case is a duplicate, which subscribers
-- de-duplicate by event id.
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Scheduler state: which instruments to poll, how often, and how they are doing.
CREATE TABLE ingest_state (
  instrument_id       uuid PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  tier                text NOT NULL DEFAULT 'warm' CHECK (tier IN ('hot','warm','cold')),
  next_poll_at        timestamptz NOT NULL DEFAULT now(),
  last_polled_at      timestamptz,
  last_success_at     timestamptz,
  consecutive_errors  integer NOT NULL DEFAULT 0,
  last_error          text
);
CREATE INDEX ingest_state_due_idx ON ingest_state (next_poll_at);

CREATE TABLE provider_health (
  provider             text PRIMARY KEY,
  state                text NOT NULL DEFAULT 'closed'
                        CHECK (state IN ('closed','open','half_open')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  opened_at            timestamptz,
  last_success_at      timestamptz,
  last_error           text,
  calls                bigint NOT NULL DEFAULT 0,
  failures             bigint NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
