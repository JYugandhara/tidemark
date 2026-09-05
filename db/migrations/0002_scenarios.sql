-- Scenario injection.
--
-- Resilience claims are cheap; a resilience *demonstration* is not. This table
-- lets an operator (or a judge, from the Feed Room in the UI) force the exact
-- failures that are otherwise impossible to schedule: a trading halt, a
-- decimal-point error in an incoming print, a feed that goes silent, an
-- upstream provider that stops answering entirely.
--
-- Scenarios are data, not code paths: the ingestion pipeline has no idea it is
-- being tested. Whatever it does under an injected fault is exactly what it
-- would do under a real one.

CREATE TABLE scenarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL means "applies to every instrument", used by provider-level faults.
  instrument_id uuid REFERENCES instruments(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN (
                  'halt','gap','spike','circuit','stale','bad_print',
                  'volume_surge','provider_outage','latency'
                )),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  created_by    text
);
CREATE INDEX scenarios_active_idx ON scenarios (expires_at DESC);
CREATE INDEX scenarios_instrument_idx ON scenarios (instrument_id, expires_at DESC);
