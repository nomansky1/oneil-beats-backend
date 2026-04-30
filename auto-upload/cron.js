// Scheduler. Every tick (15m by default):
//   1. Claim next runnable YouTube job → render derivatives → upload → mark done
//   2. Same for Instagram Reels
//   3. Same for TikTok
//
// One platform per tick each — keeps the worker predictable and avoids
// rate-limiting yourself across the big three in the same minute.
//
// `runOnce()` is the entire tick as a function. `startCron()` wraps it in
// node-cron for standalone workers. `tickHandler()` is the same logic
// exposed as an Express handler for Vercel Cron.

// node-cron is lazy-required inside startCron() so the desktop-app backend can
// import runOnce()/tickHandler without bundling node-cron (only the standalone
// worker calls startCron).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const q = require('./queue');
const media = require('./media');
const copy = require('./copy');
const notify = require('./notify');
const { uploadToYouTube }   = require('./processors/youtube');
const { uploadToInstagram } = require('./processors/instagram');
const { uploadToTikTok }    = require('./processors/tiktok');

// Guard against overlapping ticks — if the previous tick is still running
// (a big video takes minutes), skip this one.
let running = false;

async function runOnce() {
  if (running) { notify.log('tick skipped — previous still running'); return; }
  running = true;
  try {
    if (cfg.ENABLE_YOUTUBE)   await tickPlatform('youtube');
    if (cfg.ENABLE_INSTAGRAM) await tickPlatform('instagram');
    if (cfg.ENABLE_TIKTOK)    await tickPlatform('tiktok');
  } catch (e) {
    notify.log(`tick top-level error: ${e.message}`);
  } finally {
    running = false;
  }
}

async function tickPlatform(platform) {
  const job = await q.claimNext(platform);
  if (!job) return; // nothing to do for this platform

  notify.log(`claimed ${platform} job ${job.id} (beat "${job.beat_title}")`);

  try {
    // Resolve video_path to a local file. Three cases:
    //  a) URL  → download to WORK_DIR cache, keep DB value as the URL.
    //  b) local existing path → use as-is.
    //  c) missing → synthesize from audio_url (legacy fallback).
    const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
    if (job.video_path && isUrl(job.video_path)) {
      notify.log(`downloading pre-rendered video for beat ${job.beat_id}`);
      const localPath = await media.downloadToCache(
        job.video_path,
        `src-${job.beat_id}.mp4`
      );
      // Download cover too if it's a URL, so media.prependHook/makeThumbnail
      // don't have to fetch separately. album_cover_path stays the URL in DB.
      if (job.album_cover_path && isUrl(job.album_cover_path)) {
        try {
          const coverLocal = await media.downloadToCache(
            job.album_cover_path,
            `cover-${job.beat_id}${path.extname(job.album_cover_path).split('?')[0] || '.jpg'}`
          );
          job.album_cover_path = coverLocal;
        } catch (e) {
          notify.log(`cover download failed (non-fatal): ${e.message}`);
        }
      }
      job.video_path = localPath;
    } else if (!job.video_path || !fs.existsSync(job.video_path)) {
      if (!job.audio_url) {
        throw new Error('job has no video_path and no audio_url — cannot proceed');
      }
      notify.log(`synthesizing video from audio_url for beat ${job.beat_id}`);
      const { videoPath, coverPath } = await media.synthesizeVideoFromAudio({
        beatId: job.beat_id,
        audioUrl: job.audio_url,
        coverUrl: job.album_cover_path,
      });
      job.video_path = videoPath;
      if (coverPath) job.album_cover_path = coverPath;   // now a local path
      await q.saveDerivatives(job.id, { videoPath, albumCoverPath: coverPath });
    }

    // Ensure derivatives exist (cached on disk between retries via media.js)
    await media.validateVideo(job.video_path);

    // Prepend 3s hook to the source video ONCE and reuse for both YT + IG/TT
    const hookedPath = await media.prependHook({
      beatId: job.beat_id,
      videoPath: job.video_path,
      albumCoverPath: job.album_cover_path,
    });
    job.video_path_hooked = hookedPath;

    // YouTube wants the 16:9 hooked video; IG/TT want the 9:16 version.
    if (platform === 'youtube') {
      if (!job.thumbnail_path) {
        // Thumbnail is nice-to-have, not a publish blocker. YouTube auto-
        // generates one from the video if we don't supply a custom thumbnail,
        // and a missing custom thumb is far better than a failed upload.
        try {
          const thumb = await media.makeThumbnail({
            beatId: job.beat_id,
            albumCoverPath: job.album_cover_path,
            title: job.beat_title,
            bpm: job.beat_bpm,
            genre: job.beat_genre,
          });
          await q.saveDerivatives(job.id, { thumbnailPath: thumb });
          job.thumbnail_path = thumb;
        } catch (e) {
          notify.log(`thumbnail generation failed (non-fatal, falling back to YT auto-thumb): ${e.message}`);
        }
      }

      const { externalId, publicUrl } = await uploadToYouTube(job);
      await q.markSuccess(job.id, 'youtube', { externalId, publicUrl });
      notify.notifyPublished('youtube', job, publicUrl);

      // Schedule downstream platforms with the requested stagger — but only
      // for the ones that are enabled. Disabled platforms stay `pending` with
      // scheduled_at=null so they never get claimed (and re-enabling later
      // just needs a one-line SQL update per job).
      if (cfg.ENABLE_INSTAGRAM || cfg.ENABLE_TIKTOK) {
        const scheduled = await q.scheduleDownstream(job.id, {
          instagram: cfg.ENABLE_INSTAGRAM,
          tiktok:    cfg.ENABLE_TIKTOK,
        });
        notify.log(`scheduled downstream: ${JSON.stringify(scheduled)}`);
      }
      return;
    }

    // IG + TikTok both need the 9:16 version
    if (!job.vertical_path || !fs.existsSync(job.vertical_path)) {
      const vert = await media.makeVertical({ beatId: job.beat_id, videoPath: hookedPath });
      await q.saveDerivatives(job.id, { verticalPath: vert });
      job.vertical_path = vert;
    }

    if (platform === 'instagram') {
      const { externalId, publicUrl } = await uploadToInstagram(job);
      await q.markSuccess(job.id, 'instagram', { externalId, publicUrl });
      notify.notifyPublished('instagram', job, publicUrl);
      return;
    }

    if (platform === 'tiktok') {
      const { externalId, publicUrl } = await uploadToTikTok(job);
      await q.markSuccess(job.id, 'tiktok', { externalId, publicUrl });
      notify.notifyPublished('tiktok', job, publicUrl);
      return;
    }
  } catch (e) {
    notify.notifyFailed(platform, job, e);
    await q.markFailure(job.id, platform, e.message || String(e));
  }
}

function startCron() {
  // Lazy-require so importers that only need runOnce()/tickHandler don't have
  // to install node-cron (e.g. the electron desktop-app backend).
  const cron = require('node-cron');
  // Every 15 minutes.
  const task = cron.schedule('*/15 * * * *', () => { runOnce().catch(() => {}); });
  notify.log('[auto-upload] cron started — ticking every 15 minutes');
  // Also run once immediately so startup doesn't wait 15 min for the first job.
  setTimeout(() => runOnce().catch(() => {}), 2000);
  return task;
}

// Express handler for Vercel Cron-style triggering.
async function tickHandler(req, res) {
  try {
    await runOnce();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { runOnce, startCron, tickHandler };
