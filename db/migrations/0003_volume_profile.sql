-- Learning each instrument's own intraday volume shape.
--
-- The volume detector compares today's traded volume against how much *should*
-- have traded by this point in a normal session. Until now that comparison used
-- a generic U-shaped curve for every instrument, which is right in aggregate
-- and wrong in the specifics: an index heavyweight and an illiquid small-cap do
-- not distribute their day the same way.
--
-- So the system observes. Each poll records the cumulative volume in the
-- current 15-minute bucket; completed sessions are folded into a running mean
-- on the instrument and the raw rows are dropped. The blend in
-- `buildBaseline` is weighted by how many sessions we have actually seen, so
-- the generic curve dominates on day three and the instrument's own shape
-- dominates after a month.

CREATE TABLE intraday_volume (
  instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  session_date  date NOT NULL,
  -- 0..24, one per 15 minutes of the 375-minute session.
  bucket        smallint NOT NULL CHECK (bucket BETWEEN 0 AND 24),
  cum_volume    double precision NOT NULL CHECK (cum_volume >= 0),
  PRIMARY KEY (instrument_id, session_date, bucket)
);
CREATE INDEX intraday_volume_session_idx ON intraday_volume (session_date);

-- The observed mean, kept separately from `volume_profile` because that column
-- holds the *blend* that detection actually uses. Overwriting the observation
-- with the blend would let the generic curve slowly contaminate the thing it is
-- supposed to be replaced by.
ALTER TABLE instruments
  ADD COLUMN volume_profile_observed jsonb NOT NULL DEFAULT '[]'::jsonb;
