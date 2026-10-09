'use strict';

// GET /api/registry?lat=41.59&lon=-93.62&radius_mi=2
// Registered sex offenders near a point where the state lets apps read its
// registry, plus the official registry link for every state. Never cached
// at the edge: Iowa forbids storing its coordinates.
const { parseLatLon } = require('../lib/geo');
const { sendJson, queryOf } = require('../lib/http');
const { placeFor } = require('../lib/place');
const { registryFor } = require('../data/registries');
const { registrantsNear, WARNING } = require('../lib/sources/registry');

module.exports = async (req, res) => {
  const q = queryOf(req);
  const center = parseLatLon(q);
  if (!center) return sendJson(res, 400, { error: 'Pass lat and lon, for example ?lat=41.59&lon=-93.62' });
  const radiusMi = Math.min(Math.max(Number(q.radius_mi) || 2, 0.5), 10);
  try {
    const place = await placeFor(center);
    const official = registryFor(place.state);
    const started = Date.now();
    let result = { coverage: 'link', registrants: [], source: null, complete: true };
    let health = null;
    try {
      result = await registrantsNear(place.state, center, radiusMi);
      if (result.source) health = { id: result.source.id, label: `${result.source.agency} registry`, ok: true, count: result.registrants.length, ms: Date.now() - started };
    } catch (err) {
      health = { id: `${(place.state || 'xx').toLowerCase()}-sor`, label: `${(official && official.name) || 'State'} registry`, ok: false, count: 0, ms: Date.now() - started, error: err.message };
      result = { coverage: 'map', registrants: [], source: null, complete: true };
    }
    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      center,
      radiusMi,
      place: { label: place.label, state: place.state },
      official,
      coverage: result.coverage,
      registrants: result.registrants,
      complete: result.complete,
      warning: WARNING,
      sources: health ? [health] : [],
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
};
