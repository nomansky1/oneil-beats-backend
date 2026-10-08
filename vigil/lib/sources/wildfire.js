'use strict';

// Wildfires, from two federal sources:
//   - NIFC WFIGS current incidents: every active wildfire with size and
//     containment. Public ArcGIS layer, no key.
//   - NASA FIRMS satellite heat detections (VIIRS): only with a free
//     FIRMS_MAP_KEY. Heat, not confirmed fire, and labeled that way.
const { fetchJson, fetchText } = require('../http');

const WFIGS = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';
const FIELDS = 'IrwinID,UniqueFireIdentifier,IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt,POOState,POOCounty,FireCause,IncidentTypeCategory';
const NIFC_PAGE = 'https://data-nifc.opendata.arcgis.com/';

function envelope({ lat, lon }, radiusMi) {
  const dLat = radiusMi / 69.0;
  const dLon = radiusMi / (69.17 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

const fmtAcres = (a) => (a >= 100 ? Math.round(a).toLocaleString('en-US') : a >= 1 ? a.toFixed(1) : a.toFixed(2));

function normalizeIncident(f) {
  const p = f.properties || {};
  const [lon, lat] = (f.geometry && f.geometry.coordinates) || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const acres = Number(p.IncidentSize) || 0;
  const pct = p.PercentContained == null ? null : Number(p.PercentContained);
  const severity = acres >= 1000 && (pct == null || pct < 50) ? 3 : acres >= 100 || (pct != null && pct < 100) ? 2 : 1;
  const state = String(p.POOState || '').replace(/^US-/, '');
  const name = String(p.IncidentName || 'Unnamed').trim();
  const discovered = p.FireDiscoveryDateTime ? new Date(p.FireDiscoveryDateTime).toISOString() : null;
  const updated = p.ModifiedOnDateTime_dt ? new Date(p.ModifiedOnDateTime_dt).toISOString() : discovered;
  const size = acres ? `${fmtAcres(acres)} acres` : 'Size not reported';
  const contained = pct == null ? 'containment not reported' : `${Math.round(pct)}% contained`;
  return {
    id: `nifc:${p.IrwinID || p.UniqueFireIdentifier}`,
    kind: 'incident',
    category: 'fire',
    severity,
    title: /fire$/i.test(name) ? name : `${name} Fire`,
    summary: `${size} · ${contained}`,
    details: [discovered ? `Discovered ${new Date(discovered).toUTCString().slice(0, 16)}.` : '', p.FireCause ? `Cause: ${p.FireCause}.` : ''].filter(Boolean).join(' '),
    lat, lon,
    precision: 'exact',
    place: [p.POOCounty ? `${p.POOCounty} County` : '', state].filter(Boolean).join(', '),
    // Active fires can be weeks old, so they sort by their latest update.
    time: updated,
    discovered,
    sources: [{ name: 'National Interagency Fire Center (WFIGS)', kind: 'official', tier: 'gov', url: NIFC_PAGE, time: updated }],
    confirmed: [`Listed as an active wildfire: ${size}, ${contained}`],
    unconfirmed: ['The map point is where the fire started, not its current edge'],
  };
}

async function incidents(where, geometry) {
  const params = new URLSearchParams({ where, outFields: FIELDS, outSR: '4326', f: 'geojson', resultRecordCount: '2000' });
  if (geometry) {
    params.set('geometry', geometry.join(','));
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }
  const data = await fetchJson(`${WFIGS}?${params}`, { ttl: 300 });
  return (data.features || []).map(normalizeIncident).filter(Boolean);
}

// Fires matter well beyond a few blocks, so look at least 50 miles out.
const firesNear = (center, radiusMi) => incidents("IncidentTypeCategory = 'WF'", envelope(center, Math.max(radiusMi, 50)));
const largeFiresNationwide = () => incidents("IncidentTypeCategory = 'WF' AND IncidentSize >= 1000", null);

/* ---------- NASA FIRMS heat detections ---------- */

function parseCsv(text) {
  const [head, ...lines] = String(text).trim().split(/\r?\n/);
  if (!head || !head.includes('latitude')) return [];
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}

function confident(row) {
  const c = String(row.confidence || '').toLowerCase();
  if (c === 'l' || c === 'low') return false;
  if (/^\d+$/.test(c)) return Number(c) >= 50; // MODIS reports 0–100
  return true; // VIIRS nominal / high
}

function detectionTime(row) {
  const hhmm = String(row.acq_time || '0').padStart(4, '0');
  return new Date(`${row.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`).toISOString();
}

// Group detections in ~1 km cells so one fire isn't fifty pins.
function groupDetections(rows) {
  const cells = new Map();
  for (const r of rows.filter(confident)) {
    const lat = Number(r.latitude), lon = Number(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const time = detectionTime(r);
    const cell = cells.get(key) || { lat: 0, lon: 0, n: 0, latest: time, frp: 0 };
    cell.lat += lat; cell.lon += lon; cell.n += 1;
    cell.frp = Math.max(cell.frp, Number(r.frp) || 0);
    if (time > cell.latest) cell.latest = time;
    cells.set(key, cell);
  }
  return [...cells.entries()].map(([key, c]) => ({
    id: `firms:${key}:${c.latest.slice(0, 13)}`,
    kind: 'incident',
    category: 'fire',
    severity: 1,
    title: c.n > 1 ? `Satellite heat detection (${c.n} spots)` : 'Satellite heat detection',
    summary: 'A satellite picked up strong heat here. It may be a wildfire, a controlled burn or industrial heat.',
    details: c.frp ? `Strongest reading: ${c.frp.toFixed(1)} MW fire radiative power.` : '',
    lat: c.lat / c.n, lon: c.lon / c.n,
    precision: 'block',
    place: '',
    time: c.latest,
    sources: [{ name: 'NASA FIRMS (VIIRS satellite)', kind: 'official', tier: 'gov', url: 'https://firms.modaps.eosdis.nasa.gov/map/', time: c.latest }],
    confirmed: ['Heat detected from orbit'],
    unconfirmed: ['Whether this is an uncontrolled fire', 'Exact location (each reading covers about 375 m)'],
  }));
}

async function heatNear(center, radiusMi) {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) {
    const err = new Error('Add a free FIRMS_MAP_KEY to enable');
    err.notConfigured = true;
    throw err;
  }
  const [w, s, e, n] = envelope(center, Math.max(radiusMi, 25)).map((v) => v.toFixed(3));
  const text = await fetchText(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/${w},${s},${e},${n}/1`, { ttl: 600 });
  return groupDetections(parseCsv(text));
}

module.exports = { firesNear, largeFiresNationwide, heatNear, normalizeIncident, groupDetections, parseCsv, envelope };
