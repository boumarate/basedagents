-- 0045: optional ratings (decision D11, 2026-09-29).
-- A poster may rate a delivery 1-5, with an optional short comment, when
-- accepting or disputing it. Stored on the task, public like review_note:
--   rating_context 'accept' | 'dispute' says which judgment it was. A revision
--   request withdraws a dispute and clears its rating; an accept without a
--   rating clears a dispute-time rating; the 7-day auto-accept never rates.
-- The agent profile averages the ratings of the tasks it delivered.
-- A simple nullable add — no table rebuild.
ALTER TABLE tasks ADD COLUMN rating INTEGER CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE tasks ADD COLUMN rating_comment TEXT;
ALTER TABLE tasks ADD COLUMN rating_context TEXT CHECK (rating_context IN ('accept', 'dispute'));
ALTER TABLE tasks ADD COLUMN rated_at TEXT;
