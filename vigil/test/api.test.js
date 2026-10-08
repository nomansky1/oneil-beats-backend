'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calls = require('./fixture-fetch').install();
const feedHandler = require('../api/feed');
const geocodeHandler = require('../api/geocode');
const nationalHandler = require('../api/national');

function run(handler, query) {
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

test('GET /api/feed merges every source and reports their health', async () => {
  const { status, headers, body } = await run(feedHandler, { lat: '43.2342', lon: '-86.2484', radius_mi: '3', hours: '24' });
  assert.equal(status, 200);
  assert.match(headers['cache-control'], /s-maxage=60/);
  assert.deepEqual(body.center, { lat: 43.23, lon: -86.25 }, 'rounded so nearby viewers share a cache entry');
  assert.equal(body.place.label, 'Muskegon, MI');

  const titles = body.area.map((a) => a.title);
  assert.ok(titles.includes('Severe Thunderstorm Warning'));
  assert.ok(titles.includes('Child Abduction Emergency'));
  assert.equal(body.area.filter((a) => a.id.startsWith('fema:')).length, 1, 'one declaration, deduped, county-matched');

  const stabbing = body.items.find((i) => /stabb/i.test(i.title));
  assert.equal(stabbing.verification.level, 3);
  assert.deepEqual(stabbing.image, { url: 'https://fox17online.com/img/fixture-stabbing.jpg', credit: 'fox17online.com', link: 'https://fox17online.com/news/fixture-stabbing' }, 'article picture from GDELT');
  assert.ok(body.items.some((i) => i.id === 'nifc:{FIXTURE-1}'), 'active wildfires within 50 miles');
  assert.ok(!body.items.some((i) => i.id.startsWith('ipaws:')), 'the 24-hour view uses live NWS alerts only');
  assert.ok(body.items.some((i) => i.category === 'quake'), 'quakes use a wider radius');
  assert.ok(body.items.every((i) => i.verification && i.sources.length));

  assert.equal(body.xAccounts[0].handle, 'NWSGrandRapids', 'free official X accounts for the area');
  assert.deepEqual(body.cameras.map((c) => c.id), ['osm:node/1001', 'osm:node/1002'], 'cameras inside the radius only');
  assert.deepEqual(body.registry, { state: 'MI', name: 'Michigan', url: 'https://mspsor.com/', agency: 'Michigan State Police' }, 'official state registry link');
  assert.ok(!body.items.some((i) => i.id.startsWith('osm:')), 'cameras never enter the incident feed');
  const health = Object.fromEntries(body.sources.map((s) => [s.id, s]));
  for (const id of ['place', 'nws', 'usgs', 'fema', 'news', 'wildfire', 'alpr']) assert.equal(health[id].ok, true, id);
  for (const id of ['x', 'firms']) {
    assert.equal(health[id].ok, false, id);
    assert.equal(health[id].notConfigured, true, id);
  }
  assert.ok(!calls.some((u) => u.includes('api.x.com')), 'no paid X calls without a token');
});

test('GET /api/feed adds archived FEMA alerts for longer timeframes', async () => {
  const { body } = await run(feedHandler, { lat: '43.2342', lon: '-86.2484', radius_mi: '3', hours: '72' });
  const past = body.items.filter((i) => i.id.startsWith('ipaws:'));
  assert.deepEqual(past.map((i) => i.title), ['Flood Warning', 'Shelter In Place Warning']);
  assert.ok(past.every((i) => i.precision === 'area'));
  assert.equal(body.sources.find((s) => s.id === 'ipaws').ok, true);
});

test('GET /api/feed rejects a missing location', async () => {
  const { status, body } = await run(feedHandler, {});
  assert.equal(status, 400);
  assert.match(body.error, /lat and lon/);
});

test('GET /api/geocode searches states and territories', async () => {
  const { status, body } = await run(geocodeHandler, { q: 'san' });
  assert.equal(status, 200);
  assert.deepEqual(body.results.map((r) => r.label), ['Muskegon, MI', 'San Juan, PR']);
});

test('GET /api/national returns ranked items', async () => {
  const { status, body } = await run(nationalHandler, {});
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length > 0);
  assert.ok(body.items.some((i) => i.id === 'nifc:{FIXTURE-1}'), 'large wildfires nationwide');
});
