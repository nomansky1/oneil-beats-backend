'use strict';

// Background registry alerts for one phone.
//   GET    /api/push   -> { publicKey, enabled } for the browser's push subscription
//   POST   /api/push   { subscription, lat, lon, radiusMi } -> start, or move the area
//   DELETE /api/push   { endpoint } -> stop and forget the area
// Only areas where a registry is on the map are accepted, and the area is
// stored rounded to about 1 km.
const { sendJson } = require('../lib/http');
const { parseLatLon } = require('../lib/geo');
const { placeFor } = require('../lib/place');
const { SOURCES } = require('../lib/sources/registry');
const db = require('../lib/alerts-db');
const push = require('../lib/push');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8000) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  const enabled = db.configured() && push.configured();
  if (req.method === 'GET') return sendJson(res, 200, { enabled, publicKey: enabled ? process.env.VAPID_PUBLIC_KEY : null });
  if (!enabled) return sendJson(res, 503, { error: 'Background alerts are not set up on this server' });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Send JSON' });
  }
  try {
    if (req.method === 'DELETE') {
      if (typeof body.endpoint !== 'string') return sendJson(res, 400, { error: 'Pass the subscription endpoint' });
      await db.unsubscribe(body.endpoint);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use GET, POST or DELETE' });
    const sub = body.subscription || {};
    const keys = sub.keys || {};
    const center = parseLatLon({ lat: body.lat, lon: body.lon });
    const radiusMi = Number(body.radiusMi);
    if (typeof sub.endpoint !== 'string' || !keys.p256dh || !keys.auth || !center || !(radiusMi >= 0.5 && radiusMi <= 10)) {
      return sendJson(res, 400, { error: 'Pass subscription, lat, lon and radiusMi (0.5 to 10)' });
    }
    const place = await placeFor(center);
    if (!SOURCES[place.state]) return sendJson(res, 200, { ok: false, reason: 'No registry map for this area yet' });
    await db.subscribe({ endpoint: sub.endpoint, p256dh: String(keys.p256dh), auth: String(keys.auth), state: place.state, lat: center.lat, lon: center.lon, radiusMi });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const bad = /unsupported push service|bad subscription/.test(err.message);
    sendJson(res, bad ? 400 : 502, { error: bad ? 'This browser’s push service isn’t supported' : 'Could not save the alert right now' });
  }
};
