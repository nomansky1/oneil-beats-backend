#!/usr/bin/env node
// One-shot entry point for scheduled runners (GitHub Actions, Vercel Cron, etc.)
//
// Runs runOnce() exactly one time, then exits. Unlike worker.js, this does NOT
// keep the process alive — it's meant to be invoked by an external scheduler.
//
//   node backend/auto-upload/tick-once.js
//
// Exits 0 on a clean tick (even if nothing was claimed), 1 on an unhandled
// error so CI can surface the failure.

// Load .env when present — harmless if the file doesn't exist (CI uses
// environment secrets directly instead).
try { require('dotenv').config(); } catch (_) { /* optional */ }

const autoUpload = require('./index');
const notify = require('./notify');

(async () => {
  const started = Date.now();
  try {
    await autoUpload.runOnce();
    notify.log(`tick-once finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (err) {
    notify.log(`tick-once failed: ${err && err.stack || err}`);
    process.exit(1);
  }
})();
