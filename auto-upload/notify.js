// Notifications on success / failure. Console-only per spec.
// If you want Slack / email / Discord later, swap the body of `notify()`.

function ts() { return new Date().toISOString(); }

function notifyPublished(platform, beat, url) {
  // eslint-disable-next-line no-console
  console.log(`[${ts()}] ✅ LIVE on ${platform.toUpperCase()} — "${beat.beat_title}" → ${url}`);
}

function notifyFailed(platform, beat, err) {
  // eslint-disable-next-line no-console
  console.error(`[${ts()}] ❌ ${platform.toUpperCase()} failed for "${beat.beat_title}": ${err?.message || err}`);
}

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[${ts()}] ${msg}`);
}

module.exports = { notifyPublished, notifyFailed, log };
