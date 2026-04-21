-- One row per beat. Per-platform columns so we can stagger uploads across
-- YouTube / Instagram Reels / TikTok independently and see the whole lifecycle
-- on a single row. beat_id is unique so the same beat can't be queued twice
-- (duplicate prevention).

create table if not exists auto_upload_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Beat metadata (denormalized so we can rebuild copy/tags without a join)
  beat_id      text not null,
  beat_title   text not null,
  beat_slug    text not null,
  beat_genre   text not null,
  beat_bpm     int,
  beat_key     text,
  beat_mood    text,

  -- Sources. The worker synthesizes a 16:9 MP4 from audio_url + cover on
  -- first tick, then caches the local path in video_path. If your upstream
  -- produces a video directly, you can set video_path on enqueue and skip
  -- audio_url — the worker treats either as a starting point.
  audio_url         text,             -- remote URL (Supabase storage public link)
  album_cover_path  text,             -- URL or local path; used for cover + thumbnail
  video_path        text,             -- set after synthesis OR on enqueue if you have one
  vertical_path     text,             -- 9:16 blur-pad (worker-generated)
  thumbnail_path    text,             -- 1280×720 neon JPG (worker-generated)

  -- Per-platform state. status ∈ {pending, uploading, done, failed, skipped}
  youtube_id          text,
  youtube_url         text,
  youtube_status      text not null default 'pending',
  youtube_scheduled_at timestamptz not null default now(),
  youtube_attempts    int  not null default 0,

  instagram_id          text,
  instagram_url         text,
  instagram_status      text not null default 'pending',
  instagram_scheduled_at timestamptz,  -- set when YouTube lands
  instagram_attempts    int  not null default 0,

  tiktok_id          text,
  tiktok_url         text,
  tiktok_status      text not null default 'pending',
  tiktok_scheduled_at timestamptz,  -- set when YouTube lands
  tiktok_attempts    int  not null default 0,

  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Duplicate prevention: only one job per beat.
create unique index if not exists auto_upload_jobs_beat_id_uniq
  on auto_upload_jobs(beat_id);

-- Cron scanner index: "any platform ready to run right now".
create index if not exists auto_upload_jobs_yt_ready
  on auto_upload_jobs(youtube_scheduled_at) where youtube_status = 'pending';
create index if not exists auto_upload_jobs_ig_ready
  on auto_upload_jobs(instagram_scheduled_at) where instagram_status = 'pending';
create index if not exists auto_upload_jobs_tt_ready
  on auto_upload_jobs(tiktok_scheduled_at) where tiktok_status = 'pending';

-- updated_at auto-bump
create or replace function auto_upload_jobs_touch() returns trigger as $$
begin new.updated_at := now(); return new; end; $$ language plpgsql;

drop trigger if exists auto_upload_jobs_touch on auto_upload_jobs;
create trigger auto_upload_jobs_touch before update on auto_upload_jobs
  for each row execute function auto_upload_jobs_touch();
