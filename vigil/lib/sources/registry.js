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
// Field names differ by registry (checked against each one's live data in
// October 2026), so the reader finds name, photo, address and offense
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
  // The Highway Patrol's public registry map service (layer 7, "Offenders"):
  // one row per registered address (home, work, school, temporary),
  // geocoded by the Patrol, updated daily.
  MO: {
    id: 'missouri-sor',
    agency: 'Missouri State Highway Patrol',
    site: 'https://www.mshp.dps.missouri.gov/CJ38/searchRegistry.jsp',
    precision: 'address',
    layer: 'https://www.mshp.dps.mo.gov/arcgis/rest/services/NSOR/MapServer/7',
    idOf: (row) => [field(row, ['sid']), field(row, ['seq_nbr'])].filter(Boolean).join('-'),
    recordUrl: () => 'https://www.mshp.dps.missouri.gov/CJ38/searchRegistry.jsp',
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
    field(row, ['middle_name', 'middlename', 'middle_nm', 'mname', 'middle']),
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
  const street = field(row, ['address', 'street_address', 'address1', 'resaddr1', 'residence_address', 'block_address', 'blockname', 'block', 'street', 'location']);
  const city = field(row, ['city', 'rescity', 'residence_city']);
  const state = field(row, ['state', 'resstate', 'residence_state']);
  const where = [street, city, state].filter(Boolean).join(', ');
  // DC and Missouri list work, school and temporary addresses as well as
  // homes (Missouri as W, S, T and H).
  const type = field(row, ['type', 'address_type', 'location_type']);
  if (where && /^(w$|work|employ)/i.test(type)) return `Work: ${where}`;
  if (where && /^(s$|school|univ|student)/i.test(type)) return `School: ${where}`;
  if (where && /^(t$|temp)/i.test(type)) return `Temporary: ${where}`;
  return where;
}

function offensesOf(row) {
  const out = [];
  for (const [k, v] of Object.entries(row)) {
    // Offense text only: not dates or ID codes (DC's SEXOFFENDERCODE is an
    // ID). Tennessee lists offenses as Tca1..Tca5.
    if (!/offen|convict|crime|charge|statute|^tca\d$/i.test(k) || /date|code/i.test(k)) continue;
    const list = Array.isArray(v) ? v : [v];
    for (const o of list) {
      const d = o && typeof o === 'object'
        ? field(o, ['description', 'offense', 'offense_description', 'conviction', 'name', 'title', 'statute_description', 'statute'])
        : text(o);
      const clean = d.replace(/^\d{1,2}\/\d{1,2}\/\d{4}\s*/, ''); // Tennessee leads with the date
      if (clean && !/^\d+$/.test(clean)) out.push(clean);
    }
  }
  return [...new Set(out)].slice(0, 6);
}

function levelOf(row) {
  const level = field(row, ['tier', 'tier_level', 'level', 'risk_level', 'maxclassification', 'classification', 'class', 'designation']);
  return /^[A-Z]$/.test(level) ? `Class ${level}` : level; // DC classes are single letters
}

function coordsOf(row, geometry) {
  if (geometry && geometry.type === 'Point') return { lon: Number(geometry.coordinates[0]), lat: Number(geometry.coordinates[1]) };
  return { lat: Number(field(row, ['lat', 'latitude', 'y'])), lon: Number(field(row, ['lon', 'lng', 'long', 'longitude', 'x'])) };
}

function normalize(src, row, geometry, center) {
  const { lat, lon } = coordsOf(row, geometry);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) < 1 || Math.abs(lon) < 1) return null;
  const rid = src.idOf ? src.idOf(row) : field(row, ['registrant', 'registrant_id', 'registrantid', 'offender_id', 'tid', 'sor_id', 'id', 'objectid']);
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
    level: levelOf(row),
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

const IOWA_PAGE = 100;

async function iowa(center, radiusMi) {
  if (!iowaAllowed()) throw new Error('Iowa registry hourly limit reached; try again later or open the official registry');
  const range = Math.min(Math.max(Math.ceil(radiusMi), 1), 25);
  const url = `https://www.iowasexoffender.gov/api/search/results.json?lat=${center.lat}&lon=${center.lon}&range=${range}&per_page=${IOWA_PAGE}&page=1`;
  // ttl 0: Iowa forbids caching coordinates from location searches.
  const data = await fetchJson(url, { ttl: 0, timeoutMs: 10000 });
  const rows = Array.isArray(data) ? data : data.records || data.registrants || data.data || [];
  return { rows: rows.map((r) => normalize(SOURCES.IA, r, null, center)), full: rows.length >= IOWA_PAGE };
}

/* ---------- ArcGIS layers (Tennessee, DC, Missouri) ---------- */

function envelope({ lat, lon }, radiusMi) {
  const dLat = radiusMi / 69.0;
  const dLon = radiusMi / (69.17 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

// Map services answer at most 1,000 rows at a time (downtown Kansas City
// alone has about 1,000 registered addresses), so page through them.
const ARCGIS_PAGE = 1000;
const ARCGIS_PAGES = 6;

async function arcgis(src, center, radiusMi) {
  const rows = [];
  for (let page = 0; page < ARCGIS_PAGES; page++) {
    const params = new URLSearchParams({
      where: '1=1', outFields: '*', outSR: '4326', f: 'geojson', resultRecordCount: String(ARCGIS_PAGE), resultOffset: String(rows.length),
      geometry: envelope(center, radiusMi).join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    });
    // These registries update nightly or daily, so an hour of reuse is safe.
    const data = await fetchJson(`${src.layer}/query?${params}`, { ttl: 3600, timeoutMs: 10000 });
    const features = data.features || [];
    rows.push(...features.map((f) => normalize(src, f.properties || {}, f.geometry, center)));
    const more = data.exceededTransferLimit || (data.properties && data.properties.exceededTransferLimit);
    if (!more || !features.length) return { rows, full: false };
  }
  return { rows, full: true };
}

/* ---------- Public ---------- */

// `complete` is false when the registry capped its answer, so some people
// in the area are missing from it. Iowa's 100 are not the nearest 100, so
// a capped answer can't say who is newly listed.
async function registrantsNear(stateCode, center, radiusMi) {
  const src = SOURCES[stateCode];
  if (!src) return { coverage: 'link', registrants: [], source: null, complete: true };
  const { rows, full } = await (stateCode === 'IA' ? iowa(center, radiusMi) : arcgis(src, center, radiusMi));
  const registrants = rows
    .filter(Boolean)
    .filter((r) => r.distanceMi <= radiusMi)
    .sort((a, b) => a.distanceMi - b.distanceMi);
  return { coverage: 'map', registrants, source: src, complete: !full };
}

module.exports = { registrantsNear, normalize, iowaAllowed, SOURCES, WARNING, _iowaCalls: iowaCalls };
