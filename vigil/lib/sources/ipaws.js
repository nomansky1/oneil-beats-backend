'use strict';

// Past emergency alerts from FEMA's IPAWS archive (OpenFEMA): AMBER alerts,
// evacuation orders, shelter-in-place, weather warnings and more, back to
// 2012. FEMA publishes each alert 24 hours after it was sent, so this feeds
// the history view (timeframes over 24 hours), never live alerts.
// https://www.fema.gov/openfema-data-page/ipaws-archived-alerts-v1
const { fetchJson } = require('../http');
const { categoryFor } = require('./nws');

const ENDPOINT = 'https://www.fema.gov/api/open/v1/IpawsArchivedAlerts';
const PAGE = 'https://www.fema.gov/openfema-data-page/ipaws-archived-alerts-v1';
const SEVERITY = { Extreme: 3, Severe: 2, Moderate: 1, Minor: 1, Unknown: 1 };

// Ray-casting point-in-polygon on GeoJSON rings ([lon, lat]).
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function covers(geometry, pt) {
  if (!geometry) return null; // unknown: keep the server's answer
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates
    : geometry.type === 'GeometryCollection' ? (geometry.geometries || []).flatMap((g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []))
    : [];
  if (!polys.length) return null;
  return polys.some((rings) => inRing(pt, rings[0]) && !rings.slice(1).some((hole) => inRing(pt, hole)));
}

function normalize(rec, center) {
  const infos = rec.info || rec.infos || [];
  const info = infos.find((i) => /^en/i.test(i.language || 'en')) || infos[0] || {};
  const areas = info.area || info.areas || [];
  const event = info.event || 'Emergency alert';
  return {
    id: `ipaws:${rec.identifier || rec.id}`,
    kind: 'incident',
    category: categoryFor(event),
    severity: SEVERITY[info.severity] || 1,
    title: event,
    summary: info.headline || '',
    details: [info.description, info.instruction].filter(Boolean).join('\n\n').slice(0, 1200),
    lat: center.lat,
    lon: center.lon,
    precision: 'area',
    place: areas.map((a) => a.areaDesc).filter(Boolean).join('; '),
    time: rec.sent,
    sources: [{ name: info.senderName || rec.sender || 'IPAWS', kind: 'official', tier: 'gov', url: PAGE, time: rec.sent }],
    confirmed: [`Sent through the national alert system (IPAWS)${info.senderName ? ` by ${info.senderName}` : ''}`],
    unconfirmed: [],
  };
}

async function pastAlertsNear(center, hours) {
  // The archive lags 24 hours; anything newer is covered by live NWS alerts.
  const from = new Date(Date.now() - hours * 3600e3).toISOString();
  const filter = `sent ge '${from}' and geo.intersects(searchGeometry,geography'POINT(${center.lon} ${center.lat})')`;
  const url = `${ENDPOINT}?$filter=${encodeURIComponent(filter)}&$orderby=sent%20desc&$top=200`;
  const data = await fetchJson(url, { ttl: 3600, timeoutMs: 12000 });
  return (data.IpawsArchivedAlerts || [])
    .filter((r) => r.status === 'Actual' && r.msgType !== 'Cancel')
    .filter((r) => covers(r.searchGeometry, center) !== false) // double-check the point really is inside
    .map((r) => normalize(r, center));
}

module.exports = { pastAlertsNear, normalize, covers };
