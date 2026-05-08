// Public API for the rest of the backend.
//
// Usage (in server.js, after a beat is registered):
//
//   const autoUpload = require('./auto-upload');
//   await autoUpload.enqueueBeat({
//     id: 'beat-uuid',
//     title: 'Luna',
//     slug: 'luna',
//     genre: 'Reggaeton',
//     bpm: 97,
//     key: 'C# Minor',
//     mood: 'Smooth',
//     audioUrl: 'https://…/luna-tagged.mp3',   // Supabase public URL
//     coverUrl: 'https://…/luna-cover.jpg',    // optional but recommended
//     // videoPath: '/path/to/pre-rendered.mp4'  // alternative if you have one
//   });
//
// The worker synthesizes a 16:9 static-cover video from audioUrl on the
// first cron tick, so you don't need to render one yourself.
//
// And optionally:
//
//   autoUpload.registerRoutes(app);   // adds POST /admin/auto-upload/tick
//   autoUpload.startWorker();          // starts node-cron (local/standalone only)

const q = require('./queue');
const { tickHandler, startCron, runOnce } = require('./cron');
const notify = require('./notify');

async function enqueueBeat(beat) {
  // Light validation up front so bad input doesn't silently poison the queue.
  if (!beat) throw new Error('enqueueBeat: beat required');
  if (!beat.id && !beat.beat_id) throw new Error('enqueueBeat: beat.id required');
  if (!beat.title)   throw new Error('enqueueBeat: beat.title required');
  if (!beat.genre)   throw new Error('enqueueBeat: beat.genre required');
  if (!beat.audioUrl && !beat.videoPath) {
    throw new Error('enqueueBeat: need beat.audioUrl (for synthesis) or beat.videoPath (pre-rendered)');
  }

  const job = await q.enqueue(beat);
  notify.log(`enqueued auto-upload job for "${beat.title}" (id=${job.id})`);
  return job;
}

function registerRoutes(app) {
  // Optional shared-secret guard. Set ADMIN_SECRET in env and pass it as
  // `x-admin-secret` header to block random hits.
  app.post('/admin/auto-upload/tick', (req, res, next) => {
    const expected = process.env.ADMIN_SECRET;
    if (expected && req.get('x-admin-secret') !== expected) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
  }, tickHandler);

  // Manual enqueue endpoint — handy for testing or a "retry" button in an
  // admin UI. Body: the same shape as enqueueBeat expects.
  app.post('/admin/auto-upload/enqueue', async (req, res) => {
    const expected = process.env.ADMIN_SECRET;
    if (expected && req.get('x-admin-secret') !== expected) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const job = await enqueueBeat(req.body);
      res.json({ ok: true, job });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Read-only queue listing for the OB Uploader mobile app's queue panel.
  // GET /admin/auto-upload/list?platform=youtube&limit=25
  // Auth: x-admin-key (matches the rest of /admin/* routes elsewhere in the
  // backend) so the mobile uploader can use its existing setup credentials.
  app.get('/admin/auto-upload/list', (req, res, next) => {
    const expectedKey = process.env.ADMIN_KEY;
    if (expectedKey && req.get('x-admin-key') !== expectedKey) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    next();
  }, async (req, res) => {
    try {
      const platform = String(req.query.platform || 'youtube').toLowerCase();
      const limit = Math.min(100, parseInt(req.query.limit, 10) || 25);
      const jobs = await q.listJobs({ platform, limit });
      res.json({ success: true, platform, jobs });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });
}

function startWorker() {
  return startCron();
}

module.exports = {
  enqueueBeat,
  registerRoutes,
  startWorker,
  runOnce, // exposed so tests / manual runs can trigger a single pass
};
