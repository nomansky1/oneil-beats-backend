// ─── Google Cloud Storage API helper ─────────────────────────────────────
// Drop-in replacement for the upload helpers in supabaseApi.js. When the
// env var GCS_BUCKET is set, the storefront / upload routes call into here
// instead of Supabase Storage. Same function signatures, same return type
// (a public HTTPS URL string), so callers don't need to change.
//
// Required env / files:
//   • GCS_BUCKET                    — bucket name, e.g. "oneilbeats-media"
//   • GCS_PROJECT_ID                — GCP project ID (optional, autodetects)
//   • GOOGLE_APPLICATION_CREDENTIALS — path to service-account JSON
//                                     (or set the env var directly to the
//                                      JSON contents and we'll write it
//                                      to a temp file).
//
// Bucket setup expected:
//   • Bucket is in a region close to Vercel (us-east1 / us-east-4 work).
//   • Bucket has uniform bucket-level access enabled.
//   • allUsers granted Storage Object Viewer (public reads), so files are
//     served at https://storage.googleapis.com/{bucket}/{path}.
//
// 2026-05-05 — initial cut written ahead of credentials so the migration
// script + upload swap can land in one PR. If GCS_BUCKET is unset the
// caller falls back to Supabase Storage automatically (see supabaseApi.js).

const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

let _storage = null;
let _bucket = null;

// Map our existing Supabase bucket names → matching GCS prefixes inside the
// single GCS bucket. We collapse 5 Supabase buckets into one GCS bucket with
// path prefixes so we don't have to manage 5 buckets in Cloud Console.
const SUPABASE_TO_GCS_PREFIX = {
  'beats':       'beats',
  'cover-art':   'cover-art',
  'thumbnails':  'thumbnails',
  'auto-upload': 'auto-upload',
  'cloud-render':'cloud-render',
};

// 2026-05-06 — production bug: a "Mark I" beat uploaded with cover_url
//   "https://storage.googleapis.com/oneilbeats-media\n/cover-art/..."
// turned out to be a trailing-whitespace newline on GCS_BUCKET (Vercel env
// var copy-paste artifact). Trim everywhere we read the env so a single
// dirty character can't corrupt every URL written by the upload pipeline.
function _bucketName() {
  return (process.env.GCS_BUCKET || '').trim();
}

function isGCSEnabled() {
  return !!_bucketName();
}

function getGCSBucketName() {
  return _bucketName();
}

function getStorage() {
  if (_storage) return _storage;
  // If GOOGLE_APPLICATION_CREDENTIALS_JSON is set (raw JSON in env var, useful
  // for Vercel-style deploys), write it to a temp file before constructing.
  const inlineJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (inlineJson && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const tmpPath = path.join(require('os').tmpdir(), 'gcs-key.json');
      fs.writeFileSync(tmpPath, inlineJson);
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
    } catch (e) {
      console.warn('[gcs] failed to materialize GOOGLE_APPLICATION_CREDENTIALS_JSON:', e.message);
    }
  }
  _storage = new Storage({
    projectId: process.env.GCS_PROJECT_ID || undefined,
    // keyFilename is auto-resolved from GOOGLE_APPLICATION_CREDENTIALS env var
  });
  return _storage;
}

function getBucket() {
  if (_bucket) return _bucket;
  const name = getGCSBucketName();
  if (!name) throw new Error('GCS_BUCKET env var not set');
  _bucket = getStorage().bucket(name);
  return _bucket;
}

// Public URL pattern. Bucket must be publicly readable for these to work
// without signed URLs (matches our current Supabase model).
function publicUrl(objectPath) {
  return `https://storage.googleapis.com/${getGCSBucketName()}/${objectPath}`;
}

// Core upload helper. supabaseBucket is the LEGACY Supabase bucket name
// (e.g. 'beats', 'cover-art') so callers don't need to learn a new mental
// model. Internally we map it to a path prefix inside the single GCS bucket.
async function uploadFileToStorage(buffer, filename, supabaseBucket, mimeType) {
  const prefix = SUPABASE_TO_GCS_PREFIX[supabaseBucket] || supabaseBucket;
  const objectPath = `${prefix}/${filename}`;
  const file = getBucket().file(objectPath);
  await file.save(buffer, {
    contentType: mimeType || 'application/octet-stream',
    resumable: false, // small/medium uploads — multipart is faster for <100MB
    metadata: {
      cacheControl: 'public, max-age=31536000, immutable',
    },
    validation: 'crc32c',
  });
  return publicUrl(objectPath);
}

async function uploadAudioToStorage(buffer, filename, mimeType) {
  return uploadFileToStorage(buffer, filename, 'beats', mimeType);
}

async function uploadCoverToStorage(buffer, filename, mimeType) {
  return uploadFileToStorage(buffer, filename, 'cover-art', mimeType);
}

async function uploadBase64ToStorage(base64Data, filename, supabaseBucket, mimeType) {
  const buffer = Buffer.from(base64Data, 'base64');
  return uploadFileToStorage(buffer, filename, supabaseBucket, mimeType);
}

// Delete an object by its full GCS path (e.g. 'beats/foo.mp3').
async function deleteObject(objectPath) {
  try {
    await getBucket().file(objectPath).delete({ ignoreNotFound: true });
    return true;
  } catch (e) {
    console.warn('[gcs] delete error:', e.message);
    return false;
  }
}

// List all objects under a prefix. Used by the storefront 'cover-library'
// endpoint to enumerate saved AI covers.
async function listObjects(prefix, limit = 100) {
  const [files] = await getBucket().getFiles({ prefix, maxResults: limit });
  return files.map(f => ({
    name: f.name,
    url: publicUrl(f.name),
    size: parseInt(f.metadata.size || 0, 10),
    contentType: f.metadata.contentType,
    updated: f.metadata.updated,
  }));
}

module.exports = {
  isGCSEnabled,
  getGCSBucketName,
  uploadFileToStorage,
  uploadAudioToStorage,
  uploadCoverToStorage,
  uploadBase64ToStorage,
  deleteObject,
  listObjects,
  publicUrl,
  SUPABASE_TO_GCS_PREFIX,
};
