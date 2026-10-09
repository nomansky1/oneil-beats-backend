'use strict';

// Builds Vigil's map styles from OpenFreeMap's open styles (copies and
// licenses in scripts/map-styles/). All draw OpenFreeMap's free vector tiles
// (OpenMapTiles schema, OpenStreetMap data):
//   public/map-style.json            Night: the dark street map, recolored
//                                    so every street and name is readable,
//                                    with police/fire/hospital/school
//                                    icons, all other places, house numbers
//                                    and highway shields.
//   public/map-style-satellite.json  Satellite: U.S. government aerial
//                                    imagery (USGS, public domain) with
//                                    street names on top.
// The light "Streets" map is OpenFreeMap's Liberty style, used as hosted.
// Run after editing: npm run build:style
const fs = require('fs');
const path = require('path');
const { validateStyleMin } = require('@maplibre/maplibre-gl-style-spec');

const root = path.join(__dirname, '..');
const DOMAIN = 'tiles.openfreemap.org';
const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'map-styles', `${name}.json`), 'utf8').replaceAll('__TILEJSON_DOMAIN__', DOMAIN));
const dark = load('dark');
const liberty = load('liberty');
const layer = (style, id) => JSON.parse(JSON.stringify(style.layers.find((l) => l.id === id)));

// Places that matter in an emergency get icons from street level up; the
// rest of the places (shops, parks, churches...) appear as you zoom in.
const SAFETY = ['police', 'fire_station', 'hospital', 'school', 'college'];
const notSafety = ['!', ['match', ['get', 'class'], SAFETY, true, false]];
const name = ['coalesce', ['get', 'name_en'], ['get', 'name']];
const C = {
  bg: '#0b1016', water: '#0c1a26', park: '#122019', residential: '#10161d', building: '#161d25', buildingLine: '#222b36',
  minor: '#263140', path: '#2b3644', majorCase: '#4a5a6e', majorInner: '#2f3c4d', motorwayCase: '#5d6f85', motorwayInner: '#3d4c60',
  street: '#a9b4c1', motorwayLabel: '#c6cfd9', place: '#cdd5de', suburb: '#8f9aa7', poi: '#9eb0c2', safety: '#ffd38a', halo: '#070b10',
};

function night() {
  const s = JSON.parse(JSON.stringify(dark));
  s.name = 'Vigil Night';
  s.metadata = { 'vigil:source': 'OpenFreeMap Dark (dark-matter-gl-style, BSD-3 / design CC-BY 3.0 CARTO) + OSM Liberty POI and shield layers (BSD-3)' };
  const paint = (id, p) => { const l = s.layers.find((x) => x.id === id); if (l) Object.assign(l.paint || (l.paint = {}), p); };
  // Readable on a phone: lift roads, water and labels off the black.
  paint('background', { 'background-color': C.bg });
  paint('water', { 'fill-color': C.water });
  paint('landuse_residential', { 'fill-color': C.residential, 'fill-opacity': 0.6 });
  paint('landuse_park', { 'fill-color': C.park });
  paint('landcover_wood', { 'fill-color': C.park, 'fill-opacity': 0.5 });
  paint('building', { 'fill-color': C.building, 'fill-outline-color': C.buildingLine });
  paint('highway_path', { 'line-color': C.path });
  paint('highway_minor', { 'line-color': C.minor, 'line-opacity': 1 });
  paint('highway_major_casing', { 'line-color': C.majorCase });
  paint('highway_major_inner', { 'line-color': C.majorInner });
  paint('highway_major_subtle', { 'line-color': C.majorInner });
  paint('highway_motorway_casing', { 'line-color': C.motorwayCase });
  paint('highway_motorway_inner', { 'line-color': ['interpolate', ['linear'], ['zoom'], 5.8, 'hsla(0,0%,85%,0.53)', 6, C.motorwayInner] });
  paint('highway_motorway_subtle', { 'line-color': C.motorwayInner });
  paint('highway_name_other', { 'text-color': C.street, 'text-halo-color': C.halo, 'text-halo-width': 1.4 });
  paint('highway_name_motorway', { 'text-color': C.motorwayLabel });
  for (const id of ['place_other', 'place_suburb']) paint(id, { 'text-color': C.suburb, 'text-halo-color': C.halo });
  for (const id of ['place_village', 'place_town', 'place_city', 'place_city_large', 'place_state']) paint(id, { 'text-color': C.place, 'text-halo-color': C.halo });
  paint('water_name', { 'text-color': '#5f7f9c', 'text-halo-color': C.halo });

  const extra = [
    // House numbers when zoomed all the way in.
    { id: 'housenumber', type: 'symbol', source: 'openmaptiles', 'source-layer': 'housenumber', minzoom: 17, layout: { 'text-field': ['get', 'housenumber'], 'text-font': ['Noto Sans Regular'], 'text-size': 10 }, paint: { 'text-color': '#6f7c8a', 'text-halo-color': C.halo, 'text-halo-width': 1 } },
    // Everyday places from Liberty, recolored for the dark map.
    ...['poi_r20', 'poi_r7', 'poi_r1'].map((id) => {
      const l = layer(liberty, id);
      l.filter = ['all', l.filter, notSafety];
      Object.assign(l.paint, { 'text-color': C.poi, 'text-halo-color': C.halo, 'text-halo-width': 1.2 });
      return l;
    }),
    Object.assign(layer(liberty, 'poi_transit'), { paint: { 'text-color': '#8fb4d8', 'text-halo-color': C.halo, 'text-halo-width': 1.2 } }),
    // Police, fire, hospitals, schools: visible from neighborhood zoom.
    {
      id: 'poi_safety', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 13,
      filter: ['match', ['get', 'class'], SAFETY, true, false],
      layout: { 'icon-image': ['get', 'class'], 'icon-size': 1.1, 'text-field': ['step', ['zoom'], '', 14, name], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5, 'text-anchor': 'top', 'text-offset': [0, 0.8], 'text-max-width': 9, 'text-optional': true },
      paint: { 'text-color': C.safety, 'text-halo-color': C.halo, 'text-halo-width': 1.4 },
    },
    // Highway shields (US interstate, US and state routes).
    layer(liberty, 'road_shield_us'),
    layer(liberty, 'highway-shield-us-interstate'),
    layer(liberty, 'highway-shield-non-us'),
  ];
  const firstPlace = s.layers.findIndex((l) => l.id.startsWith('place_'));
  s.layers.splice(firstPlace, 0, ...extra);
  return s;
}

function satellite() {
  const labels = night();
  const keep = new Set(['boundary_state', 'highway_name_other', 'highway_name_motorway', 'water_name', 'housenumber', 'poi_safety', 'road_shield_us', 'highway-shield-us-interstate', 'highway-shield-non-us', 'place_other', 'place_suburb', 'place_village', 'place_town', 'place_city', 'place_city_large', 'place_state']);
  const layers = labels.layers.filter((l) => keep.has(l.id)).map((l) => {
    if (l.type === 'symbol' && l.paint && 'text-color' in l.paint && !/shield/.test(l.id) && l.id !== 'poi_safety') Object.assign(l.paint, { 'text-color': '#f4f6f8', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.6 });
    return l;
  });
  return {
    version: 8,
    name: 'Vigil Satellite',
    metadata: { 'vigil:source': 'USGS The National Map orthoimagery (public domain) + OpenFreeMap labels' },
    sprite: labels.sprite,
    glyphs: labels.glyphs,
    sources: {
      usgs: { type: 'raster', tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 16, attribution: 'USGS The National Map' },
      openmaptiles: labels.sources.openmaptiles,
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0b1016' } },
      { id: 'imagery', type: 'raster', source: 'usgs' },
      ...layers,
    ],
  };
}

for (const [file, style] of [['map-style.json', night()], ['map-style-satellite.json', satellite()]]) {
  const errors = validateStyleMin(style);
  if (errors.length) {
    console.error(`${file} is invalid:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(root, 'public', file), `${JSON.stringify(style)}\n`);
  console.log(`Wrote public/${file} (${style.layers.length} layers, valid)`);
}
