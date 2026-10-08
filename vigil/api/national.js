'use strict';

// GET /api/national — severe alerts, significant quakes and top safety
// stories across all states and territories.
const { buildNational } = require('../lib/feed');
const { sendJson } = require('../lib/http');

module.exports = async (req, res) => {
  try {
    sendJson(res, 200, await buildNational(), 120);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
};
