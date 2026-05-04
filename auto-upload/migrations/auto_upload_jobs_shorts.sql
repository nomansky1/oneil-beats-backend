-- Adds Shorts auto-fanout columns to auto_upload_jobs.
--
-- After a beat's longform YouTube upload succeeds, the worker also renders
-- a 60s 9:16 version and uploads it as a YouTube Short. This lets one beat
-- generate two YouTube videos (longform + Short) without changing the
-- one-row-per-beat schema or adding a separate platform queue.
--
-- short_path is a local-disk path (cached between retries via the same
-- pattern as video_path / vertical_path / thumbnail_path).
-- youtube_short_id / _url are the published Short's metadata.

alter table auto_upload_jobs
  add column if not exists short_path text,
  add column if not exists youtube_short_id text,
  add column if not exists youtube_short_url text;
