// In-process "publish now" path for the desktop app.
//
// Unlike the scheduled flow (Supabase storage + GH Actions cron), this path
// skips the queue entirely: render → preview → click "Publish Now" → mp4
// blob is written to a local tmp file, a labeled thumbnail is generated via
// system ffmpeg, and the video is uploaded directly to YouTube via the
// googleapis SDK. Returns the YouTube URL synchronously.
//
// This exists because the Supabase free-tier project-global file-size limit
// caps uploads at 50 MB until the user raises it in the dashboard — a 1080p
// 3-min beat easily blows that. Writing local → uploading direct avoids
// Supabase as the bottleneck.
//
// Scheduled publishes still go through Supabase + queue + cron. This module
// is only wired into the "Publish Now" button path.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const media = require('./media');
const copy  = require('./copy');
const cfg   = require('./config');

// Build an authenticated OAuth2 client from the config env vars. Same
// refresh-token flow the scheduled worker uses, so the user only has to
// grant the YT scope once.
function makeYTClient() {
  const oauth2 = new google.auth.OAuth2(cfg.YT_CLIENT_ID, cfg.YT_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: cfg.YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2 });
}

// Write a buffer to a dedicated tmp dir and return the path. Caller is
// responsible for cleanup when the publish completes.
function writeLocalMp4(beatId, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obpub-'));
  const out = path.join(dir, `${beatId}.mp4`);
  fs.writeFileSync(out, buffer);
  return { dir, path: out };
}

// Download a cover URL (or copy a local path) into the same tmp dir.
// Returns null if anything fails — the thumbnail generator has its own
// black-frame fallback.
async function fetchCover(dir, coverUrl) {
  if (!coverUrl) return null;
  try {
    if (!/^https?:\/\//i.test(coverUrl)) {
      return fs.existsSync(coverUrl) ? coverUrl : null;
    }
    const ext = (coverUrl.match(/\.(jpe?g|png|webp)(?:\?|$)/i) || [, 'jpg'])[1];
    const out = path.join(dir, `cover.${ext}`);
    // Minimal fetch: https/http with one redirect follow.
    const proto = coverUrl.startsWith('https') ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(out);
      proto.get(coverUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(); fs.unlinkSync(out);
          fetchCover(dir, res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close(); fs.unlinkSync(out);
          return reject(new Error(`cover fetch HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(out)));
      }).on('error', reject);
    });
    return out;
  } catch (e) {
    return null;
  }
}

// Core publish: upload mp4 → set thumbnail → (optional) pinned comment.
// Returns { videoId, youtubeUrl, thumbnailWarning, commentWarning }.
async function publishToYouTube({ beat, videoPath, thumbnailPath, narrative }) {
  const yt = makeYTClient();
  const title = copy.buildYouTubeTitle(beat);
  const description = copy.buildYouTubeDescription(beat, narrative);
  const tags = copy.buildTags(beat);

  // 1. videos.insert — resumable upload of the mp4.
  const insertRes = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description: description.slice(0, 5000),
        tags,
        categoryId: cfg.YT_CATEGORY_ID || '10',
      },
      status: {
        privacyStatus: cfg.YT_PRIVACY || 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: { body: fs.createReadStream(videoPath) },
  });
  const videoId = insertRes?.data?.id;
  if (!videoId) throw new Error('YouTube insert returned no video id');
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 2. thumbnails.set — optional, requires phone-verified channel.
  let thumbnailWarning = null;
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try {
      await yt.thumbnails.set({
        videoId,
        media: { body: fs.createReadStream(thumbnailPath) },
      });
    } catch (e) {
      thumbnailWarning = e?.message || String(e);
    }
  }

  // 3. Pinned first comment — optional, needs youtube.force-ssl scope.
  let commentWarning = null;
  try {
    await yt.commentThreads.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          videoId,
          topLevelComment: {
            snippet: { textOriginal: copy.buildPinnedComment(beat) },
          },
        },
      },
    });
  } catch (e) {
    commentWarning = e?.message || String(e);
  }

  return { videoId, youtubeUrl, thumbnailWarning, commentWarning };
}

// End-to-end publish-now. Caller passes the reviewed mp4 buffer + beat
// metadata + optional narrative/cover URL. Returns YouTube URL + any
// non-fatal warnings. Tmp dir is cleaned up before return.
async function publishNow({ beat, videoBuffer, coverUrl, narrative }) {
  if (!beat?.id) throw new Error('beat.id required');
  if (!videoBuffer?.length) throw new Error('videoBuffer required');

  const { dir, path: videoPath } = writeLocalMp4(beat.id, videoBuffer);
  let thumbnailPath = null;
  try {
    // Validate duration against the widened 30–360s window.
    await media.validateVideo(videoPath);

    // Thumbnail — best-effort, don't fail the whole publish on thumbnail error.
    try {
      const coverLocal = await fetchCover(dir, coverUrl);
      thumbnailPath = await media.makeThumbnail({
        beatId: beat.id,
        albumCoverPath: coverLocal,
        title: beat.title,
        bpm: beat.bpm,
        genre: beat.genre,
      });
    } catch (e) {
      console.warn('[publish-now] thumbnail gen failed (non-fatal):', e.message);
    }

    const out = await publishToYouTube({ beat, videoPath, thumbnailPath, narrative });
    return { ...out, thumbnailPath };
  } finally {
    // Clean up tmp dir — but keep a copy of the thumbnail in the work dir
    // (already persisted via media.makeThumbnail to cfg.WORK_DIR), so just
    // wipe the ephemeral dir.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Update an already-live YouTube video's description + thumbnail. Used to
// retrofit Luna (and any future video) with the fixed ?beat=id link once
// this code ships.
async function updateExistingVideo({ videoId, beat, narrative, thumbnailPath }) {
  const yt = makeYTClient();
  const description = copy.buildYouTubeDescription(beat, narrative);
  const tags = copy.buildTags(beat);
  const title = copy.buildYouTubeTitle(beat);

  await yt.videos.update({
    part: ['snippet'],
    requestBody: {
      id: videoId,
      snippet: {
        title: title.slice(0, 100),
        description: description.slice(0, 5000),
        tags,
        categoryId: cfg.YT_CATEGORY_ID || '10',
      },
    },
  });

  let thumbnailWarning = null;
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try {
      await yt.thumbnails.set({
        videoId,
        media: { body: fs.createReadStream(thumbnailPath) },
      });
    } catch (e) {
      thumbnailWarning = e?.message || String(e);
    }
  }
  return { videoId, thumbnailWarning };
}

module.exports = { publishNow, updateExistingVideo, publishToYouTube };
