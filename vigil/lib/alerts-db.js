'use strict';

// The alerts database (Supabase project "Vigil", see db/*.sql). The site
// reaches it only through functions that need WATCH_SECRET, so the public
// key on its own reads and writes nothing.
const configured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY && process.env.WATCH_SECRET);

async function rpc(fn, args = {}) {
  if (!configured()) throw Object.assign(new Error('Alerts database not configured'), { notConfigured: true });
  const key = process.env.SUPABASE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: process.env.WATCH_SECRET, ...args }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`alerts database: ${fn} failed (${res.status}) ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

module.exports = {
  configured,
  subscribe: (s) => rpc('vigil_subscribe', {
    p_endpoint: s.endpoint, p_p256dh: s.p256dh, p_auth: s.auth,
    p_state: s.state, p_lat: s.lat, p_lon: s.lon, p_radius_mi: s.radiusMi,
  }),
  unsubscribe: (endpoint) => rpc('vigil_unsubscribe', { p_endpoint: endpoint }),
  watchAreas: () => rpc('vigil_watch_areas'),
  watchDiff: (areaKey, ids) => rpc('vigil_watch_diff', { p_area_key: areaKey, p_ids: ids }),
  areaSubscribers: (areaKey) => rpc('vigil_area_subscribers', { p_area_key: areaKey }),
};
