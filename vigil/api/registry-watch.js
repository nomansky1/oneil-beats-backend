'use strict';

// Called every 15 minutes by pg_cron in the alerts database (see
// db/002_watch_schedule.sql) with the shared WATCH_SECRET. Checks every
// watched area for newly listed registrants and sends the push alerts.
const { sendJson } = require('../lib/http');
const { runWatch } = require('../lib/watch');

module.exports = async (req, res) => {
  const secret = process.env.WATCH_SECRET;
  if (!secret || req.headers['x-vigil-watch'] !== secret) return sendJson(res, 401, { error: 'Not allowed' });
  try {
    sendJson(res, 200, await runWatch({ budgetMs: 45000 }));
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
};
