// Inline Meta (Facebook Page + Instagram Reels) publisher for the "Publish Now"
// button. Parallel companion to inline-publisher.js (which handles YouTube).
//
// Separation is deliberate: the YouTube duplicate-upload fix in inline-publisher.js
// must not be touched when adding Meta. See skill_youtube_publish_no_duplicates.md.
//
// Flow differences from processors/instagram.js (scheduled queue):
//  - Queue version takes job.vertical_path (pre-rendered by media.makeVertical)
//  - This inline version takes the local videoPath from publishNow's tmp dir
//    and generates the vertical variant on demand via media.makeVertical
//
// Facebook Page video flow:
//  1. POST /{page-id}/videos with multipart file_url=null + source=<file>
//     (direct multipart upload — no Supabase pre-hosting needed for FB)
//  2. Returns { id } which is the video post id; permalink is built from it.
//
// Instagram Reels flow:
//  1. Upload vertical 9:16 mp4 to Supabase Storage (public bucket)
//  2. POST /{ig-user-id}/media with media_type=REELS, video_url=<public-url>
//  3. Poll /{container-id}?fields=status_code until FINISHED
//  4. POST /{ig-user-id}/media_publish with creation_id
//  5. Delete temp Supabase object
//
// Both are best-effort — failures don't throw, they return { error } so
// inline-publisher.js can show partial success (YT live + FB ok + IG failed).

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const media = require('./media');
const copy = require('./copy');
const cfg = require('./config');
const metaToken = require('./meta-token');

// Lazy-require queue for Supabase client (IG needs storage upload).
let _queue = null;
function getQueue() {
  if (_queue !== null) return _queue;
  try { _queue = require('./queue'); } catch (_) { _queue = {}; }
  return _queue;
}

const GRAPH = 'https://graph.facebook.com/v20.0';

function logLine(msg) {
  const ts = new Date().toISOString();
  console.log(`[publish-meta ${ts}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ────────────────────────────────────────────────────────────────────────────
// FACEBOOK PAGE VIDEO
// ────────────────────────────────────────────────────────────────────────────

// Post a video directly to a Facebook Page via multipart upload.
// Returns { videoId, permalink, pageId } or { error } on failure.
async function publishToFacebookPage({ beat, videoPath, narrative }) {
  if (!cfg.ENABLE_FACEBOOK) {
    logLine('FB disabled — skipping');
    return { skipped: true, reason: 'ENABLE_FACEBOOK=false' };
  }
  if (!fs.existsSync(videoPath)) {
    return { error: `videoPath not found: ${videoPath}` };
  }

  const t0 = Date.now();
  try {
    const title = copy.buildYouTubeTitle(beat);
    const description = copy.buildYouTubeDescription(beat, narrative);

    logLine(`FB: uploading to Page ${cfg.FB_PAGE_ID} bytes=${fs.statSync(videoPath).size}`);

    const form = new FormData();
    form.append('title', title.slice(0, 255));
    form.append('description', description.slice(0, 5000));
    form.append('access_token', cfg.FB_PAGE_ACCESS_TOKEN);
    form.append('source', fs.createReadStream(videoPath), {
      filename: path.basename(videoPath),
      contentType: 'video/mp4',
    });

    const url = `${GRAPH}/${cfg.FB_PAGE_ID}/videos`;
    const res = await axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 10 * 60 * 1000, // 10 min — FB video upload can be slow for larger files
    });

    const videoId = res?.data?.id;
    if (!videoId) return { error: 'FB returned no video id' };

    const permalink = `https://www.facebook.com/${cfg.FB_PAGE_ID}/videos/${videoId}`;
    logLine(`FB: done videoId=${videoId} elapsed=${Date.now() - t0}ms url=${permalink}`);
    return { videoId, permalink, pageId: cfg.FB_PAGE_ID };
  } catch (e) {
    const detail = e?.response?.data?.error?.message || e?.message || String(e);
    logLine(`FB: failed after ${Date.now() - t0}ms: ${detail}`);
    return { error: detail };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// INSTAGRAM REELS
// ────────────────────────────────────────────────────────────────────────────

// Post a Reel via Meta Graph API. Requires the video to be at a public URL,
// so we push the 9:16 mp4 to Supabase Storage first, then tell Meta to pull it.
// Returns { mediaId, permalink } or { error }.
async function publishToInstagramReels({ beat, verticalVideoPath }) {
  if (!cfg.ENABLE_INSTAGRAM) {
    logLine('IG disabled — skipping');
    return { skipped: true, reason: 'ENABLE_INSTAGRAM=false' };
  }
  if (!fs.existsSync(verticalVideoPath)) {
    return { error: `verticalVideoPath not found: ${verticalVideoPath}` };
  }
  const q = getQueue();
  if (!q.supabase) {
    return { error: 'Supabase client unavailable (queue module not loaded)' };
  }

  const t0 = Date.now();
  const objectKey = `reels/${beat.id}-${Date.now()}.mp4`;
  let uploaded = false;

  try {
    // 1. Upload to Supabase public bucket
    logLine(`IG: uploading vertical to Supabase ${cfg.STORAGE_BUCKET}/${objectKey}`);
    const fileBuf = fs.readFileSync(verticalVideoPath);
    const up = await q.supabase.storage.from(cfg.STORAGE_BUCKET).upload(objectKey, fileBuf, {
      contentType: 'video/mp4', upsert: true,
    });
    if (up.error) return { error: `supabase upload: ${up.error.message}` };
    uploaded = true;
    const pub = q.supabase.storage.from(cfg.STORAGE_BUCKET).getPublicUrl(objectKey);
    const videoUrl = pub.data.publicUrl;
    logLine(`IG: Supabase URL ready ${videoUrl}`);

    // 2. Create media container
    const caption = copy.buildSocialCaption(beat);
    const create = await axios.post(`${GRAPH}/${cfg.IG_USER_ID}/media`, null, {
      params: {
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        share_to_feed: true,
        access_token: cfg.IG_ACCESS_TOKEN,
      },
      timeout: 30_000,
    });
    const creationId = create?.data?.id;
    if (!creationId) return { error: 'IG did not return a container id' };
    logLine(`IG: container created id=${creationId}`);

    // 3. Poll until FINISHED (up to 5 min for long-form videos)
    // 2026-04-27: Meta returns transient `status_code:ERROR` during the first
    // 30-60s of ingest for long videos (3+ min). The container often recovers
    // and reaches FINISHED. Confirmed via manual /media_publish on a container
    // that the old code reported "ERROR" — it published successfully. New
    // policy: keep polling for ERROR until 60s elapsed or status flips to
    // FINISHED. Only EXPIRED is a hard fail (Meta says container is dead).
    const deadline = Date.now() + 5 * 60_000;
    const errGraceMs = 90_000; // ignore ERROR for first 90s
    const t0Poll = Date.now();
    let statusCode = 'IN_PROGRESS';
    let lastStatusText = '';
    let errorObservedAt = 0;
    while (Date.now() < deadline) {
      await sleep(5000);
      let s;
      try {
        s = await axios.get(`${GRAPH}/${creationId}`, {
          params: { fields: 'status_code,status', access_token: cfg.IG_ACCESS_TOKEN },
          timeout: 15_000,
        });
      } catch (pollErr) {
        logLine(`IG: poll failed (transient, retrying): ${pollErr.message}`);
        continue;
      }
      statusCode = s?.data?.status_code;
      lastStatusText = s?.data?.status || '';
      const elapsed = ((Date.now() - t0Poll) / 1000).toFixed(0);
      logLine(`IG: container status ${statusCode} @ ${elapsed}s ${lastStatusText ? `("${lastStatusText.slice(0,80)}")` : ''}`);
      if (statusCode === 'FINISHED') break;
      if (statusCode === 'EXPIRED') {
        return { error: `IG container EXPIRED — Meta dropped it. Status: ${lastStatusText}` };
      }
      if (statusCode === 'ERROR') {
        if (errorObservedAt === 0) errorObservedAt = Date.now();
        const errAge = Date.now() - errorObservedAt;
        const sinceStart = Date.now() - t0Poll;
        // Bail only if ERROR persists past the grace window (90s after first ERROR or 90s total — whichever larger)
        if (errAge > errGraceMs || sinceStart > errGraceMs * 2) {
          return { error: `IG container ERROR persisted ${(errAge/1000).toFixed(0)}s. Last status: ${lastStatusText}` };
        }
        logLine(`IG: ERROR is transient (${(errAge/1000).toFixed(0)}s), continuing to poll`);
      } else if (statusCode === 'IN_PROGRESS') {
        // ERROR may have flipped back to IN_PROGRESS — reset the error timer
        errorObservedAt = 0;
      }
    }
    if (statusCode !== 'FINISHED') {
      // Last-ditch: try publishing anyway. Meta's status sometimes lags;
      // /media_publish will succeed if the container is actually ready.
      logLine(`IG: timeout with status=${statusCode}, attempting publish anyway as last resort`);
    }

    // 4. Publish
    const pubRes = await axios.post(`${GRAPH}/${cfg.IG_USER_ID}/media_publish`, null, {
      params: { creation_id: creationId, access_token: cfg.IG_ACCESS_TOKEN },
      timeout: 30_000,
    });
    const mediaId = pubRes?.data?.id;
    if (!mediaId) return { error: 'IG publish returned no media id' };

    // Fetch permalink (best-effort).
    let permalink = `https://www.instagram.com/reel/${mediaId}/`;
    try {
      const pl = await axios.get(`${GRAPH}/${mediaId}`, {
        params: { fields: 'permalink', access_token: cfg.IG_ACCESS_TOKEN },
        timeout: 10_000,
      });
      if (pl?.data?.permalink) permalink = pl.data.permalink;
    } catch (_) {}

    logLine(`IG: done mediaId=${mediaId} elapsed=${Date.now() - t0}ms url=${permalink}`);
    return { mediaId, permalink };
  } catch (e) {
    const detail = e?.response?.data?.error?.message || e?.message || String(e);
    logLine(`IG: failed after ${Date.now() - t0}ms: ${detail}`);
    return { error: detail };
  } finally {
    // Always clean up the public Supabase object — the video is on IG now,
    // no reason to leave a public URL around.
    if (uploaded) {
      try { await q.supabase.storage.from(cfg.STORAGE_BUCKET).remove([objectKey]); } catch (_) {}
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// COMBINED META PUBLISH (FB + IG in parallel)
// ────────────────────────────────────────────────────────────────────────────

// Posts the given beat video to FB Page + IG Reels concurrently. Generates
// the 9:16 vertical variant on demand if IG is enabled.
// Returns { facebook, instagram } — each is either success shape or { error }.
async function publishToMeta({ beat, videoPath, narrative }) {
  const anyEnabled = cfg.ENABLE_FACEBOOK || cfg.ENABLE_INSTAGRAM;
  if (!anyEnabled) {
    return {
      facebook:  { skipped: true, reason: 'ENABLE_FACEBOOK=false' },
      instagram: { skipped: true, reason: 'ENABLE_INSTAGRAM=false' },
    };
  }

  // Pre-flight token check — fails fast (~300ms) so we don't waste a 90s render
  // on a dead token. See 2026-04-26 incident.
  try {
    const h = await metaToken.preflight();
    logLine(`preflight ok: token valid, ${h.neverExpires ? 'never expires' : `${h.daysLeft}d left`}, type=${h.tokenType}`);
  } catch (e) {
    logLine(`preflight FAILED: ${e.message}`);
    const errPayload = { error: e.message, code: e.code || 'META_TOKEN_PREFLIGHT', daysLeft: e.daysLeft };
    return { facebook: errPayload, instagram: errPayload, preflightFailed: true };
  }

  // If IG is enabled, produce the 9:16 vertical variant once (cached by media).
  let verticalVideoPath = null;
  if (cfg.ENABLE_INSTAGRAM) {
    try {
      logLine(`generating 9:16 vertical for IG (beat=${beat.id})`);
      verticalVideoPath = await media.makeVertical({ beatId: beat.id, videoPath });
      logLine(`vertical ready ${verticalVideoPath}`);
    } catch (e) {
      logLine(`vertical gen failed — IG will be skipped: ${e.message}`);
      // Don't throw — FB can still publish with the landscape original.
    }
  }

  // Run FB + IG in parallel. Promise.allSettled so one failing doesn't kill the other.
  const tasks = [];
  tasks.push(
    cfg.ENABLE_FACEBOOK
      ? publishToFacebookPage({ beat, videoPath, narrative })
      : Promise.resolve({ skipped: true, reason: 'ENABLE_FACEBOOK=false' })
  );
  tasks.push(
    (cfg.ENABLE_INSTAGRAM && verticalVideoPath)
      ? publishToInstagramReels({ beat, verticalVideoPath })
      : Promise.resolve(
          !cfg.ENABLE_INSTAGRAM
            ? { skipped: true, reason: 'ENABLE_INSTAGRAM=false' }
            : { error: 'vertical render failed — IG skipped' }
        )
  );

  const [fbRes, igRes] = await Promise.allSettled(tasks);
  const facebook  = fbRes.status === 'fulfilled' ? fbRes.value : { error: String(fbRes.reason?.message || fbRes.reason) };
  const instagram = igRes.status === 'fulfilled' ? igRes.value : { error: String(igRes.reason?.message || igRes.reason) };

  return { facebook, instagram };
}

module.exports = { publishToFacebookPage, publishToInstagramReels, publishToMeta };
