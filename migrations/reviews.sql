-- Reviews table for per-beat customer reviews.
-- Powers the AggregateRating + Review schema in beat-page JSON-LD,
-- which surfaces ⭐ star ratings in Google search results.
--
-- Run this in Supabase SQL Editor before reviews can be accepted.

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beat_id uuid NOT NULL REFERENCES beats(id) ON DELETE CASCADE,
  customer_email text NOT NULL,
  customer_name text,
  rating int NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title text,
  body text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  verified_purchase boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  approved_at timestamptz,
  -- One review per buyer per beat (prevents review-bombing)
  UNIQUE (beat_id, customer_email)
);

CREATE INDEX IF NOT EXISTS reviews_beat_id_idx ON reviews(beat_id);
CREATE INDEX IF NOT EXISTS reviews_status_idx ON reviews(status);
CREATE INDEX IF NOT EXISTS reviews_created_at_idx ON reviews(created_at DESC);

-- Row-level security: anyone can SELECT approved reviews; only service_role
-- can INSERT/UPDATE (the backend handles all writes via service key).
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read approved reviews" ON reviews;
CREATE POLICY "Public read approved reviews"
  ON reviews FOR SELECT
  USING (status = 'approved');

-- Optional: a view for the schema-injection step that pre-aggregates
-- counts and averages per beat. Lets the build script do one query
-- instead of N+1.
CREATE OR REPLACE VIEW beat_review_aggregates AS
SELECT
  beat_id,
  COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
  ROUND(AVG(rating) FILTER (WHERE status = 'approved')::numeric, 2) AS avg_rating,
  MAX(approved_at) AS last_review_at
FROM reviews
GROUP BY beat_id;
