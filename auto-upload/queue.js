// Postgres-backed job queue. Each beat gets one row in `auto_upload_jobs`.
// Platform status transitions: pending → uploading → done | failed
//                                                      ↑ retried until MAX_ATTEMPTS
//
// We claim work atomically (UPDATE … WHERE status='pending' RETURNING *) so if
// you ever run two workers they won't double-process the same platform.
//
// 2026-05-08: switched from supabase-js (PostgREST) to direct pg via the
// shared Supavisor pool in ../supabaseApi.js. PostgREST is gated by Supabase
// quota restrictions; direct Postgres still works.

const { pgQuery, getSupabaseClient } = require('../supabaseApi');
const cfg = require('./config');

// Preserved export for ../processors/instagram.js, which still calls
// `supabase.storage.*` for the IG Reels public-URL flow. DB calls in this
// file go through pgQuery; only Storage stays on supabase-js.
const supabase = getSupabaseClient();

const TABLE = 'auto_upload_jobs';
const PLATFORMS = ['youtube', 'instagram', 'tiktok'];

// Allow-list every column we ever PATCH so we never interpolate user-supplied
// strings into the SQL identifier position.
const COLUMNS = new Set([
  'beat_title', 'beat_slug', 'beat_genre', 'beat_bpm', 'beat_key', 'beat_mood',
  'audio_url', 'video_path', 'album_cover_path', 'description_override',
  'is_short', 'last_error',
  'video_path', 'vertical_path', 'thumbnail_path', 'short_path',
  'youtube_short_id', 'youtube_short_url',
  ...PLATFORMS.flatMap(p => [
    `${p}_status`, `${p}_scheduled_at`, `${p}_attempts`, `${p}_id`, `${p}_url`,
  ]),
]);

function buildUpdateSql(patch, idParamIndex) {
  const setParts = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!COLUMNS.has(k)) throw new Error(`buildUpdateSql: unknown column ${k}`);
    values.push(v);
    setParts.push(`"${k}" = $${values.length}`);
  }
  return { setSql: setParts.join(', '), values };
}

// ── Enqueue ───────────────────────────────────────────────────────────────
// Inserts a new job. If a row for this beat_id already exists, returns the
// existing row and does NOT duplicate.
//
// Accepts either:
//   { audioUrl, coverUrl }   — worker will synthesize the video (normal path)
//   { videoPath, albumCoverPath }  — legacy, if you already have a local mp4
async function enqueue(beat) {
  // If the caller passed a future scheduledAt, honor it. Otherwise run YT now.
  // ISO string; invalid/past values collapse back to `now()` so a bad picker
  // value can't silently park a job forever.
  let scheduledYT = new Date().toISOString();
  if (beat.scheduledAt) {
    const d = new Date(beat.scheduledAt);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now()) scheduledYT = d.toISOString();
  }

  const beatId = beat.id || beat.beat_id;
  const audioUrl = beat.audioUrl || null;
  const videoPath = beat.videoPath || null;
  const albumCoverPath = beat.albumCoverPath || beat.coverUrl || null;
  if (!audioUrl && !videoPath) {
    throw new Error('enqueue: need audioUrl (for synthesis) or videoPath (pre-rendered)');
  }

  // Scheduling a new upload for an existing beat (e.g. re-render with a better
  // template) should REPLACE the old job, not silently ignore.
  const { rows: existingRows } = await pgQuery(
    `SELECT id, youtube_status FROM ${TABLE} WHERE beat_id = $1 LIMIT 1`,
    [beatId]
  );

  if (existingRows.length > 0) {
    const existing = existingRows[0];
    // Only reset YouTube if it's not already done — don't re-publish live videos.
    const canReset = existing.youtube_status !== 'done' && existing.youtube_status !== 'uploading';
    const patch = {
      beat_title: beat.title,
      beat_slug: beat.slug || slugify(beat.title),
      beat_genre: beat.genre,
      beat_bpm: beat.bpm || null,
      beat_key: beat.key || null,
      beat_mood: beat.mood || null,
      audio_url: audioUrl,
      video_path: videoPath,
      album_cover_path: albumCoverPath,
      description_override: beat.descriptionOverride || null,
      is_short: beat.isShort === true,
    };
    if (canReset) {
      patch.youtube_scheduled_at = scheduledYT;
      patch.youtube_status = 'pending';
      patch.youtube_attempts = 0;
      patch.last_error = null;
    }
    const { setSql, values } = buildUpdateSql(patch, 0);
    values.push(existing.id);
    const { rows } = await pgQuery(
      `UPDATE ${TABLE} SET ${setSql} WHERE id = $${values.length} RETURNING *`,
      values
    );
    return rows[0];
  }

  const { rows } = await pgQuery(
    `INSERT INTO ${TABLE} (
       beat_id, beat_title, beat_slug, beat_genre, beat_bpm, beat_key, beat_mood,
       audio_url, video_path, album_cover_path, description_override, is_short,
       youtube_scheduled_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      beatId,
      beat.title,
      beat.slug || slugify(beat.title),
      beat.genre,
      beat.bpm || null,
      beat.key || null,
      beat.mood || null,
      audioUrl,
      videoPath,
      albumCoverPath,
      beat.descriptionOverride || null,
      beat.isShort === true,
      scheduledYT,
    ]
  );
  return rows[0];
}

// ── Claim next runnable job for a platform ────────────────────────────────
// Returns one row that is (a) pending, (b) due (scheduled_at <= now), (c) not
// exceeded max attempts. Flips its status to 'uploading' atomically so another
// worker tick can't grab the same one.
async function claimNext(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error(`bad platform: ${platform}`);
  const statusCol = `"${platform}_status"`;
  const schedCol  = `"${platform}_scheduled_at"`;
  const attemptsCol = `"${platform}_attempts"`;

  // Single statement: atomic update of the oldest eligible row.
  // FOR UPDATE SKIP LOCKED would let parallel workers coexist; here we use
  // a self-join because Supavisor transaction-mode doesn't preserve that lock
  // across statements anyway.
  const { rows } = await pgQuery(
    `UPDATE ${TABLE}
        SET ${statusCol} = 'uploading'
      WHERE id = (
        SELECT id FROM ${TABLE}
         WHERE ${statusCol} = 'pending'
           AND ${schedCol} <= now()
           AND COALESCE(${attemptsCol}, 0) < $1
         ORDER BY ${schedCol} ASC
         LIMIT 1
      )
      RETURNING *`,
    [cfg.MAX_ATTEMPTS]
  );
  return rows[0] || null;
}

// ── Record success ────────────────────────────────────────────────────────
async function markSuccess(id, platform, { externalId, publicUrl }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`bad platform: ${platform}`);
  await pgQuery(
    `UPDATE ${TABLE}
        SET "${platform}_status" = 'done',
            "${platform}_id"     = $1,
            "${platform}_url"    = $2
      WHERE id = $3`,
    [externalId || null, publicUrl || null, id]
  );
}

// ── Record failure + decide retry ─────────────────────────────────────────
// Bumps attempts. If attempts >= MAX, marks 'failed' so the cron skips it.
// Otherwise leaves status 'pending' so the next tick re-tries (with a small
// backoff baked into scheduled_at).
async function markFailure(id, platform, errMsg) {
  if (!PLATFORMS.includes(platform)) throw new Error(`bad platform: ${platform}`);
  const { rows: priorRows } = await pgQuery(
    `SELECT "${platform}_attempts" AS attempts FROM ${TABLE} WHERE id = $1`,
    [id]
  );
  const attempts = (priorRows[0]?.attempts || 0) + 1;
  const exhausted = attempts >= cfg.MAX_ATTEMPTS;

  // Exponential backoff: 15m, 30m, 60m from now for retries 1/2/3.
  const backoffMin = Math.min(15 * Math.pow(2, attempts - 1), 60);
  const nextAt = new Date(Date.now() + backoffMin * 60_000).toISOString();

  await pgQuery(
    `UPDATE ${TABLE}
        SET "${platform}_attempts"     = $1,
            "${platform}_status"       = $2,
            "${platform}_scheduled_at" = $3,
            last_error                  = $4
      WHERE id = $5`,
    [attempts, exhausted ? 'failed' : 'pending', exhausted ? null : nextAt,
     String(errMsg || '').slice(0, 2000), id]
  );
}

// ── After YouTube lands, schedule IG + TT with random stagger ────────────
async function scheduleDownstream(id, enable = { instagram: true, tiktok: true }) {
  const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
  const patch = {};
  const result = {};
  if (enable.instagram) {
    const at = new Date(Date.now() + rnd(cfg.IG_DELAY_MIN_MINUTES, cfg.IG_DELAY_MAX_MINUTES) * 60_000).toISOString();
    patch.instagram_scheduled_at = at;
    result.instagram = at;
  }
  if (enable.tiktok) {
    const at = new Date(Date.now() + rnd(cfg.TT_DELAY_MIN_MINUTES, cfg.TT_DELAY_MAX_MINUTES) * 60_000).toISOString();
    patch.tiktok_scheduled_at = at;
    result.tiktok = at;
  }
  if (Object.keys(patch).length === 0) return result;
  const { setSql, values } = buildUpdateSql(patch, 0);
  values.push(id);
  await pgQuery(`UPDATE ${TABLE} SET ${setSql} WHERE id = $${values.length}`, values);
  return result;
}

// Cache generated derivatives so a retry doesn't re-run FFmpeg.
async function saveDerivatives(id, { videoPath, verticalPath, thumbnailPath, albumCoverPath, shortPath }) {
  const patch = {};
  if (videoPath)       patch.video_path       = videoPath;
  if (verticalPath)    patch.vertical_path    = verticalPath;
  if (thumbnailPath)   patch.thumbnail_path   = thumbnailPath;
  if (albumCoverPath)  patch.album_cover_path = albumCoverPath;
  if (shortPath)       patch.short_path       = shortPath;
  if (Object.keys(patch).length === 0) return;
  const { setSql, values } = buildUpdateSql(patch, 0);
  values.push(id);
  await pgQuery(`UPDATE ${TABLE} SET ${setSql} WHERE id = $${values.length}`, values);
}

// Persist the YouTube Shorts companion upload's id + url.
async function markYouTubeShortPublished(id, { externalId, publicUrl }) {
  await pgQuery(
    `UPDATE ${TABLE} SET youtube_short_id = $1, youtube_short_url = $2 WHERE id = $3`,
    [externalId || null, publicUrl || null, id]
  );
}

async function getJob(id) {
  const { rows } = await pgQuery(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
  return rows[0] || null;
}

// ── Queue list for the admin UI ──────────────────────────────────────────
// Returns the N most recent jobs for a platform, in schedule order. Includes
// done + failed so the user sees what ran + what errored, not just upcoming.
async function listJobs({ platform = 'youtube', limit = 50 } = {}) {
  if (!PLATFORMS.includes(platform)) throw new Error(`bad platform: ${platform}`);
  const schedCol = `"${platform}_scheduled_at"`;
  const { rows } = await pgQuery(
    `SELECT id, beat_id, beat_title, beat_genre, is_short, last_error,
            "${platform}_status"       AS ${platform}_status,
            "${platform}_scheduled_at" AS ${platform}_scheduled_at,
            "${platform}_attempts"     AS ${platform}_attempts,
            "${platform}_id"           AS ${platform}_id,
            "${platform}_url"          AS ${platform}_url
       FROM ${TABLE}
      ORDER BY ${schedCol} ASC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// ── Cancel / reschedule ──────────────────────────────────────────────────
async function cancelJob(id, platform = 'youtube') {
  if (!PLATFORMS.includes(platform)) throw new Error(`bad platform: ${platform}`);
  await pgQuery(
    `UPDATE ${TABLE}
        SET "${platform}_status" = 'failed',
            "${platform}_scheduled_at" = NULL,
            last_error = 'cancelled by user'
      WHERE id = $1`,
    [id]
  );
}

async function rescheduleJob(id, platform, scheduledAt) {
  if (!PLATFORMS.includes(platform)) throw new Error(`bad platform: ${platform}`);
  const d = new Date(scheduledAt);
  if (isNaN(d.getTime())) throw new Error('rescheduleJob: invalid scheduledAt');
  await pgQuery(
    `UPDATE ${TABLE}
        SET "${platform}_scheduled_at" = $1,
            "${platform}_status"       = 'pending',
            last_error = NULL
      WHERE id = $2`,
    [d.toISOString(), id]
  );
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

module.exports = {
  supabase,
  enqueue,
  claimNext,
  markSuccess,
  markFailure,
  scheduleDownstream,
  saveDerivatives,
  markYouTubeShortPublished,
  getJob,
  listJobs,
  cancelJob,
  rescheduleJob,
  PLATFORMS,
};
