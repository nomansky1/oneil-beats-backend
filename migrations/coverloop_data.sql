-- CoverLoop web dashboard: per-artist analytics data points.
-- Each artist inputs their own revenue / streams / followers (manual entry or
-- CSV import, parsed client-side); the dashboard reads the aggregates.
-- Scoped by email (the signed-in user's Google/Apple email from their session token).
CREATE TABLE IF NOT EXISTS coverloop_data_points (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  metric      text NOT NULL,                 -- 'revenue' | 'streams' | 'followers'
  source      text NOT NULL DEFAULT 'other', -- 'streaming' | 'youtube' | 'sync' | 'instagram' | ...
  period      date,                          -- month/day the value is for (NULL = undated snapshot)
  value       numeric NOT NULL DEFAULT 0,
  meta        jsonb,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coverloop_data_email_idx ON coverloop_data_points (email);
CREATE INDEX IF NOT EXISTS coverloop_data_email_metric_idx ON coverloop_data_points (email, metric);
