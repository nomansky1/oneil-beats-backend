// TikTok Content Posting API v2 — FILE_UPLOAD (chunked) mode.
//
// Flow:
//   1. POST /v2/post/publish/video/init with post_info + source_info
//      (source_info: { source: 'FILE_UPLOAD', video_size, chunk_size, total_chunk_count })
//      → returns { publish_id, upload_url }
//   2. PUT each chunk to upload_url with Content-Range header
//   3. Poll /v2/post/publish/status/fetch?publish_id=… until PUBLISH_COMPLETE
//
// REQUIREMENTS:
//  - TikTok for Developers app with "Content Posting API" access
//    (unaudited mode publishes as PRIVATE only — you MUST apply for audit
//     to publish public posts directly. Until audited, this will land in
//     your TikTok inbox as a draft — open the app and tap Post.)
//  - Access token via OAuth with `video.publish` scope

const fs = require('fs');
const axios = require('axios');
const cfg = require('../config');
const copy = require('../copy');

const API = 'https://open.tiktokapis.com';

async function uploadToTikTok(job) {
  const filePath = job.vertical_path;
  const stat = fs.statSync(filePath);
  const videoSize = stat.size;

  // TikTok chunk rules (as of v2): 5 MB min, 64 MB max, final chunk may be
  // smaller. Pick 10 MB unless file is smaller.
  const TEN_MB = 10 * 1024 * 1024;
  const chunkSize = Math.min(TEN_MB, videoSize);
  const totalChunks = Math.ceil(videoSize / chunkSize);

  // 1. Init
  const caption = copy.buildSocialCaption(job);
  const initRes = await axios.post(
    `${API}/v2/post/publish/video/init/`,
    {
      post_info: {
        title: caption.slice(0, 2200),
        privacy_level: 'SELF_ONLY', // will be PUBLIC_TO_EVERYONE once audited
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunks,
      },
    },
    {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Authorization: `Bearer ${cfg.TIKTOK_ACCESS_TOKEN}`,
      },
      timeout: 30_000,
    }
  );

  const data = initRes.data && initRes.data.data;
  if (!data || !data.publish_id || !data.upload_url) {
    throw new Error(`TikTok init bad response: ${JSON.stringify(initRes.data).slice(0, 300)}`);
  }
  const { publish_id, upload_url } = data;

  // 2. Upload chunks
  const fh = fs.openSync(filePath, 'r');
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, videoSize) - 1;
      const length = end - start + 1;
      const buf = Buffer.alloc(length);
      fs.readSync(fh, buf, 0, length, start);

      await axios.put(upload_url, buf, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${videoSize}`,
        },
        maxContentLength: Infinity, maxBodyLength: Infinity,
        timeout: 120_000,
      });
    }
  } finally {
    fs.closeSync(fh);
  }

  // 3. Poll
  const deadline = Date.now() + 5 * 60_000; // 5 min
  let finalStatus = null;
  while (Date.now() < deadline) {
    await sleep(6_000);
    const s = await axios.post(
      `${API}/v2/post/publish/status/fetch/`,
      { publish_id },
      {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          Authorization: `Bearer ${cfg.TIKTOK_ACCESS_TOKEN}`,
        },
        timeout: 15_000,
      }
    );
    const status = s.data && s.data.data && s.data.data.status;
    finalStatus = status;
    if (status === 'PUBLISH_COMPLETE') break;
    if (status === 'FAILED') throw new Error(`TikTok publish FAILED: ${JSON.stringify(s.data).slice(0, 300)}`);
  }
  if (finalStatus !== 'PUBLISH_COMPLETE') {
    // Unaudited apps land in inbox as draft — that's an expected outcome,
    // not an error. We still record publish_id so the producer can find it.
    return {
      externalId: publish_id,
      publicUrl: `https://www.tiktok.com/inbox/drafts?publish_id=${publish_id}`,
    };
  }

  return {
    externalId: publish_id,
    // Once audited + published, the public share URL comes from the list API.
    // Until then, deep-link to Drafts works on the app.
    publicUrl: `https://www.tiktok.com/@me`,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { uploadToTikTok };
