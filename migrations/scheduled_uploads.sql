-- Scheduled uploads — Phase 1 of the EXE scheduler feature.
-- Adds the ability to schedule a beat to "go live" at a future time. The beat
-- row is inserted with active=false + scheduled_for=<future ts>, hidden from
-- public queries until the cron flips it.
--
-- Run once in Supabase SQL editor.

ALTER TABLE beats ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;

-- Partial index: only the small set of beats that are actually waiting to
-- publish. Keeps the cron-tick query fast even as the catalog grows.
CREATE INDEX IF NOT EXISTS beats_scheduled_for_idx
  ON beats(scheduled_for)
  WHERE active = false AND scheduled_for IS NOT NULL;
