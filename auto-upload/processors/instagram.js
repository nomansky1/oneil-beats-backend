// Instagram Reels via Meta Graph API (v20.0+).
//
// Flow (per Meta docs):
//   1. Upload the 9:16 MP4 to Supabase Storage, get a public URL
//   2. POST /{ig-user-id}/media with media_type=REELS, video_url, caption
//      → returns a creation_id
//   3. Poll /{creation_id}?fields=status_code until FINISHED (up to ~2 min)
//   4. POST /{ig-user-id}/media_publish with creation_id
//   5. Delete the Supabase storage object (clean up public video)
//
// REQUIREMENTS:
//  - IG Business or Creator account linked to a Facebook Page
//  - Long-lived Page Access Token with `instagram_content_publish` scope
//  - Supabase storage bucket set to PUBLIC (temp hosting)

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cfg = require('../config');
const copy = require('../copy');
const { supabase } = require('../queue');

const GRAPH = 'https://graph.facebook.com/v20.0';

async function uploadToInstagram(job) {
  // 1. Push the 9:16 video to Supabase Storage (public bucket) so IG can pull it.
  const objectKey = `reels/${job.id}-${Date.now()}.mp4`;
  const fileBuf = fs.readFileSync(job.vertical_path);
  const up = await supabase.storage.from(cfg.STORAGE_BUCKET).upload(objectKey, fileBuf, {
    contentType: 'video/mp4', upsert: true,
  });
  if (up.error) throw new Error(`supabase upload failed: ${up.error.message}`);
  const pub = supabase.storage.from(cfg.STORAGE_BUCKET).getPublicUrl(objectKey);
  const videoUrl = pub.data.publicUrl;

  try {
    // 2. Create media container
    const caption = copy.buildSocialCaption(job);
    const create = await axios.post(
      `${GRAPH}/${cfg.IG_USER_ID}/media`,
      null,
      {
        params: {
          media_type: 'REELS',
          video_url: videoUrl,
          caption,
          share_to_feed: true,
          access_token: cfg.IG_ACCESS_TOKEN,
        },
        timeout: 30_000,
      }
    );
    const creationId = create.data.id;
    if (!creationId) throw new Error('IG did not return a container id');

    // 3. Poll status_code — IG ingests the remote video asynchronously.
    // Typical finish time is 30–90s. Cap at 3 minutes.
    const deadline = Date.now() + 3 * 60_000;
    let statusCode = 'IN_PROGRESS';
    while (Date.now() < deadline) {
      await sleep(5000);
      const s = await axios.get(`${GRAPH}/${creationId}`, {
        params: { fields: 'status_code', access_token: cfg.IG_ACCESS_TOKEN },
        timeout: 15_000,
      });
      statusCode = s.data.status_code;
      if (statusCode === 'FINISHED') break;
      if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
        throw new Error(`IG container status ${statusCode}`);
      }
    }
    if (statusCode !== 'FINISHED') throw new Error('IG ingest timeout');

    // 4. Publish
    const pubRes = await axios.post(
      `${GRAPH}/${cfg.IG_USER_ID}/media_publish`,
      null,
      { params: { creation_id: creationId, access_token: cfg.IG_ACCESS_TOKEN }, timeout: 30_000 }
    );
    const mediaId = pubRes.data.id;
    if (!mediaId) throw new Error('IG publish returned no media id');

    // Fetch permalink for the DB (best-effort).
    let permalink = `https://www.instagram.com/reel/${mediaId}/`;
    try {
      const pl = await axios.get(`${GRAPH}/${mediaId}`, {
        params: { fields: 'permalink', access_token: cfg.IG_ACCESS_TOKEN },
        timeout: 10_000,
      });
      if (pl.data.permalink) permalink = pl.data.permalink;
    } catch (_) {}

    return { externalId: mediaId, publicUrl: permalink };

  } finally {
    // 5. Always clean up the public storage object, even on failure.
    try { await supabase.storage.from(cfg.STORAGE_BUCKET).remove([objectKey]); } catch (_) {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { uploadToInstagram };
