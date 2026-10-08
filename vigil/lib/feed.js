'use strict';

// Builds the local feed for one point: every source runs in parallel, a
// failing source never takes the others down, and the response says which
// sources answered so the app can show it.
const { haversineMi } = require('./geo');
const { withVerification } = require('./verify');
const { placeFor } = require('./place');
const nws = require('./sources/nws');
const usgs = require('./sources/usgs');
const fema = require('./sources/fema');
const opendata = require('./sources/opendata');
const news = require('./sources/news');
const x = require('./sources/x');
const { accountsFor } = require('./x-accounts');

async function timed(id, label, fn) {
  const started = Date.now();
  try {
    const items = await fn();
    return { health: { id, label, ok: true, count: items.length, ms: Date.now() - started }, items };
  } catch (err) {
    return {
      health: { id, label, ok: false, count: 0, ms: Date.now() - started, error: err.message, notConfigured: Boolean(err.notConfigured) },
      items: [],
    };
  }
}

async function buildFeed(center, { radiusMi = 3, hours = 24 } = {}) {
  let place = { label: '', city: '', county: '', state: null };
  const placeRun = await timed('place', 'Place lookup (OpenStreetMap)', async () => {
    place = await placeFor(center);
    return [place];
  });

  const runs = await Promise.all([
    timed('nws', 'National Weather Service alerts', () => nws.alertsNear(center)),
    timed('usgs', 'USGS earthquakes', () => usgs.quakesNear(center, radiusMi, hours)),
    timed('fema', 'FEMA disaster declarations', () => fema.declarationsFor(place, center)),
    ...opendata.feedsFor(center).map((f) => timed(f.id, f.label, () => opendata.fetchFeed(f, center, radiusMi, hours))),
    timed('news', 'Local news (Google News, GDELT)', () => (place.city || place.label ? news.storiesFor(place, center, hours) : [])),
    timed('x', 'X search (paid API, optional)', () => x.postsFor(place, center)),
  ]);

  const cutoff = Date.now() - hours * 3600e3;
  const seen = new Set();
  const all = runs
    .flatMap((r) => r.items)
    .filter((it) => (seen.has(it.id) ? false : seen.add(it.id)))
    .map((it) => (it.verification ? it : withVerification(it)))
    .map((it) => ({ ...it, distanceMi: it.lat != null ? Math.round(haversineMi(center, it) * 10) / 10 : null }));

  const area = all.filter((it) => it.kind === 'area');
  const items = all
    .filter((it) => it.kind !== 'area')
    .filter((it) => !it.time || new Date(it.time) >= cutoff)
    .sort((a, b) => new Date(b.time) - new Date(a.time));

  return {
    generatedAt: new Date().toISOString(),
    center,
    radiusMi,
    hours,
    place,
    area,
    items,
    xAccounts: accountsFor(center),
    sources: [placeRun.health, ...runs.map((r) => r.health)],
  };
}

async function buildNational() {
  const runs = await Promise.all([
    timed('nws', 'Severe and extreme NWS alerts', () => nws.severeNationwide()),
    timed('usgs', 'USGS M4.5+ earthquakes', () => usgs.significantNationwide()),
    timed('news', 'National news (Google News)', () => news.nationalStories(24)),
  ]);
  const items = runs
    .flatMap((r) => r.items)
    .map((it) => (it.verification ? it : withVerification(it)))
    .sort((a, b) => b.severity - a.severity || new Date(b.time) - new Date(a.time))
    .slice(0, 80);
  return { generatedAt: new Date().toISOString(), items, sources: runs.map((r) => r.health) };
}

module.exports = { buildFeed, buildNational };
