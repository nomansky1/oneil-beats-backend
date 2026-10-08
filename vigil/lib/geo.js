'use strict';

const EARTH_RADIUS_MI = 3958.8;
const toRad = (d) => (d * Math.PI) / 180;

function haversineMi(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Centroid of a GeoJSON Polygon / MultiPolygon (vertex average — good enough
// for placing a pin on an alert area).
function centroid(geometry) {
  if (!geometry) return null;
  let rings = [];
  if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
  else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map((p) => p[0]);
  else if (geometry.type === 'Point') return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
  let x = 0, y = 0, n = 0;
  for (const ring of rings) for (const [lon, lat] of ring) { x += lon; y += lat; n++; }
  return n ? { lon: x / n, lat: y / n } : null;
}

function parseLatLon(query) {
  const lat = Number(query.lat);
  const lon = Number(query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

module.exports = { haversineMi, centroid, parseLatLon, EARTH_RADIUS_MI };
