'use strict';

// GET /api/feed?lat=43.23&lon=-86.25&radius_mi=3&hours=24
const { buildFeed } = require('../lib/feed');
const { parseLatLon } = require('../lib/geo');
const { sendJson, queryOf } = require('../lib/http');

module.exports = async (req, res) => {
  const q = queryOf(req);
  const center = parseLatLon(q);
  if (!center) return sendJson(res, 400, { error: 'Pass lat and lon, for example ?lat=43.23&lon=-86.25' });
  // Round to ~1 km so nearby viewers share one CDN-cached response.
  center.lat = Math.round(center.lat * 100) / 100;
  center.lon = Math.round(center.lon * 100) / 100;
  const radiusMi = Math.min(Math.max(Number(q.radius_mi) || 3, 0.5), 25);
  const hours = Math.min(Math.max(Number(q.hours) || 24, 1), 24 * 30);
  try {
    const feed = await buildFeed(center, { radiusMi, hours });
    sendJson(res, 200, feed, 60);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
};
