// YouTube upload via googleapis. Resumable upload = survives 20MB+ videos.
// Thumbnail is uploaded in a second call (thumbnails.set) after the video
// is ingested.
//
// CREDENTIALS: YouTube OAuth 2.0. You need a refresh_token (one-time auth
// via the OAuth Playground or a tiny consent script — see README).

const fs = require('fs');
const { google } = require('googleapis');
const cfg = require('../config');
const copy = require('../copy');

function ytClient() {
  const oauth2 = new google.auth.OAuth2(cfg.YT_CLIENT_ID, cfg.YT_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: cfg.YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2 });
}

async function uploadToYouTube(job) {
  const yt = ytClient();
  const isShort = job.is_short === true;
  const title = isShort
    ? copy.buildYouTubeShortTitle({
        title: job.beat_title, genre: job.beat_genre, bpm: job.beat_bpm,
        key: job.beat_key, mood: job.beat_mood,
      })
    : copy.buildYouTubeTitle({
        title: job.beat_title, genre: job.beat_genre, bpm: job.beat_bpm,
        key: job.beat_key, mood: job.beat_mood,
      });
  // Use operator-supplied narrative (e.g. Hermes blurb from the desktop app)
  // as the opening hook of the description. Falls back to the generic builder.
  const description = isShort
    ? copy.buildYouTubeShortDescription(job, job.description_override)
    : copy.buildYouTubeDescription(job, job.description_override);
  const tags = copy.buildTags(job);

  // Step 1: videos.insert with resumable upload
  const insertRes = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId: cfg.YT_CATEGORY_ID,
        defaultLanguage: 'en',
        defaultAudioLanguage: 'en',
      },
      status: {
        privacyStatus: cfg.YT_PRIVACY,
        selfDeclaredMadeForKids: false,
        embeddable: true,
      },
    },
    media: {
      body: fs.createReadStream(job.video_path_hooked),
    },
  }, {
    // Progress callback — googleapis forwards bytes to stdout in debug, but
    // we just want a single "done" log line from the caller.
    onUploadProgress: () => {},
  });

  const videoId = insertRes.data.id;
  if (!videoId) throw new Error('YouTube response missing video id');

  // Step 2: thumbnails.set (only if we generated one)
  if (job.thumbnail_path && fs.existsSync(job.thumbnail_path)) {
    try {
      await yt.thumbnails.set({
        videoId,
        media: { body: fs.createReadStream(job.thumbnail_path) },
      });
    } catch (e) {
      // Thumbnail failure shouldn't fail the whole upload — YT auto-picks one.
      console.warn(`[youtube] thumbnail.set failed (non-fatal): ${e.message}`);
    }
  }

  // Step 3: pinned comment with store link. Non-fatal if it fails — uploads
  // are sometimes still ingesting when this runs and comments get rejected
  // with "videoNotFound" for a minute or two.
  if (!isShort) {
    try {
      const pinned = copy.buildPinnedComment(job);
      if (pinned) {
        await yt.commentThreads.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              videoId,
              topLevelComment: { snippet: { textOriginal: pinned } },
            },
          },
        });
      }
    } catch (e) {
      console.warn(`[youtube] pinned comment failed (non-fatal): ${e.message}`);
    }
  }

  return {
    externalId: videoId,
    publicUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

module.exports = { uploadToYouTube };
