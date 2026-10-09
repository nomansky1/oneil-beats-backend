'use strict';

// Automated license plate readers (Flock Safety and other vendors), as mapped
// by volunteers on OpenStreetMap (the same data DeFlock shows). Read through
// the Overpass API: no key, data © OpenStreetMap contributors under the
// ODbL, so every view must credit OpenStreetMap. Camera positions change
// slowly, so results are cached for 6 hours per ~5 km cell to stay well
// inside the public Overpass usage policy.
// Tagging: https://wiki.openstreetmap.org/wiki/Tag:surveillance:type%3DALPR
const { fetchJson } = require('../http');

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

function bboxAround({ lat, lon }, radiusMi) {
  const dLat = radiusMi / 69.0;
  const dLon = radiusMi / (69.17 * Math.cos((lat * Math.PI) / 180));
  const r = (n) => Math.round(n * 20) / 20; // snap to 0.05° so nearby viewers share a cache entry
  return [r(lat - dLat), r(lon - dLon), r(lat + dLat), r(lon + dLon)];
}

function queryFor(bbox) {
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:25];node["surveillance:type"="ALPR"](${s},${w},${n},${e});out body 1500;`;
}

const CARDINAL = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

function directionOf(tags) {
  const first = String(tags['camera:direction'] || tags.direction || '').split(/[;,]/)[0].trim().toUpperCase();
  if (!first) return null;
  if (first in CARDINAL) return CARDINAL[first];
  const deg = Number(first);
  return Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : null;
}

function normalize(el) {
  const t = el.tags || {};
  return {
    id: `osm:node/${el.id}`,
    kind: 'camera',
    lat: el.lat,
    lon: el.lon,
    manufacturer: t.manufacturer || t.brand || '',
    operator: t.operator || '',
    model: t.model || '',
    direction: directionOf(t),
    zone: t['surveillance:zone'] || '',
    mappedBy: 'OpenStreetMap contributors',
    url: `https://www.openstreetmap.org/node/${el.id}`,
  };
}

async function camerasNear(center, radiusMi) {
  const bbox = bboxAround(center, Math.min(Math.max(radiusMi, 1), 10));
  const url = `${OVERPASS_URL}?data=${encodeURIComponent(queryFor(bbox))}`;
  // Overpass is often busy; give up well inside the feed's 15-second limit.
  const data = await fetchJson(url, { ttl: 6 * 3600, timeoutMs: 9000 });
  return (data.elements || []).filter((el) => el.type === 'node' && Number.isFinite(el.lat)).map(normalize);
}

module.exports = { camerasNear, normalize, queryFor, bboxAround, directionOf };
