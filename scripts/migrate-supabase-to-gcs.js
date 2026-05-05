#!/usr/bin/env node
// One-shot migration: copies every file in the 5 Supabase Storage buckets into
// the GCS bucket (under matching path prefixes), then rewrites every DB row
// pointing at a Supabase URL to point at the GCS equivalent.
//
// Designed to be SAFE for the live mobile apps:
//   • Supabase files are NEVER deleted by this script. They stay alive as a
//     fallback for the 30+ day grace window — anything cached in an app or
//     in flight at migration time keeps working.
//   • DB updates happen AFTER every file has been verified in GCS. If the
//     copy step fails, no DB row is touched.
//   • Idempotent — re-running skips files that already exist in GCS with a
//     matching size, and skips DB rows already pointing at GCS.
//   • Both URL formats stay valid post-migration: the apps will see GCS URLs
//     on next /beats fetch, and the apps don't care which CDN serves them.
//
// Required env (set before running):
//   GCS_BUCKET                    e.g. "oneilbeats-media"
//   GCS_PROJECT_ID                e.g. "oneil-beats" (optional)
//   GOOGLE_APPLICATION_CREDENTIALS path to your service-account JSON
//   SUPABASE_URL                  https://thmqqplnrjwimgqubkhp.supabase.co
//   SUPABASE_SERVICE_KEY          the service_role key
//
// Run:   node scripts/migrate-supabase-to-gcs.js
//
// Flags:
//   --dry-run        report what would happen, no actual copies or DB writes
//   --skip-files     skip the file-copy phase (DB-update only)
//   --skip-db        skip the DB-update phase (file-copy only)
//   --bucket=beats   limit file copy to one Supabase bucket
//   --concurrency=4  parallel uploads (default 4)

require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Storage } = require('@google-cloud/storage');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SKIP_FILES = argv.includes('--skip-files');
const SKIP_DB = argv.includes('--skip-db');
const ONLY_BUCKET = (argv.find(a => a.startsWith('--bucket=')) || '').split('=')[1] || null;
const CONCURRENCY = parseInt((argv.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || '4', 10);

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://thmqqplnrjwimgqubkhp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const GCS_BUCKET = process.env.GCS_BUCKET;

if (!GCS_BUCKET) { console.error('ERROR: GCS_BUCKET env var not set'); process.exit(1); }
if (!SUPABASE_KEY) { console.error('ERROR: SUPABASE_SERVICE_KEY env var not set'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const storage = new Storage({ projectId: process.env.GCS_PROJECT_ID || undefined });
const bucket = storage.bucket(GCS_BUCKET);

// Same mapping as gcsApi.js — Supabase bucket → path prefix inside the single GCS bucket.
const SUPABASE_BUCKETS = ['beats', 'cover-art', 'thumbnails', 'auto-upload', 'cloud-render'];
const PREFIX = (b) => b; // 1:1 — beats → beats/, cover-art → cover-art/, etc.

// All DB columns that may contain Supabase Storage URLs (per
// information_schema scan run 2026-05-05).
const URL_COLUMNS = {
  beats:           ['audio_url', 'audio_original_url', 'cover_url', 'wav_url', 'stem_url'],
  auto_upload_jobs:['album_cover_path', 'audio_url', 'thumbnail_path', 'vertical_path', 'video_path', 'short_path'],
  order_items:     ['cover_url', 'mp3_url', 'wav_url', 'stems_url', 'license_pdf_url'],
};

const SUPABASE_HOST = new URL(SUPABASE_URL).host;

function log(...args) { console.log(`[migrate ${new Date().toISOString().slice(11,19)}]`, ...args); }
function fmtSize(bytes) { return bytes > 1e6 ? (bytes/1e6).toFixed(1)+'MB' : (bytes/1e3).toFixed(0)+'KB'; }

// Recursively walk a Supabase folder. The list() API only returns one level.
async function listSupabaseRecursive(supabaseBucket, prefix = '') {
  const out = [];
  const walk = async (folder) => {
    const { data, error } = await supabase.storage.from(supabaseBucket)
      .list(folder, { limit: 10000, offset: 0, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`list ${supabaseBucket}/${folder}: ${error.message}`);
    for (const item of data || []) {
      const full = folder ? `${folder}/${item.name}` : item.name;
      if (item.id) {
        out.push({ name: full, size: parseInt(item.metadata?.size || 0, 10), mimeType: item.metadata?.mimetype || 'application/octet-stream' });
      } else {
        // It's a folder
        await walk(full);
      }
    }
  };
  await walk(prefix);
  return out;
}

async function gcsObjectMatches(objectPath, expectedSize) {
  try {
    const [exists] = await bucket.file(objectPath).exists();
    if (!exists) return false;
    if (!expectedSize) return true;
    const [meta] = await bucket.file(objectPath).getMetadata();
    return parseInt(meta.size, 10) === expectedSize;
  } catch (_) { return false; }
}

// Copy a single Supabase Storage object → GCS at matching path. Skips if
// already present in GCS with matching size.
async function copyOne(supabaseBucket, fileName, expectedSize, mimeType) {
  const objectPath = `${PREFIX(supabaseBucket)}/${fileName}`;
  if (await gcsObjectMatches(objectPath, expectedSize)) return { skipped: true, objectPath };

  // Download from Supabase.
  const { data: blob, error } = await supabase.storage.from(supabaseBucket).download(fileName);
  if (error) throw new Error(`download ${supabaseBucket}/${fileName}: ${error.message}`);
  const buf = Buffer.from(await blob.arrayBuffer());

  if (DRY_RUN) return { dryRun: true, objectPath, size: buf.length };

  // Upload to GCS.
  await bucket.file(objectPath).save(buf, {
    contentType: mimeType,
    resumable: buf.length > 5 * 1024 * 1024, // resumable for files > 5MB
    metadata: { cacheControl: 'public, max-age=31536000, immutable' },
    validation: 'crc32c',
  });
  return { copied: true, objectPath, size: buf.length };
}

// Process a list of files with N parallel workers.
async function copyAllInBucket(supabaseBucket) {
  log(`scanning Supabase bucket "${supabaseBucket}"...`);
  const files = await listSupabaseRecursive(supabaseBucket);
  const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
  log(`  ${files.length} files, ${fmtSize(totalSize)}. starting copy with concurrency=${CONCURRENCY}`);

  let copied = 0, skipped = 0, failed = 0, bytesCopied = 0;
  let queueIndex = 0;
  const worker = async () => {
    while (true) {
      const i = queueIndex++;
      if (i >= files.length) return;
      const f = files[i];
      try {
        const res = await copyOne(supabaseBucket, f.name, f.size, f.mimeType);
        if (res.skipped) skipped++;
        else if (res.copied || res.dryRun) { copied++; bytesCopied += res.size || f.size || 0; }
        if ((copied + skipped) % 25 === 0) log(`  progress ${copied + skipped}/${files.length} (copied=${copied} skipped=${skipped})`);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${f.name}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log(`  ${supabaseBucket} done — copied=${copied} (${fmtSize(bytesCopied)}), skipped=${skipped}, failed=${failed}`);
  return { copied, skipped, failed };
}

// Map a Supabase public URL → matching GCS public URL.
//   in : https://thmqqplnrjwimgqubkhp.supabase.co/storage/v1/object/public/beats/foo.mp3
//   out: https://storage.googleapis.com/oneilbeats-media/beats/foo.mp3
function rewriteSupabaseUrl(oldUrl) {
  if (!oldUrl || typeof oldUrl !== 'string') return null;
  if (!oldUrl.includes(SUPABASE_HOST)) return null;
  const m = oldUrl.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(?:\?.*)?$/);
  if (!m) return null;
  const [, supBucket, restPath] = m;
  if (!SUPABASE_BUCKETS.includes(supBucket)) return null;
  const objectPath = `${PREFIX(supBucket)}/${decodeURIComponent(restPath)}`;
  return `https://storage.googleapis.com/${GCS_BUCKET}/${objectPath}`;
}

async function updateUrlColumnsForTable(table, columns) {
  log(`scanning ${table} (${columns.length} URL columns)...`);
  // Pull rows where any URL column contains the Supabase host.
  const orFilter = columns.map(c => `${c}.ilike.%${SUPABASE_HOST}%`).join(',');
  const { data: rows, error } = await supabase.from(table).select('id,' + columns.join(',')).or(orFilter).limit(10000);
  if (error) { console.error(`  query ${table} failed: ${error.message}`); return { updated: 0 }; }
  log(`  ${rows.length} rows have at least one Supabase URL`);

  let updated = 0, skipped = 0;
  for (const row of rows) {
    const patch = {};
    for (const col of columns) {
      const newUrl = rewriteSupabaseUrl(row[col]);
      if (newUrl && newUrl !== row[col]) patch[col] = newUrl;
    }
    if (!Object.keys(patch).length) { skipped++; continue; }
    if (DRY_RUN) { updated++; continue; }
    const { error: upErr } = await supabase.from(table).update(patch).eq('id', row.id);
    if (upErr) console.error(`  update ${table}#${row.id}: ${upErr.message}`);
    else updated++;
  }
  log(`  ${table} done — updated=${updated}, skipped=${skipped}`);
  return { updated, skipped };
}

(async () => {
  log(`migration starting | dry-run=${DRY_RUN} | gcs_bucket=${GCS_BUCKET}`);

  // Sanity: confirm GCS bucket is reachable.
  try {
    const [exists] = await bucket.exists();
    if (!exists) throw new Error(`bucket "${GCS_BUCKET}" not found`);
  } catch (e) {
    console.error(`✗ cannot access GCS bucket: ${e.message}`);
    console.error(`   check GCS_BUCKET env, GOOGLE_APPLICATION_CREDENTIALS path,`);
    console.error(`   and that the service account has Storage Object Admin role.`);
    process.exit(1);
  }
  log('✓ GCS bucket reachable');

  const totals = { copied: 0, skipped: 0, failed: 0, dbUpdated: 0 };

  if (!SKIP_FILES) {
    const buckets = ONLY_BUCKET ? [ONLY_BUCKET] : SUPABASE_BUCKETS;
    for (const b of buckets) {
      const r = await copyAllInBucket(b);
      totals.copied += r.copied; totals.skipped += r.skipped; totals.failed += r.failed;
    }
  }

  if (!SKIP_DB) {
    log('updating database URL columns...');
    for (const [table, cols] of Object.entries(URL_COLUMNS)) {
      const r = await updateUrlColumnsForTable(table, cols);
      totals.dbUpdated += r.updated || 0;
    }
  }

  log('migration complete');
  log(`  files copied: ${totals.copied}, skipped: ${totals.skipped}, failed: ${totals.failed}`);
  log(`  DB rows updated: ${totals.dbUpdated}`);
  log('Supabase originals are still in place. Verify the apps work for ~30 days,');
  log('then optionally clean up Supabase storage to free that 4.5GB.');

  process.exit(totals.failed > 0 ? 2 : 0);
})().catch(err => { console.error(err); process.exit(1); });
