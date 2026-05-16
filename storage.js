// ─── Unified storage adapter (GCS + R2) ──────────────────────────────────
// Routes upload/download calls to either Google Cloud Storage or Cloudflare R2
// based on the USE_R2_FOR_UPLOADS feature flag.
//
// Default: USE_R2_FOR_UPLOADS unset/false → routes to GCS (current production
// behavior). No customer-visible change.
//
// To activate R2 for new uploads:
//   1. Configure R2_PUBLIC_URL to a true public endpoint (custom domain or
//      pub-XXX.r2.dev). The S3 API endpoint requires auth and will NOT
//      serve files to browsers.
//   2. Run scripts/test-r2.js to verify upload + public read both work.
//   3. Set USE_R2_FOR_UPLOADS=true in Vercel env.
//   4. Monitor new uploads. Existing beats stay on GCS until backfill (Phase 3).
//
// Resumable uploads always route to GCS for now — the desktop EXE's chunk
// pipeline is GCS-specific. R2 multipart support comes in Phase 2.
//
// 2026-05-16 — Phase 1 of GCS → R2 migration. Additive only.

const gcs = require('./gcsApi');
const r2 = require('./r2Api');

function useR2() {
  return String(process.env.USE_R2_FOR_UPLOADS || '').toLowerCase() === 'true' && r2.isR2Enabled();
}

function getBackendName() {
  return useR2() ? 'r2' : 'gcs';
}

function isEnabled() {
  return useR2() ? r2.isR2Enabled() : gcs.isGCSEnabled();
}

function getBucketName() {
  return useR2() ? r2.getR2BucketName() : gcs.getGCSBucketName();
}

function uploadFileToStorage(buffer, filename, supabaseBucket, mimeType) {
  return useR2()
    ? r2.uploadFileToStorage(buffer, filename, supabaseBucket, mimeType)
    : gcs.uploadFileToStorage(buffer, filename, supabaseBucket, mimeType);
}

function uploadAudioToStorage(buffer, filename, mimeType) {
  return useR2()
    ? r2.uploadAudioToStorage(buffer, filename, mimeType)
    : gcs.uploadAudioToStorage(buffer, filename, mimeType);
}

function uploadCoverToStorage(buffer, filename, mimeType) {
  return useR2()
    ? r2.uploadCoverToStorage(buffer, filename, mimeType)
    : gcs.uploadCoverToStorage(buffer, filename, mimeType);
}

function uploadBase64ToStorage(base64Data, filename, supabaseBucket, mimeType) {
  return useR2()
    ? r2.uploadBase64ToStorage(base64Data, filename, supabaseBucket, mimeType)
    : gcs.uploadBase64ToStorage(base64Data, filename, supabaseBucket, mimeType);
}

function getSignedUploadUrl(filename, supabaseBucket, mimeType) {
  return useR2()
    ? r2.getSignedUploadUrl(filename, supabaseBucket, mimeType)
    : gcs.getSignedUploadUrl(filename, supabaseBucket, mimeType);
}

function getResumableUploadSession(filename, supabaseBucket, mimeType) {
  // Always GCS for now — R2 multipart wrapper lands in Phase 2.
  return gcs.getResumableUploadSession(filename, supabaseBucket, mimeType);
}

function deleteObject(objectPath) {
  return useR2() ? r2.deleteObject(objectPath) : gcs.deleteObject(objectPath);
}

function listObjects(prefix, limit) {
  return useR2() ? r2.listObjects(prefix, limit) : gcs.listObjects(prefix, limit);
}

module.exports = {
  // Adapter surface — matches gcsApi.js + r2Api.js shapes.
  isEnabled,
  getBackendName,
  getBucketName,
  uploadFileToStorage,
  uploadAudioToStorage,
  uploadCoverToStorage,
  uploadBase64ToStorage,
  getSignedUploadUrl,
  getResumableUploadSession,
  deleteObject,
  listObjects,
  // Escape hatches for code that genuinely needs one backend or the other
  // (migration scripts, smoke tests, etc.).
  gcs,
  r2,
  useR2,
};
