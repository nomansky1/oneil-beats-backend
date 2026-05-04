#!/usr/bin/env node
// Backfill custom YouTube thumbnails on existing uploads.
//
// Why this exists: the auto-upload pipeline marks thumbnail-generation as
// non-fatal (commit bc6425b), so when ffmpeg/font/cover-fetch glitches happen,
// videos publish without a custom thumbnail and YouTube falls back to an
// auto-picked frame from the video. This script lists recent uploads on the
// channel, identifies videos missing the maxres (custom) thumbnail, and
// regenerates + uploads using the same makeThumbnail() helper the pipeline
// uses on the live path.
//
// SAFETY:
// - Only acts on videos uploaded in the last LOOKBACK_DAYS days (default 60).
// - Only regenerates when video.snippet.thumbnails.maxres is missing AND
//   we can match the video title back to a beat in the catalog (avoids
//   overwriting any non-pipeline videos with templated branding).
// - Dry-run by default. Pass --apply to actually upload.
//
// Two ways to invoke:
//   1) CLI:    node scripts/backfill-yt-thumbnails.js [--apply]
//   2) HTTP:   POST /admin/backfill-yt-thumbnails (see server.js) — runs the
//              same runBackfill() from a production environment where the
//              YouTube OAuth refresh token is valid.

const fs = require('fs');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const cfg = require('../auto-upload/config');
const { makeThumbnail, downloadToCache } = require('../auto-upload/media');

function ytClient() {
  const oauth2 = new google.auth.OAuth2(cfg.YT_CLIENT_ID, cfg.YT_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: cfg.YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2 });
}

// Title pattern from the auto-upload pipeline:
//   [FREE] <Mood> <Genre> Type Beat 2026 "<Title>" | <BPM> BPM <Key>
// Extract the title between the first pair of straight or curly quotes.
function extractBeatTitle(videoTitle) {
  if (!videoTitle) return null;
  const m = videoTitle.match(/[“"']([^“”"']+)[”"']/);
  return m ? m[1].trim() : null;
}

// Custom thumbnails get a maxres (1280x720) entry. Auto-generated ones don't.
function isMissingCustomThumbnail(snippet) {
  return !snippet?.thumbnails?.maxres;
}

async function getRecentUploads(yt, lookbackDays) {
  const me = await yt.channels.list({ part: ['contentDetails'], mine: true });
  const uploadsPlaylistId = me.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) throw new Error('Could not find uploads playlist for the authenticated channel.');

  const since = new Date(Date.now() - lookbackDays * 86400 * 1000);
  const out = [];
  let pageToken;
  do {
    const page = await yt.playlistItems.list({
      part: ['snippet', 'contentDetails'],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });
    for (const item of page.data.items || []) {
      const publishedAt = new Date(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || 0);
      if (publishedAt < since) { pageToken = null; break; }
      out.push({ videoId: item.contentDetails?.videoId, title: item.snippet?.title || '', publishedAt });
    }
    pageToken = page.data.nextPageToken;
  } while (pageToken && out.length < 200);

  // Re-fetch via videos.list to get the full thumbnails map (playlistItems
  // sometimes lacks maxres even when the video has one).
  const ids = out.map(v => v.videoId).filter(Boolean);
  const enriched = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await yt.videos.list({ part: ['snippet'], id: batch });
    for (const v of res.data.items || []) {
      enriched.push({ videoId: v.id, title: v.snippet?.title || '', thumbnails: v.snippet?.thumbnails || {} });
    }
  }
  return enriched;
}

async function findBeatByTitle(supabase, beatTitle) {
  if (!beatTitle) return null;
  const { data, error } = await supabase
    .from('beats')
    .select('id, title, genre, bpm, cover_url, active')
    .ilike('title', beatTitle)
    .limit(1);
  if (error) return null;
  return data?.[0] || null;
}

// Core backfill — invoked by both the CLI entrypoint below and the
// /admin/backfill-yt-thumbnails endpoint in server.js.
async function runBackfill({ apply = false, lookbackDays = 60, log = console.log } = {}) {
  if (!cfg.YT_CLIENT_ID || !cfg.YT_REFRESH_TOKEN) throw new Error('YouTube OAuth env vars missing');
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_KEY) throw new Error('Supabase env vars missing');

  const yt = ytClient();
  const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_KEY);

  log(`[backfill] mode: ${apply ? 'APPLY' : 'DRY-RUN'} · lookback ${lookbackDays}d`);

  const videos = await getRecentUploads(yt, lookbackDays);
  log(`[backfill] fetched ${videos.length} recent videos`);

  const needsBackfill = videos.filter(isMissingCustomThumbnail);
  log(`[backfill] ${needsBackfill.length}/${videos.length} are missing maxres (custom) thumbnail`);

  const result = { fixed: 0, skipped: 0, errored: 0, items: [] };

  for (const v of needsBackfill) {
    const beatTitle = extractBeatTitle(v.title);
    if (!beatTitle) {
      log(`  · SKIP "${v.title}" — couldn't parse beat title from video title`);
      result.skipped++;
      result.items.push({ videoId: v.videoId, title: v.title, status: 'no-beat-title' });
      continue;
    }
    const beat = await findBeatByTitle(supabase, beatTitle);
    if (!beat) {
      log(`  · SKIP "${v.title}" → "${beatTitle}" — no matching beat in catalog`);
      result.skipped++;
      result.items.push({ videoId: v.videoId, title: v.title, status: 'no-matching-beat', parsedTitle: beatTitle });
      continue;
    }

    let coverPath = null;
    try {
      if (beat.cover_url) coverPath = await downloadToCache(beat.cover_url, `${beat.id}-cover`);
    } catch (e) {
      log(`  · cover download failed for ${beat.id}: ${e.message}`);
    }

    let thumbPath;
    try {
      thumbPath = await makeThumbnail({
        beatId: beat.id, albumCoverPath: coverPath,
        title: beat.title, bpm: beat.bpm, genre: beat.genre,
      });
    } catch (e) {
      log(`  X thumbnail generation failed for "${beat.title}": ${e.message}`);
      result.errored++;
      result.items.push({ videoId: v.videoId, title: v.title, status: 'thumb-gen-failed', error: e.message });
      continue;
    }

    if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size < 5000) {
      log(`  X generated thumbnail invalid for "${beat.title}" (${thumbPath})`);
      result.errored++;
      result.items.push({ videoId: v.videoId, title: v.title, status: 'thumb-invalid' });
      continue;
    }

    if (!apply) {
      log(`  ~ DRY would upload thumb for "${v.title}" (videoId=${v.videoId}, beatId=${beat.id})`);
      result.fixed++;
      result.items.push({ videoId: v.videoId, title: v.title, beatId: beat.id, status: 'dry-ok' });
      continue;
    }

    try {
      await yt.thumbnails.set({
        videoId: v.videoId,
        media: { body: fs.createReadStream(thumbPath) },
      });
      log(`  OK uploaded thumb for "${v.title}" (videoId=${v.videoId})`);
      result.fixed++;
      result.items.push({ videoId: v.videoId, title: v.title, beatId: beat.id, status: 'uploaded' });
    } catch (e) {
      log(`  X upload failed for ${v.videoId}: ${e.message}`);
      result.errored++;
      result.items.push({ videoId: v.videoId, title: v.title, status: 'upload-failed', error: e.message });
    }
  }

  log(`[backfill] done — fixed: ${result.fixed}, skipped: ${result.skipped}, errored: ${result.errored}`);
  return result;
}

module.exports = { runBackfill };

// CLI entrypoint
if (require.main === module) {
  require('dotenv').config();
  const apply = process.argv.includes('--apply');
  const lookbackDays = parseInt(process.env.BACKFILL_LOOKBACK_DAYS || '60', 10);
  runBackfill({ apply, lookbackDays })
    .then(r => {
      if (!apply && r.fixed > 0) console.log(`[backfill] re-run with --apply to actually upload ${r.fixed} thumbnail(s).`);
      process.exit(0);
    })
    .catch(e => { console.error('[backfill] fatal:', e.message); process.exit(1); });
}
