'use strict';

// GET /api/geocode?q=Muskegon — place search limited to the 50 states, DC
// and the five inhabited territories.
const { searchPlaces } = require('../lib/place');
const { sendJson, queryOf } = require('../lib/http');

module.exports = async (req, res) => {
  const q = String(queryOf(req).q || '').trim();
  if (q.length < 2) return sendJson(res, 400, { error: 'Type at least 2 characters' });
  try {
    sendJson(res, 200, { results: await searchPlaces(q) }, 86400);
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
};
