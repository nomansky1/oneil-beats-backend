'use strict';

// Builds preview/vigil-preview.html: the whole app in one file, running on
// sample data with a vector basemap, so it can be opened on a phone without
// the server. Usage: npm install && npm run build:preview
const fs = require('fs');
const path = require('path');
const { withVerification } = require('../lib/verify');
const sample = require('../data/sample');
const cities = require('../data/cities');
const xAccounts = require('../data/x-accounts');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const items = sample.items().map(withVerification);

const kinds = [
  ['Police and fire dispatch (sample)', (it) => it.sources.some((s) => /dispatch|police department|public works/.test(s.name))],
  ['Weather service alerts (sample)', (it) => it.sources.some((s) => /Weather service/.test(s.name))],
  ['Earthquake survey (sample)', (it) => it.category === 'quake'],
  ['Local news, clustered (sample)', (it) => it.sources.some((s) => s.kind === 'news')],
  ['X posts in sample reports', (it) => it.sources.some((s) => / on X/.test(s.name))],
  ['Community reports (sample)', (it) => it.sources.some((s) => s.kind === 'community')],
];
const sources = kinds.map(([label, test]) => ({ label, ok: true, count: items.filter(test).length }));

const us = json('node_modules/us-atlas/counties-10m.json');
const world = json('node_modules/world-atlas/countries-110m.json');
// Neighbouring countries only; the US itself comes from the detailed atlas.
world.objects = {
  land: {
    type: 'GeometryCollection',
    geometries: world.objects.countries.geometries.filter((g) => g.id !== '840'),
  },
};

const preview = {
  home: sample.HOME,
  sampleAreas: sample.SAMPLE_AREAS,
  sample: { items, sources },
  cities,
  xAccounts: xAccounts.map(({ handle, name, kind, area }) => ({ handle, name, kind, area })),
  basemap: { us, land: world },
};

const html = read('public/index.html');
const markup = html.slice(html.indexOf('<!-- app:start -->'), html.indexOf('<!-- app:end -->') + '<!-- app:end -->'.length);
const fonts = html.match(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com[^"]+)">/)[1];
const safeJson = JSON.stringify(preview).replace(/</g, '\\u003c');

// The artifact host wraps this in its own <!doctype>/<head>/<body>, so the
// file starts with title and styles rather than a full document.
const out = `<title>Vigil</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>
${read('node_modules/leaflet/dist/leaflet.css')}
${read('public/styles.css')}
</style>
${markup}
<script>window.VIGIL_PREVIEW = ${safeJson};</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>
<script>
${read('public/app.js')}
</script>
`;

fs.mkdirSync(path.join(root, 'preview'), { recursive: true });
const file = path.join(root, 'preview', 'vigil-preview.html');
fs.writeFileSync(file, out);
console.log(`Wrote ${path.relative(process.cwd(), file)} (${(out.length / 1024).toFixed(0)} KB, ${items.length} sample items)`);
