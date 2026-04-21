// Supabase-backed job queue. Each beat gets one row in `auto_upload_jobs`.
// Platform status transitions: pending → uploading → done | failed
//                                                      ↑ retried until MAX_ATTEMPTS
//
// We claim work atomically (UPDATE … WHERE status='pending' RETURNING *) so if
// you ever run two workers they won't double-process the same platform.

const { createClient } = require('@supabase/supabase-js');
const cfg = require('./config');

const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const TABLE = 'auto_upload_jobs';
const PLATFORMS = ['youtube', 'instagram', 'tiktok'];

// ── Enqueue ───────────────────────────────────────────────────────────────
// Inserts a new job. If a row for this beat_id already exists, returns the
// existing row and does NOT duplicate.
//
// Accepts either:
//   { audioUrl, coverUrl }   — worker will synthesize the video (normal path)
//   { videoPath, albumCoverPath }  — legacy, if you already have a local mp4
async function enqueue(beat) {
  const row = {
    beat_id: beat.id || beat.beat_id,
    beat_title: beat.title,
    beat_slug: beat.slug || slugify(beat.title),
    beat_genre: beat.genre,
    beat_bpm: beat.bpm || null,
    beat_key: beat.key || null,
    beat_mood: beat.mood || null,
    audio_url: beat.audioUrl || null,
    video_path: beat.videoPath || null,
    album_cover_path: beat.albumCoverPath || beat.coverUrl || null,
    youtube_scheduled_at: new Date().toISOString(),  // YT runs immediately
    // IG / TT scheduled_at stay null until YT finishes, then we set them.
  };
  if (!row.audio_url && !row.video_path) {
    throw new Error('enqueue: need audioUrl (for synthesis) or videoPath (pre-rendered)');
  }

  // On conflict (beat_id) do nothing → select existing.
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'beat_id', ignoreDuplicates: true })
    .select()
    .maybeSingle();

  if (error) throw new Error(`enqueue failed: ${error.message}`);
  if (data) return data;

  // Upsert ignored it — fetch existing.
  const existing = await supabase.from(TABLE).select('*').eq('beat_id', row.beat_id).maybeSingle();
  return existing.data;
}

// ── Claim next runnable job for a platform ────────────────────────────────
// Returns one row that is (a) pending, (b) due (scheduled_at <= now), (c) not
// exceeded max attempts. Flips its status to 'uploading' atomically so another
// worker tick can't grab the same one.
async function claimNext(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error(`bad platform: ${platform}`);
  const statusCol = `${platform}_status`;
  const schedCol  = `${platform}_scheduled_at`;
  const attemptsCol = `${platform}_attempts`;

  // Step 1: find a candidate id. We do the update-by-id in step 2 so we can
  // express the "schedule in the past AND attempts<MAX" filter cleanly in
  // PostgREST — chained .eq/.lt/.lte on the update is what gives us atomicity.
  const { data: candidates, error: selErr } = await supabase
    .from(TABLE)
    .select('id')
    .eq(statusCol, 'pending')
    .lte(schedCol, new Date().toISOString())
    .lt(attemptsCol, cfg.MAX_ATTEMPTS)
    .order(schedCol, { ascending: true })
    .limit(1);
  if (selErr) throw new Error(`claim select failed: ${selErr.message}`);
  if (!candidates || candidates.length === 0) return null;

  const id = candidates[0].id;

  // Step 2: atomic claim — only succeeds if status is still 'pending'.
  const { data: claimed, error: updErr } = await supabase
    .from(TABLE)
    .update({ [statusCol]: 'uploading' })
    .eq('id', id)
    .eq(statusCol, 'pending')
    .select()
    .maybeSingle();
  if (updErr) throw new Error(`claim update failed: ${updErr.message}`);
  return claimed; // null means another worker beat us to it — caller retries.
}

// ── Record success ────────────────────────────────────────────────────────
async function markSuccess(id, platform, { externalId, publicUrl }) {
  const patch = {
    [`${platform}_status`]: 'done',
    [`${platform}_id`]:      externalId || null,
    [`${platform}_url`]:     publicUrl || null,
  };
  const { error } = await supabase.from(TABLE).update(patch).eq('id', id);
  if (error) throw new Error(`markSuccess failed: ${error.message}`);
}

// ── Record failure + decide retry ─────────────────────────────────────────
// Bumps attempts. If attempts >= MAX, marks 'failed' so the cron skips it.
// Otherwise leaves status 'pending' so the next tick re-tries (with a small
// backoff baked into scheduled_at).
async function markFailure(id, platform, errMsg) {
  // Pull current attempts — Supabase JS doesn't expose atomic increments
  // without an RPC, and contention here is vanishingly low.
  const { data: row, error: selErr } = await supabase
    .from(TABLE).select(`${platform}_attempts`).eq('id', id).maybeSingle();
  if (selErr) throw new Error(`markFailure select failed: ${selErr.message}`);
  const attempts = (row?.[`${platform}_attempts`] || 0) + 1;
  const exhausted = attempts >= cfg.MAX_ATTEMPTS;

  // Exponential backoff: 15m, 30m, 60m from now for retries 1/2/3.
  const backoffMin = Math.min(15 * Math.pow(2, attempts - 1), 60);
  const nextAt = new Date(Date.now() + backoffMin * 60_000).toISOString();

  const patch = {
    [`${platform}_attempts`]: attempts,
    [`${platform}_status`]:   exhausted ? 'failed' : 'pending',
    [`${platform}_scheduled_at`]: exhausted ? null : nextAt,
    last_error: String(errMsg || '').slice(0, 2000),
  };
  const { error } = await supabase.from(TABLE).update(patch).eq('id', id);
  if (error) throw new Error(`markFailure failed: ${error.message}`);
}

// ── After YouTube lands, schedule IG + TT with random stagger ────────────
// `enable` lets the caller opt specific platforms in/out (YouTube-only
// deployments pass { instagram:false, tiktok:false } — scheduled_at stays
// null and the claim query never picks them up).
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
  const { error } = await supabase.from(TABLE).update(patch).eq('id', id);
  if (error) throw new Error(`scheduleDownstream failed: ${error.message}`);
  return result;
}

// Cache generated derivatives so a retry doesn't re-run FFmpeg.
async function saveDerivatives(id, { videoPath, verticalPath, thumbnailPath, albumCoverPath }) {
  const patch = {};
  if (videoPath)       patch.video_path       = videoPath;
  if (verticalPath)    patch.vertical_path    = verticalPath;
  if (thumbnailPath)   patch.thumbnail_path   = thumbnailPath;
  if (albumCoverPath)  patch.album_cover_path = albumCoverPath;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from(TABLE).update(patch).eq('id', id);
  if (error) throw new Error(`saveDerivatives failed: ${error.message}`);
}

async function getJob(id) {
  const { data } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  return data;
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
  getJob,
  PLATFORMS,
};
