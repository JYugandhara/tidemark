-- Repeat suppression has to count *viewings*, not *fetches*.
--
-- `times_shown` feeds the novelty multiplier: the third time we put the same
-- story in front of someone it scores lower than the first. That is right, but
-- the counter was incremented on every digest request — and this client
-- refetches on a 45-second safety timer and again, debounced, whenever a change
-- event arrives on the stream.
--
-- The effect was that a page left open quietly suppressed its own alerts: an
-- event would surface, the page would refresh a few times, and within a couple
-- of minutes the same genuine 3-sigma move had been multiplied down below the
-- tide line without the reader ever having done anything.
--
-- So the counter now advances at most once per cooling-off window. Two views a
-- second apart are one viewing; two views an hour apart are two.

ALTER TABLE user_event_state
  ADD COLUMN last_shown_at timestamptz;

-- Existing rows have been shown at least once; treat them as shown just now so
-- the first post-migration render does not double-count them.
UPDATE user_event_state SET last_shown_at = now() WHERE times_shown > 0;
