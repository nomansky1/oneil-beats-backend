'use strict';

// Police calls-for-service and incident feeds for every city in
// data/city-feeds.json (built from OpenPoliceData's source table). Each
// agency names its columns differently, so this reader only relies on the
// date column from the table and finds location, type and address columns
// by name. Rows without coordinates are skipped rather than guessed.
const { fetchJson } = require('../http');
const { haversineMi } = require('../geo');
const { classify } = require('../classify');
const { zonedToUtc, utcToFloating, tzForState } = require('../time');
const { feeds: FEEDS } = require('../../data/city-feeds.json');

const TYPE_KEYS = ['call_type_final_desc', 'call_type', 'calltype', 'final_call_type', 'initial_call_type', 'nature_of_call', 'nature', 'event_type', 'incident_type', 'type', 'offense_description', 'offense', 'crime_type', 'primary_type', 'incident_category', 'category', 'description', 'callcategory', 'problem'];
const ADDRESS_KEYS = ['block_address', 'block', 'address', 'location_text', 'intersection', 'street', 'location_desc', 'location'];

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(row, keys, guessType = false) {
  const byNorm = new Map(Object.keys(row).map((k) => [norm(k), k]));
  for (const k of keys) {
    const real = byNorm.get(norm(k));
    if (real && typeof row[real] === 'string' && row[real].trim()) return row[real].trim();
  }
  if (!guessType) return '';
  // Fall back to the first text column whose name looks like a type.
  const guess = Object.keys(row).find((k) => /type|desc|offen|crime|nature|categ/i.test(k) && typeof row[k] === 'string' && row[k].trim());
  return guess ? row[guess].trim() : '';
}

function coordsOf(row, geometry) {
  if (geometry && geometry.type === 'Point') return { lon: Number(geometry.coordinates[0]), lat: Number(geometry.coordinates[1]) };
  let lat, lon;
  for (const [k, v] of Object.entries(row)) {
    const n = norm(k);
    if (v && typeof v === 'object' && v.type === 'Point' && Array.isArray(v.coordinates)) return { lon: Number(v.coordinates[0]), lat: Number(v.coordinates[1]) };
    if (v && typeof v === 'object' && 'latitude' in v && 'longitude' in v) return { lat: Number(v.latitude), lon: Number(v.longitude) };
    if (lat === undefined && /^(lat|latitude|y|ycoord|latitudey)$/.test(n)) lat = Number(v);
    if (lon === undefined && /^(lon|lng|long|longitude|x|xcoord|longitudex)$/.test(n)) lon = Number(v);
  }
  return { lat, lon };
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

function normalize(feed, row, geometry) {
  const { lat, lon } = coordsOf(row, geometry);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) < 1 || Math.abs(lon) < 1) return null;
  const rawTime = row[feed.dateField];
  const time = typeof rawTime === 'number' ? new Date(rawTime).toISOString() : zonedToUtc(rawTime, zoneOf(feed));
  if (!time) return null;
  const type = titleCase(pick(row, TYPE_KEYS, true)) || (feed.type === 'calls' ? 'Dispatched call' : 'Police report');
  const address = titleCase(pick(row, ADDRESS_KEYS));
  const cls = classify(type) || { category: 'crime', severity: 1 };
  const rowId = row.objectid || row.OBJECTID || row.id || row.incident_number || row.case_number || `${time}-${lat.toFixed(5)}-${lon.toFixed(5)}`;
  return {
    id: `${feed.id}:${rowId}`,
    kind: 'incident',
    category: cls.category,
    severity: cls.severity,
    title: type,
    summary: address ? `Reported near ${address}` : '',
    details: '',
    lat, lon,
    precision: 'block',
    place: address ? `${address}, ${feed.city}` : feed.city,
    time,
    sources: [{ name: feed.agency, kind: 'official', tier: 'gov', url: feed.sourceUrl || feed.url, time }],
    confirmed: [`${feed.agency} logged this ${feed.type === 'calls' ? 'call' : 'report'}${type ? ` as “${type}”` : ''}`],
    unconfirmed: [feed.type === 'calls' ? 'Calls are logged when dispatched and can change once officers report back' : 'Report details can change as the case develops'],
  };
}

// Columns named like "createddateutc" are already UTC.
const zoneOf = (feed) => (/utc/i.test(feed.dateField) ? 'UTC' : tzForState(feed.state));

function since(feed, hours) {
  return new Date(Date.now() - hours * 3600e3);
}

async function fetchSocrata(feed, hours) {
  const floating = utcToFloating(since(feed, hours), zoneOf(feed));
  const where = encodeURIComponent(`${feed.dateField} > '${floating}'`);
  const url = `${feed.url}?$where=${where}&$order=${feed.dateField}%20DESC&$limit=1000`;
  const rows = await fetchJson(url, { ttl: 60 });
  return rows.map((r) => normalize(feed, r, null));
}

async function fetchArcgis(feed, hours) {
  const ts = since(feed, hours).toISOString().slice(0, 19).replace('T', ' ');
  const params = new URLSearchParams({
    where: `${feed.dateField} >= TIMESTAMP '${ts}'`,
    outFields: '*', outSR: '4326', f: 'geojson',
    orderByFields: `${feed.dateField} DESC`, resultRecordCount: '1000',
  });
  const data = await fetchJson(`${feed.url.replace(/\/$/, '')}/query?${params}`, { ttl: 60 });
  return (data.features || []).map((f) => normalize(feed, f.properties || {}, f.geometry));
}

async function fetchFeed(feed, center, radiusMi, hours) {
  const rows = await (feed.platform === 'socrata' ? fetchSocrata(feed, hours) : fetchArcgis(feed, hours));
  return rows.filter(Boolean).filter((it) => haversineMi(center, it) <= radiusMi);
}

const clean = (s) => String(s || '').toLowerCase().replace(/\bsaint\b/g, 'st').replace(/[^a-z]/g, '');

// Match on the viewer's state and city (or county, for county agencies).
// OpenStreetMap names counties "Montgomery County"; the table may too.
function feedsFor(place, exclude = new Set()) {
  if (!place || !place.stateName) return [];
  const city = clean(place.city);
  const county = clean(place.county).replace(/county$/, '');
  return FEEDS.filter((f) => clean(f.state) === clean(place.stateName))
    .filter((f) => {
      const a = clean(f.city);
      return (city && (a === city || a.startsWith(city))) || (county && a === `${county}county`);
    })
    .filter((f) => !exclude.has(f.url));
}

module.exports = { feedsFor, fetchFeed, normalize, coordsOf, pick, FEEDS };
