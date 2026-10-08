'use strict';

// Writes public/map-style.json: Vigil's dark street map, drawn by MapLibre
// from OpenFreeMap's free vector tiles (OpenMapTiles schema, OpenStreetMap
// data). Run after editing the colors: node scripts/build-map-style.js
const fs = require('fs');
const path = require('path');

const C = {
  bg: '#0c1218', land: '#10171f', water: '#060a0e', park: '#0f1d1a', building: '#161f2a',
  minor: '#1c2633', secondary: '#253244', primary: '#2f3f53', motorway: '#41546b', rail: '#2a2f38',
  boundary: '#3a4f68', label: '#9aa9ba', labelDim: '#6f7d8d', halo: '#0a0f15', waterLabel: '#3f5d78',
};
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

const roadWidth = (base) => ['interpolate', ['exponential', 1.5], ['zoom'], 6, base * 0.25, 12, base, 18, base * 9];
const roadClass = (...classes) => ['match', ['get', 'class'], classes, true, false];

const style = {
  version: 8,
  name: 'Vigil Night',
  sources: {
    openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
  },
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': C.bg } },
    { id: 'landcover-wood', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover', filter: roadClass('wood', 'grass'), paint: { 'fill-color': C.park, 'fill-opacity': 0.6 } },
    { id: 'park', type: 'fill', source: 'openmaptiles', 'source-layer': 'park', paint: { 'fill-color': C.park, 'fill-opacity': 0.7 } },
    { id: 'landuse', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse', paint: { 'fill-color': C.land } },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': C.water } },
    { id: 'waterway', type: 'line', source: 'openmaptiles', 'source-layer': 'waterway', paint: { 'line-color': C.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 3] } },
    { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': C.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.9] } },
    { id: 'road-minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 12, filter: roadClass('minor', 'service', 'track'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.minor, 'line-width': roadWidth(0.9) } },
    { id: 'road-secondary', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 9, filter: roadClass('secondary', 'tertiary'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.secondary, 'line-width': roadWidth(1.2) } },
    { id: 'road-primary', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 7, filter: roadClass('primary', 'trunk'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.primary, 'line-width': roadWidth(1.5) } },
    { id: 'road-motorway', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 5, filter: roadClass('motorway'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.motorway, 'line-width': roadWidth(1.9) } },
    { id: 'rail', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 11, filter: roadClass('rail', 'transit'), paint: { 'line-color': C.rail, 'line-width': 1, 'line-dasharray': [3, 3] } },
    { id: 'boundary-state', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary', filter: ['<=', ['get', 'admin_level'], 4], paint: { 'line-color': C.boundary, 'line-width': 1, 'line-dasharray': [4, 3] } },
    {
      id: 'road-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', minzoom: 13,
      layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': FONT, 'text-size': 11, 'text-letter-spacing': 0.04 },
      paint: { 'text-color': C.labelDim, 'text-halo-color': C.halo, 'text-halo-width': 1.4 },
    },
    {
      id: 'water-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'water_name', minzoom: 8,
      layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': FONT, 'text-size': 12, 'text-letter-spacing': 0.12 },
      paint: { 'text-color': C.waterLabel, 'text-halo-color': C.halo, 'text-halo-width': 1 },
    },
    {
      id: 'place-minor', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', minzoom: 11,
      filter: roadClass('suburb', 'neighbourhood', 'village', 'hamlet'),
      layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': FONT, 'text-size': 11, 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 },
      paint: { 'text-color': C.labelDim, 'text-halo-color': C.halo, 'text-halo-width': 1.4 },
    },
    {
      id: 'place-city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', minzoom: 4,
      filter: roadClass('city', 'town'),
      layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 12, 15], 'text-transform': 'uppercase', 'text-letter-spacing': 0.06 },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.6 },
    },
  ],
};

const out = path.join(__dirname, '..', 'public', 'map-style.json');
fs.writeFileSync(out, `${JSON.stringify(style, null, 1)}\n`);

// Validate against the official MapLibre style spec when it's installed.
try {
  const { validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');
  const errors = validateStyleMin(style);
  if (errors.length) { console.error(errors.map((e) => e.message).join('\n')); process.exit(1); }
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${style.layers.length} layers, valid)`);
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  console.log(`Wrote ${path.relative(process.cwd(), out)} (validator not installed)`);
}
