'use strict';

// Sex offender registry readers and /api/registry, against invented
// fixture records (test/fixtures/upstream.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const calls = require('./fixture-fetch').install();
const registry = require('../lib/sources/registry');
const handler = require('../api/registry');

const DES_MOINES = { lat: 41.5868, lon: -93.625 };

function run(query) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (body) => resolve({ status: res.statusCode, headers, body: JSON.parse(body) }),
    };
    handler({ query, url: '/' }, res);
  });
}

test('Iowa: names, photos, offenses and a link to the official record', async () => {
  const { coverage, registrants } = await registry.registrantsNear('IA', DES_MOINES, 2);
  assert.equal(coverage, 'map');
  assert.deepEqual(registrants.map((r) => r.id), ['iowa-sor:90001', 'iowa-sor:90002'], 'the one 60 miles away is left out');
  const [a, b] = registrants;
  assert.equal(a.name, 'Test Registrant A');
  assert.equal(a.photo, 'https://www.iowasexoffender.gov/images/photos/90001.jpg');
  assert.equal(a.address, '100 Example St, Des Moines, IA');
  assert.deepEqual(a.offenses, ['Fixture offense one', 'Fixture offense two']);
  assert.equal(a.level, 'Tier II');
  assert.equal(a.recordUrl, 'https://www.iowasexoffender.gov/registrant/90001');
  assert.equal(a.precision, 'address');
  assert.equal(b.name, 'Test Registrant B');
  assert.equal(b.photo, '', 'non-https photo dropped');
  const url = calls.find((u) => u.includes('iowasexoffender.gov'));
  assert.match(url, /results\.json\?lat=41\.5868&lon=-93\.625&range=2&per_page=100&page=1/);
});

test('Iowa: coordinates are never cached, and the hourly limit is respected', async () => {
  registry._iowaCalls.length = 0;
  const before = calls.filter((u) => u.includes('iowasexoffender.gov')).length;
  await registry.registrantsNear('IA', DES_MOINES, 2);
  await registry.registrantsNear('IA', DES_MOINES, 2);
  assert.equal(calls.filter((u) => u.includes('iowasexoffender.gov')).length - before, 2, 'each request asks Iowa again');
  registry._iowaCalls.length = 0;
  const now = Date.now();
  for (let i = 0; i < 45; i++) assert.equal(registry.iowaAllowed(now), true);
  assert.equal(registry.iowaAllowed(now), false, '46th call in an hour is refused');
  assert.equal(registry.iowaAllowed(now + 3600e3 + 1), true, 'allowed again an hour later');
  registry._iowaCalls.length = 0;
});

test('Tennessee and DC map layers', async () => {
  const tn = await registry.registrantsNear('TN', { lat: 36.1627, lon: -86.7816 }, 2);
  assert.equal(tn.registrants.length, 1);
  assert.equal(tn.registrants[0].name, 'Test Registrant C');
  assert.equal(tn.registrants[0].recordUrl, 'https://tnmap.tn.gov/sor/?TID=00900001');
  assert.equal(tn.registrants[0].photo, '', 'the map layer has no photos');
  assert.equal(tn.registrants[0].address, '200 Fixture Ave, Nashville, TN');
  assert.deepEqual(tn.registrants[0].offenses, ['Fixture offense three'], 'offense text without its date; the offense date alone is not an offense');
  assert.equal(tn.registrants[0].level, 'SEXUAL');
  const tnUrl = decodeURIComponent(calls.find((u) => u.includes('TBI_SEX_OFFENDER_REGISTRY')));
  assert.match(tnUrl, /outSR=4326/);
  assert.match(tnUrl, /f=geojson/);

  const dc = await registry.registrantsNear('DC', { lat: 38.9, lon: -77.03 }, 2);
  assert.equal(dc.registrants.length, 2);
  const [r, work] = dc.registrants;
  assert.equal(r.name, 'Test Registrant D');
  assert.equal(r.precision, 'block');
  assert.equal(r.address, '1200 BLOCK OF FIXTURE ST NW');
  assert.equal(r.level, 'Class A', 'MAXCLASSIFICATION, not the registrant code');
  assert.deepEqual(r.offenses, [], 'DC publishes no offenses; its SEXOFFENDERCODE is an ID');
  assert.equal(work.address, 'Work: 1300 BLOCK OF FIXTURE ST NW');
});

test('states without an app-friendly registry get a link only', async () => {
  const mi = await registry.registrantsNear('MI', { lat: 43.23, lon: -86.25 }, 2);
  assert.deepEqual(mi, { coverage: 'link', registrants: [], source: null });
});

test('GET /api/registry: records, official link, warning, never cached', async () => {
  registry._iowaCalls.length = 0;
  const ia = await run({ lat: '41.5868', lon: '-93.625', radius_mi: '2' });
  assert.equal(ia.status, 200);
  assert.equal(ia.headers['cache-control'], 'no-store', 'Iowa forbids caching coordinates');
  assert.equal(ia.body.coverage, 'map');
  assert.equal(ia.body.registrants.length, 2);
  assert.equal(ia.body.official.url, 'https://www.iowasexoffender.gov/');
  assert.match(ia.body.warning, /must not be used to threaten, harass/);
  assert.equal(ia.body.sources[0].ok, true);

  const mi = await run({ lat: '43.2342', lon: '-86.2484', radius_mi: '2' });
  assert.equal(mi.body.coverage, 'link');
  assert.deepEqual(mi.body.registrants, []);
  assert.equal(mi.body.official.name, 'Michigan');

  const bad = await run({});
  assert.equal(bad.status, 400);
});
