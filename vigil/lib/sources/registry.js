'use strict';

// Registered sex offenders near a point, from the official registries that
// let apps read their data:
//   - Iowa DPS data API (photos). Its terms: under 50 requests an hour,
//     coordinates never cached and used only to place a point on a map.
//   - Tennessee Bureau of Investigation map service (geocoded nightly).
//   - District of Columbia open data (block-level locations, CC BY 4.0).
// Every other state, DC and territory gets a link to its official registry
// (data/registries.js); their sites forbid automated collection.
//
// Field names differ by registry and were taken from each agency's
// documentation, so the reader finds name, photo, address and offense
// fields by name rather than trusting one exact schema.
const { fetchJson } = require('../http');
const { haversineMi } = require('../geo');

const WARNING = 'Registry information must not be used to threaten, harass or hurt anyone listed, or anyone living or working at a listed address. Doing so can bring civil or criminal penalties (34 U.S.C. § 20920). This is not a background check: names can match the wrong person, so rely on the official record.';

const SOURCES = {
  IA: {
    id: 'iowa-sor',
    agency: 'Iowa Dept. of Public Safety',
    site: 'https://www.iowasexoffender.gov/',
    precision: 'address',
    recordUrl: (id) => `https://www.iowasexoffender.gov/registrant/${encodeURIComponent(id)}`,
  },
  TN: {
    id: 'tennessee-sor',
    agency: 'Tennessee Bureau of Investigation',
    site: 'https://sor.tbi.tn.gov/search',
    precision: 'address',
    layer: 'https://tnmap.tn.gov/arcgis/rest/services/PUBLIC_SAFETY/TBI_SEX_OFFENDER_REGISTRY/MapServer/0',
    recordUrl: (id) => `https://tnmap.tn.gov/sor/?TID=${encodeURIComponent(id)}`,
  },
  DC: {
    id: 'dc-sor',
    agency: 'DC Court Services and Offender Supervision Agency (via DC open data)',
    site: 'https://mpdc.dc.gov/service/sex-offender-registry',
    precision: 'block',
    layer: 'https://maps2.dcgis.dc.gov/dcgis/rest/services/FEEDS/MPD/MapServer/20',
    recordUrl: () => 'https://sexoffender.dc.gov/',
  },
};

/* ---------- Field finding ---------- */

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (v) => (v == null ? '' : String(v).trim());

function field(row, names) {
  const byNorm = new Map(Object.keys(row).map((k) => [norm(k), k]));
  for (const n of names) {
    const real = byNorm.get(norm(n));
    if (real != null && text(row[real]) && typeof row[real] !== 'object') return text(row[real]);
  }
  return '';
}

function nameOf(row) {
  const full = field(row, ['full_name', 'fullname', 'name', 'offender_name', 'display_name']);
  if (full) return full;
  const parts = [
    field(row, ['first_name', 'firstname', 'fname', 'first', 'given_name']),
    field(row, ['middle_name', 'middlename', 'mname', 'middle']),
    field(row, ['last_name', 'lastname', 'lname', 'last', 'surname']),
    field(row, ['suffix', 'name_suffix']),
  ].filter(Boolean);
  return parts.join(' ');
}

function photoOf(row, base) {
  for (const [k, v] of Object.entries(row)) {
    if (!/photo|image|picture|mugshot/i.test(k) || typeof v !== 'string' || !v.trim()) continue;
    try {
      const url = new URL(v.trim(), base);
      if (url.protocol === 'https:') return url.href;
    } catch { /* not a URL */ }
  }
  return '';
}

function addressOf(row) {
  const street = field(row, ['address', 'street_address', 'address1', 'residence_address', 'block_address', 'block', 'street', 'location']);
  const city = field(row, ['city', 'residence_city']);
  const state = field(row, ['state', 'residence_state']);
  return [street, city, state].filter(Boolean).join(', ');
}

function offensesOf(row) {
  const out = [];
  for (const [k, v] of Object.entries(row)) {
    if (!/offen|convict|crime|charge|statute/i.test(k)) continue;
    const list = Array.isArray(v) ? v : [v];
    for (const o of list) {
      if (o && typeof o === 'object') {
        const d = field(o, ['description', 'offense', 'offense_description', 'name', 'title', 'statute_description', 'statute']);
        if (d) out.push(d);
      } else if (text(o) && !/^\d+$/.test(text(o))) out.push(text(o));
    }
  }
  return [...new Set(out)].slice(0, 6);
}

function coordsOf(row, geometry) {
  if (geometry && geometry.type === 'Point') return { lon: Number(geometry.coordinates[0]), lat: Number(geometry.coordinates[1]) };
  return { lat: Number(field(row, ['lat', 'latitude', 'y'])), lon: Number(field(row, ['lon', 'lng', 'long', 'longitude', 'x'])) };
}

function normalize(src, row, geometry, center) {
  const { lat, lon } = coordsOf(row, geometry);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) < 1 || Math.abs(lon) < 1) return null;
  const rid = field(row, ['registrant', 'registrant_id', 'registrantid', 'offender_id', 'tid', 'sor_id', 'id', 'objectid']);
  if (!rid) return null;
  return {
    id: `${src.id}:${rid}`,
    kind: 'registrant',
    name: nameOf(row),
    photo: photoOf(row, src.site),
    lat, lon,
    precision: src.precision,
    address: addressOf(row),
    offenses: offensesOf(row),
    level: field(row, ['tier', 'tier_level', 'level', 'risk_level', 'classification', 'class', 'designation', 'sexoffendercode']),
    updated: field(row, ['last_updated', 'updated', 'last_verified', 'verified', 'modified', 'last_registration']),
    recordUrl: src.recordUrl(rid),
    source: { name: src.agency, url: src.site },
    distanceMi: Math.round(haversineMi(center, { lat, lon }) * 10) / 10,
  };
}

/* ---------- Iowa ---------- */

// Iowa asks for under 50 requests an hour; stay under that per server.
const IOWA_PER_HOUR = 45;
const iowaCalls = [];

function iowaAllowed(now = Date.now()) {
  while (iowaCalls.length && now - iowaCalls[0] > 3600e3) iowaCalls.shift();
  if (iowaCalls.length >= IOWA_PER_HOUR) return false;
  iowaCalls.push(now);
  return true;
}

async function iowa(center, radiusMi) {
  if (!iowaAllowed()) throw new Error('Iowa registry hourly limit reached; try again later or open the official registry');
  const range = Math.min(Math.max(Math.ceil(radiusMi), 1), 25);
  const url = `https://www.iowasexoffender.gov/api/search/results.json?lat=${center.lat}&lon=${center.lon}&range=${range}&per_page=100&page=1`;
  // ttl 0: Iowa forbids caching coordinates from location searches.
  const data = await fetchJson(url, { ttl: 0, timeoutMs: 10000 });
  const rows = Array.isArray(data) ? data : data.records || data.results || data.registrants || data.data || [];
  return rows.map((r) => normalize(SOURCES.IA, r, null, center));
}

/* ---------- ArcGIS layers (Tennessee, DC) ---------- */

function envelope({ lat, lon }, radiusMi) {
  const dLat = radiusMi / 69.0;
  const dLon = radiusMi / (69.17 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

async function arcgis(src, center, radiusMi) {
  const params = new URLSearchParams({
    where: '1=1', outFields: '*', outSR: '4326', f: 'geojson', resultRecordCount: '2000',
    geometry: envelope(center, radiusMi).join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
  });
  // Both registries update nightly, so an hour of reuse is safe.
  const data = await fetchJson(`${src.layer}/query?${params}`, { ttl: 3600, timeoutMs: 10000 });
  return (data.features || []).map((f) => normalize(src, f.properties || {}, f.geometry, center));
}

/* ---------- Public ---------- */

async function registrantsNear(stateCode, center, radiusMi) {
  const src = SOURCES[stateCode];
  if (!src) return { coverage: 'link', registrants: [], source: null };
  const rows = await (stateCode === 'IA' ? iowa(center, radiusMi) : arcgis(src, center, radiusMi));
  const registrants = rows
    .filter(Boolean)
    .filter((r) => r.distanceMi <= radiusMi)
    .sort((a, b) => a.distanceMi - b.distanceMi);
  return { coverage: 'map', registrants, source: src };
}

module.exports = { registrantsNear, normalize, iowaAllowed, SOURCES, WARNING, _iowaCalls: iowaCalls };
