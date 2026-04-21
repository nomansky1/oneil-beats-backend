#!/usr/bin/env node
// Standalone worker entrypoint.
//
// Run with:  node backend/auto-upload/worker.js
//
// This process stays alive, ticks every 15 min, processes the queue.
// Put it on Railway/Render/Fly (or keep it on a laptop with pm2) — any Node
// host that keeps processes alive. It does NOT belong on Vercel.
//
// Graceful shutdown on SIGINT/SIGTERM so a deploying orchestrator (Render,
// Fly) doesn't kill a job mid-upload.

const autoUpload = require('./index');
const notify = require('./notify');

const task = autoUpload.startWorker();

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  notify.log(`received ${sig} — stopping cron`);
  try { task.stop(); } catch (_) {}
  // Give any in-flight tick 90s to wrap up, then exit.
  setTimeout(() => process.exit(0), 90_000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  notify.log(`unhandledRejection: ${err && err.stack || err}`);
});
