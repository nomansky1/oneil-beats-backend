#!/usr/bin/env node
// ─── R2 Phase 1 smoke test ────────────────────────────────────────────────
// Verifies the R2 client can connect, write, list, head, read publicly, and
// delete. Run BEFORE flipping USE_R2_FOR_UPLOADS=true in any environment.
//
// Usage:  node scripts/test-r2.js
//
// Exits 0 on success, non-zero on any auth/network/permission failure.
// The "public read" step is allowed to fail with a clear warning if
// R2_PUBLIC_URL points to the S3 API endpoint — that's a config issue you
// need to fix before Phase 2, but it doesn't break the client itself.

require('dotenv').config();
const r2 = require('../r2Api');

const STAMP = Date.now();
const TEST_PREFIX = 'test';
const TEST_FILENAME = `phase1-smoke-${STAMP}.txt`;
const TEST_BODY = `R2 Phase 1 smoke test — ${new Date().toISOString()}
If you can read this in a browser, the R2 client + public URL both work.
`;

function log(emoji, msg) { console.log(`${emoji} ${msg}`); }
function pass(msg)       { console.log(`  ✓ ${msg}`); }
function warn(msg)       { console.log(`  ⚠ ${msg}`); }
function fail(msg)       { console.log(`  ✗ ${msg}`); }

(async () => {
  log('1', 'Check env vars…');
  if (!r2.isR2Enabled()) {
    fail('R2 env vars missing. Need R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
    process.exit(1);
  }
  pass(`Bucket: ${r2.getR2BucketName()}`);
  pass(`Endpoint: ${process.env.R2_ENDPOINT}`);
  pass(`Public URL base: ${process.env.R2_PUBLIC_URL || '(not set — will use endpoint fallback)'}`);

  log('2', 'Upload test object…');
  const url = await r2.uploadFileToStorage(
    Buffer.from(TEST_BODY, 'utf-8'),
    TEST_FILENAME,
    TEST_PREFIX,
    'text/plain; charset=utf-8'
  );
  pass(`Uploaded. Public URL: ${url}`);

  log('3', 'HEAD object (verify size/content-type)…');
  const head = await r2.headObject(`${TEST_PREFIX}/${TEST_FILENAME}`);
  if (head) {
    pass(`size=${head.size} contentType=${head.contentType} updated=${head.updated?.toISOString?.() || head.updated}`);
    // Compare actual UTF-8 byte length, not JS string .length (multi-byte chars like em-dash).
    const expected = Buffer.byteLength(TEST_BODY, 'utf-8');
    if (head.size !== expected) {
      warn(`Size mismatch: uploaded ${expected} bytes, got ${head.size}`);
    }
  } else {
    fail('HEAD returned nothing — object may not have been written.');
  }

  log('4', `List '${TEST_PREFIX}/' prefix…`);
  const items = await r2.listObjects(`${TEST_PREFIX}/`, 50);
  pass(`Found ${items.length} object(s) under ${TEST_PREFIX}/`);
  const mine = items.find(i => i.name.endsWith(TEST_FILENAME));
  if (mine) {
    pass(`Our test file is in the listing.`);
  } else {
    warn(`Our test file not in the listing — eventual consistency or listing bug?`);
  }

  log('5', 'Public read via browser fetch…');
  try {
    const res = await fetch(url, { method: 'GET' });
    if (res.ok) {
      const text = await res.text();
      const matches = text.trim() === TEST_BODY.trim();
      if (matches) {
        pass(`Public read returned the exact body. R2_PUBLIC_URL serves files publicly. ✨`);
      } else {
        warn(`Public read returned ${res.status} but body differs from upload.`);
      }
    } else {
      warn(`Public read returned ${res.status} ${res.statusText}.`);
      warn(`R2_PUBLIC_URL probably points to the S3 API endpoint (auth required).`);
      warn(`To fix: configure a custom domain in Cloudflare → R2 → ${r2.getR2BucketName()} → Settings → Public access,`);
      warn(`OR enable the bucket's managed .r2.dev URL and set R2_PUBLIC_URL to that.`);
    }
  } catch (e) {
    warn(`Public read failed: ${e.message}`);
  }

  log('6', 'Delete test object…');
  const ok = await r2.deleteObject(`${TEST_PREFIX}/${TEST_FILENAME}`);
  pass(`Delete ${ok ? 'OK' : 'failed (file may already be gone)'}`);

  console.log('\n✅ R2 smoke test complete.');
  console.log('   If step 5 warned about public reads, fix R2_PUBLIC_URL before Phase 2.');
  console.log('   Otherwise: the R2 client is wired correctly and ready for Phase 2 dual-write.');
})().catch(e => {
  console.error('\n❌ R2 smoke test failed:');
  console.error('   ', e.message);
  if (e.$metadata) {
    console.error('   httpStatusCode:', e.$metadata.httpStatusCode);
    console.error('   requestId:', e.$metadata.requestId);
  }
  console.error('\nCheck:');
  console.error('  • R2 token has Object Read+Write permissions on the bucket');
  console.error('  • R2_ENDPOINT format: https://{accountId}.r2.cloudflarestorage.com');
  console.error('  • Bucket name matches R2_BUCKET exactly (case-sensitive)');
  process.exit(1);
});
