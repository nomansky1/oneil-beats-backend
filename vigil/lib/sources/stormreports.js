'use strict';

// Local storm reports: what spotters, police, emergency managers and the
// public reported to the National Weather Service (tornado touchdowns,
// hail, downed trees and power lines, flooding, snow totals), with the
// spot it happened. Served nationwide by the Iowa Environmental Mesonet
// (Iowa State University) as GeoJSON. Public domain; IEM asks for credit.
// https://mesonet.agron.iastate.edu/request/gis/lsrs.phtml
const { fetchJson } = require('../http');
const { haversineMi } = require('../geo');

const BASE = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson';
const PAGE = 'https://mesonet.agron.iastate.edu/lsr/';

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const LABELS = { 'TSTM WND DMG': 'Thunderstorm wind damage', 'TSTM WND GST': 'Thunderstorm wind gust', 'NON-TSTM WND DMG': 'Wind damage', 'NON-TSTM WND GST': 'Wind gust', 'FLASH FLOOD': 'Flash flooding', 'FUNNEL CLOUD': 'Funnel cloud' };

function severityOf(type, magnitude) {
  if (/^TORNADO/.test(type)) return 3;
  if (/WND DMG|FLASH FLOOD|WILDFIRE|DEBRIS FLOW/.test(type)) return 2;
  if (type === 'HAIL' && Number(magnitude) >= 2) return 2; // 2-inch hail and up
  return 1;
}

function normalize(f) {
  const p = f.properties || {};
  const [lon, lat] = (f.geometry && f.geometry.coordinates) || [p.lon, p.lat];
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  const type = String(p.typetext || '').toUpperCase();
  const label = LABELS[type] || titleCase(type) || 'Storm report';
  const mag = p.magnitude && p.magnitude !== 'None' ? `${p.magnitude}${p.unit ? ` ${String(p.unit).toLowerCase()}` : ''}` : '';
  const where = [titleCase(p.city), p.county ? `${titleCase(p.county)} County` : '', p.state].filter(Boolean).join(', ');
  const time = p.valid ? new Date(/Z|[+-]\d\d:?\d\d$/.test(p.valid) ? p.valid : `${p.valid}Z`).toISOString() : null;
  const reporter = titleCase(p.source);
  return {
    id: `lsr:${p.product_id || ''}:${time}:${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}:${type}`,
    kind: 'incident',
    category: /WILDFIRE/.test(type) ? 'fire' : 'weather',
    severity: severityOf(type, p.magnitude),
    title: mag ? `${label}: ${mag}` : label,
    summary: [where, reporter ? `reported by ${reporter.toLowerCase()}` : ''].filter(Boolean).join(' · '),
    details: String(p.remark || '').trim(),
    lat: Number(lat),
    lon: Number(lon),
    precision: 'exact',
    place: where,
    time,
    sources: [{ name: `NWS ${p.wfo || ''} storm report (via Iowa Environmental Mesonet)`.replace('  ', ' '), kind: 'official', tier: 'gov', url: PAGE, time }],
    confirmed: [`Logged by the National Weather Service${reporter ? ` from a ${reporter.toLowerCase()} report` : ''}`],
    unconfirmed: /PUBLIC|SOCIAL MEDIA/i.test(p.source || '') ? ['Reported by the public; the weather service has not surveyed it yet'] : [],
  };
}

// The feed has no area filter (it ignores west/south/east/north and
// returns the whole country), so one nationwide copy is shared by every
// viewer and trimmed here. Storms matter beyond a few blocks, so keep
// reports up to 25 miles out.
async function reportsNear(center, radiusMi, hours) {
  const within = Math.max(radiusMi, 25);
  const data = await fetchJson(`${BASE}?hours=${Math.min(hours, 24 * 30)}`, { ttl: 300 });
  return (data.features || []).map(normalize).filter((r) => r && haversineMi(center, r) <= within);
}

module.exports = { reportsNear, normalize };
