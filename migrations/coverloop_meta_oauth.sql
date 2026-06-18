-- coverloop_meta_oauth — transient handoff for CoverLoop's per-user Meta connect.
-- The desktop app opens /coverloop/meta/start with a random `state`; Meta redirects
-- to /coverloop/meta/callback (server-side, so the App Secret stays on the backend);
-- the app then polls /coverloop/meta/poll?state=... to fetch the discovered Pages +
-- linked Instagram accounts. Rows are written once and deleted on first read.
--
-- Multi-tenant: one row per in-flight connect, keyed by the nonce — never tied to a
-- specific user/account in code. Run via scripts/apply-coverloop-migration.mjs style.

CREATE TABLE IF NOT EXISTS coverloop_meta_oauth (
  state      text PRIMARY KEY,
  payload    jsonb,
  created_at timestamptz DEFAULT now()
);

-- RLS on with no public policy: anon/PostgREST can't read these handoff rows.
-- The backend reads/writes via the direct Postgres pooler role (bypasses RLS).
ALTER TABLE coverloop_meta_oauth ENABLE ROW LEVEL SECURITY;
