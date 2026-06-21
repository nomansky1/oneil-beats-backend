-- CoverLoop: per-artist connected platform accounts (OAuth token vault).
-- Each artist links their OWN YouTube / Meta / Spotify / SoundCloud account; we
-- store the tokens (ENCRYPTED at rest) and periodically pull their metrics into
-- coverloop_data_points so they flow onto the dashboard. Scoped by email.
CREATE TABLE IF NOT EXISTS coverloop_platform_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  platform      text NOT NULL,            -- 'youtube' | 'meta' | 'spotify' | 'soundcloud'
  account_id    text,                      -- platform-side id (channel/page/user id)
  account_name  text,                      -- display name shown in the UI
  access_token  text,                      -- AES-256-GCM encrypted
  refresh_token text,                      -- AES-256-GCM encrypted
  expires_at    timestamptz,
  scopes        text,
  profile       jsonb,                     -- non-secret extras (avatar, urls, counts)
  connected_at  timestamptz DEFAULT now(),
  last_sync     timestamptz,
  last_error    text,
  UNIQUE (email, platform)
);
CREATE INDEX IF NOT EXISTS coverloop_platform_email_idx ON coverloop_platform_accounts (email);
