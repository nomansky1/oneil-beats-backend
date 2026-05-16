// ─── Cloudflare R2 API helper ────────────────────────────────────────────
// Drop-in companion to gcsApi.js. Same function signatures, same return type
// (public HTTPS URL string), so the unified storage.js adapter can route
// calls to either backend behind a feature flag.
//
// Required env:
//   • R2_ACCOUNT_ID            — Cloudflare account ID
//   • R2_BUCKET                — R2 bucket name (e.g. "oneilbeats-prod")
//   • R2_ENDPOINT              — S3 API endpoint, typically
//                                https://{accountId}.r2.cloudflarestorage.com
//   • R2_ACCESS_KEY_ID         — R2 API token's Access Key ID
//   • R2_SECRET_ACCESS_KEY     — R2 API token's Secret Access Key
//   • R2_PUBLIC_URL            — base URL files are served at PUBLICLY. For
//                                production, this MUST be either:
//                                  (a) the bucket's pub-XXX.r2.dev URL, OR
//                                  (b) a custom domain mapped to the bucket
//                                The S3 API endpoint requires auth — files
//                                stored there will NOT be readable by browsers.
//
// 2026-05-16 — Phase 1 of GCS → R2 migration. Code is fully wired but routes
// through this module are GATED behind USE_R2_FOR_UPLOADS=true in storage.js.
// Default behavior is unchanged: uploads still go to GCS.

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let _client = null;

// Mirror gcsApi.js's prefix mapping so the same logical "bucket" names
// (legacy Supabase nomenclature) map to the same path prefixes in R2.
const SUPABASE_TO_R2_PREFIX = {
  'beats':        'beats',
  'cover-art':    'cover-art',
  'thumbnails':   'thumbnails',
  'auto-upload':  'auto-upload',
  'cloud-render': 'cloud-render',
};

function _trim(v) { return (v || '').trim(); }
function _bucketName() { return _trim(process.env.R2_BUCKET); }
function _endpoint() { return _trim(process.env.R2_ENDPOINT); }
function _publicUrlBase() { return _trim(process.env.R2_PUBLIC_URL).replace(/\/+$/, ''); }

function isR2Enabled() {
  return !!(
    _bucketName() &&
    _endpoint() &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  );
}

function getR2BucketName() {
  return _bucketName();
}

function getClient() {
  if (_client) return _client;
  if (!isR2Enabled()) {
    throw new Error('R2 env vars not set — need R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }
  _client = new S3Client({
    region: 'auto', // R2 ignores region but the SDK requires a value
    endpoint: _endpoint(),
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    // R2 requires path-style addressing for the S3 API endpoint.
    forcePathStyle: true,
  });
  return _client;
}

// Build the public URL for an object. If R2_PUBLIC_URL is the S3 API endpoint
// (the default when only credentials are provisioned), reads will require auth
// and the URL won't work in browsers. The smoke test surfaces this clearly.
function publicUrl(objectPath) {
  const base = _publicUrlBase();
  if (base) {
    return `${base}/${objectPath}`;
  }
  // Fallback — last-ditch URL composed from endpoint + bucket.
  return `${_endpoint()}/${_bucketName()}/${objectPath}`;
}

async function uploadFileToStorage(buffer, filename, supabaseBucket, mimeType) {
  const prefix = SUPABASE_TO_R2_PREFIX[supabaseBucket] || supabaseBucket;
  const objectPath = `${prefix}/${filename}`;
  await getClient().send(new PutObjectCommand({
    Bucket: _bucketName(),
    Key: objectPath,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
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

// Generate a presigned PUT URL for direct client → R2 uploads. Matches
// gcsApi.getSignedUploadUrl's return shape so callers don't need to branch.
async function getSignedUploadUrl(filename, supabaseBucket, mimeType) {
  const prefix = SUPABASE_TO_R2_PREFIX[supabaseBucket] || supabaseBucket || 'misc';
  const objectPath = `${prefix}/${filename}`;
  const cmd = new PutObjectCommand({
    Bucket: _bucketName(),
    Key: objectPath,
    ContentType: mimeType || 'application/octet-stream',
  });
  const signedUrl = await getSignedUrl(getClient(), cmd, { expiresIn: 15 * 60 });
  return {
    signedUrl,
    publicUrl: publicUrl(objectPath),
    path: objectPath,
    contentType: mimeType || 'application/octet-stream',
  };
}

// R2 has S3 multipart uploads but doesn't expose the single "session URI"
// PUT-chunks model that GCS uses. The desktop EXE's chunk pipeline currently
// relies on that GCS-specific shape (a sessionUri + Content-Range PUTs).
// For Phase 2, we'll either wrap multipart behind a small Vercel proxy or
// switch the EXE to direct presigned URLs per file (no chunking).
// Until then, this stub throws so callers know to keep using gcsApi for now.
async function getResumableUploadSession() {
  throw new Error('R2 resumable upload not yet implemented — use gcsApi.getResumableUploadSession or getSignedUploadUrl');
}

async function deleteObject(objectPath) {
  try {
    await getClient().send(new DeleteObjectCommand({
      Bucket: _bucketName(),
      Key: objectPath,
    }));
    return true;
  } catch (e) {
    console.warn('[r2] delete error:', e.message);
    return false;
  }
}

async function headObject(objectPath) {
  try {
    const out = await getClient().send(new HeadObjectCommand({
      Bucket: _bucketName(),
      Key: objectPath,
    }));
    return {
      size: out.ContentLength,
      contentType: out.ContentType,
      updated: out.LastModified,
      etag: out.ETag,
    };
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function listObjects(prefix, limit = 100) {
  const out = await getClient().send(new ListObjectsV2Command({
    Bucket: _bucketName(),
    Prefix: prefix,
    MaxKeys: limit,
  }));
  return (out.Contents || []).map(obj => ({
    name: obj.Key,
    url: publicUrl(obj.Key),
    size: obj.Size,
    contentType: null, // ListObjectsV2 doesn't return ContentType; HeadObject does
    updated: obj.LastModified,
  }));
}

module.exports = {
  isR2Enabled,
  getR2BucketName,
  uploadFileToStorage,
  uploadAudioToStorage,
  uploadCoverToStorage,
  uploadBase64ToStorage,
  getSignedUploadUrl,
  getResumableUploadSession,
  deleteObject,
  headObject,
  listObjects,
  publicUrl,
  SUPABASE_TO_R2_PREFIX,
};
