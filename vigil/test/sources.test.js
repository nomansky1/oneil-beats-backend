'use strict';

// Source readers against canned upstream responses (test/fixtures).
const test = require('node:test');
const assert = require('node:assert/strict');
const calls = require('./fixture-fetch').install();
const fx = require('./fixtures/upstream');
const citydata = require('../lib/sources/citydata');
const wildfire = require('../lib/sources/wildfire');
const ipaws = require('../lib/sources/ipaws');
const news = require('../lib/sources/news');
const { ogImageFrom } = require('../lib/og-image');

const MUSKEGON = { lat: 43.2342, lon: -86.2484 };
const minsOld = (iso) => (Date.now() - new Date(iso)) / 60000;

test('city police feeds match by state and city or county', () => {
  const ids = (place) => citydata.feedsFor(place).map((f) => f.id);
  assert.deepEqual(ids({ stateName: 'Arizona', city: 'Mesa' }), ['opd-arizona-mesa-calls-for-service', 'opd-arizona-mesa-incidents']);
  assert.deepEqual(ids({ stateName: 'Maryland', city: 'Rockville', county: 'Montgomery County' }), ['opd-maryland-montgomery-county-incidents']);
  assert.deepEqual(ids({ stateName: 'Minnesota', city: 'Saint Paul' }), ['opd-minnesota-st-paul-incidents']);
  assert.deepEqual(ids({ stateName: 'Michigan', city: 'Muskegon', county: 'Muskegon County' }), []);
  assert.deepEqual(ids({ stateName: 'Alabama', city: 'Mesa' }), [], 'state must match too');
  const mesa = citydata.FEEDS.find((f) => f.id === 'opd-arizona-mesa-calls-for-service');
  assert.deepEqual(citydata.feedsFor({ stateName: 'Arizona', city: 'Mesa' }, new Set([mesa.url])).map((f) => f.id), ['opd-arizona-mesa-incidents']);
});

test('Socrata city feed: local times, address and coordinates', async () => {
  const feed = citydata.FEEDS.find((f) => f.id === 'opd-arizona-mesa-calls-for-service');
  const items = await citydata.fetchFeed(feed, { lat: 33.4152, lon: -111.8315 }, 3, 24);
  assert.equal(items.length, 2, 'the row without coordinates is skipped');
  const [shots, check] = items;
  assert.equal(shots.title, 'Shots Fired');
  assert.equal(shots.category, 'crime');
  assert.equal(shots.place, '100 Block W Main St, Mesa');
  assert.equal(shots.precision, 'block');
  assert.equal(shots.sources[0].name, 'Mesa Police Department');
  assert.ok(Math.abs(minsOld(shots.time) - 12) < 1, 'Arizona local time converted to UTC');
  assert.equal(check.title, 'Welfare Check');
  assert.equal(check.summary, '', 'no address column: no guessed address');
  assert.equal(check.lat, 33.42, 'coordinates from a GeoJSON point column');
  const url = decodeURIComponent(calls.find((u) => u.includes('data.mesaaz.gov')));
  assert.match(url, /\$where=received_date_time > '\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d'/, 'floating local time, no Z');
});

test('ArcGIS city feed: GeoJSON points and epoch dates', async () => {
  const feed = citydata.FEEDS.find((f) => f.id === 'opd-arizona-gilbert-calls-for-service');
  const items = await citydata.fetchFeed(feed, { lat: 33.3528, lon: -111.789 }, 3, 24);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'opd-arizona-gilbert-calls-for-service:77');
  assert.equal(items[0].title, 'Traffic Accident Injury');
  assert.equal(items[0].place, '300 N Gilbert Rd, Gilbert');
  assert.ok(Math.abs(minsOld(items[0].time) - 25) < 1);
  const url = decodeURIComponent(calls.find((u) => u.includes('maps.gilbertaz.gov')).replace(/\+/g, ' '));
  assert.match(url, /MapServer\/2\/query\?where=EventDate >= TIMESTAMP '\d{4}-\d\d-\d\d \d\d:\d\d:\d\d'/);
  assert.match(url, /f=geojson/);
});

test('active wildfires from NIFC with size and containment', async () => {
  const fires = await wildfire.firesNear(MUSKEGON, 3);
  assert.equal(fires.length, 2);
  const big = fires.find((f) => f.id === 'nifc:{FIXTURE-1}');
  assert.equal(big.title, 'Fixture Ridge Fire');
  assert.equal(big.summary, '2,350 acres · 15% contained');
  assert.equal(big.severity, 3);
  assert.equal(big.place, 'Newaygo County, MI');
  assert.ok(Math.abs(minsOld(big.time) - 45) < 1, 'sorted by latest update, not discovery');
  const small = fires.find((f) => f.id === 'nifc:{FIXTURE-2}');
  assert.equal(small.title, 'Dune Road Fire');
  assert.equal(small.summary, '0.30 acres · 100% contained');
  assert.equal(small.severity, 1);
  const url = decodeURIComponent(calls.find((u) => u.includes('WFIGS')));
  assert.match(url, /geometryType=esriGeometryEnvelope/);
  assert.match(url, /IncidentTypeCategory = 'WF'|IncidentTypeCategory\+=\+'WF'/);
});

test('satellite heat detections need a key, then group nearby spots', async () => {
  delete process.env.FIRMS_MAP_KEY;
  await assert.rejects(wildfire.heatNear(MUSKEGON, 3), (err) => err.notConfigured === true);
  process.env.FIRMS_MAP_KEY = 'fixture-key';
  try {
    const heat = await wildfire.heatNear(MUSKEGON, 3);
    assert.equal(heat.length, 1, 'low-confidence reading dropped, two close readings grouped');
    assert.equal(heat[0].title, 'Satellite heat detection (2 spots)');
    assert.ok(Math.abs(minsOld(heat[0].time) - 90) < 2);
    assert.ok(calls.some((u) => u.includes('/api/area/csv/fixture-key/VIIRS_SNPP_NRT/')));
  } finally {
    delete process.env.FIRMS_MAP_KEY;
  }
  const modis = (confidence) => wildfire.groupDetections([{ latitude: '40', longitude: '-100', acq_date: '2026-10-01', acq_time: '512', confidence }]);
  assert.equal(modis('40').length, 0, 'MODIS confidence under 50 dropped');
  assert.equal(modis('80')[0].time, '2026-10-01T05:12:00.000Z', 'acq_time 512 is 05:12 UTC');
});

test('past alerts from the FEMA IPAWS archive', async () => {
  const alerts = await ipaws.pastAlertsNear(MUSKEGON, 72);
  assert.deepEqual(alerts.map((a) => a.title), ['Flood Warning', 'Shelter In Place Warning'], 'outside polygon and cancelled alerts dropped');
  const [flood, shelter] = alerts;
  assert.equal(flood.precision, 'area');
  assert.equal(flood.place, 'Muskegon, MI');
  assert.equal(flood.category, 'weather');
  assert.equal(flood.severity, 2);
  assert.equal(shelter.category, 'hazard');
  assert.equal(shelter.sources[0].name, 'Muskegon County Emergency Management', '"infos" spelling read too');
  const url = decodeURIComponent(calls.find((u) => u.includes('IpawsArchivedAlerts')));
  assert.match(url, /geo\.intersects\(searchGeometry,geography'POINT\(-86\.2484 43\.2342\)'\)/, 'lon lat order');
  const square = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
  assert.equal(ipaws.covers(square, { lat: 2, lon: 2 }), true);
  assert.equal(ipaws.covers(square, { lat: 5, lon: 5 }), false, 'inside a hole');
  assert.equal(ipaws.covers(null, { lat: 5, lon: 5 }), null);
});

test('news pictures: share image parsing and fallback', async () => {
  assert.equal(ogImageFrom(fx.articlePage(), 'https://www.example-station.com/news/a'), 'https://www.example-station.com/img/story.jpg?w=1200&h=630', 'og:image wins, relative URL resolved');
  assert.equal(ogImageFrom('<meta property="og:image" content="http://insecure.example/a.jpg">', 'https://x.example/'), '', 'https only');
  assert.equal(ogImageFrom('<meta property="og:image" content="javascript:alert(1)">', 'https://x.example/'), '');
  const stories = [
    { id: 'a', image: null, sources: [{ name: 'Google copy', url: 'https://news.google.com/rss/articles/x' }, { name: 'Example Station', url: 'https://www.example-station.com/news/a' }] },
    { id: 'b', image: null, sources: [{ name: 'Google only', url: 'https://news.google.com/rss/articles/y' }] },
    { id: 'c', image: { url: 'https://kept.example/c.jpg', credit: 'Kept', link: '' }, sources: [] },
  ];
  await news.addImages(stories);
  assert.deepEqual(stories[0].image, { url: 'https://www.example-station.com/img/story.jpg?w=1200&h=630', credit: 'Example Station', link: 'https://www.example-station.com/news/a' });
  assert.equal(stories[1].image, null, 'Google News redirects are not fetched');
  assert.equal(stories[2].image.url, 'https://kept.example/c.jpg');
  assert.ok(!calls.some((u) => u.startsWith('https://news.google.com/rss/articles')));
});

test('storm damage reports from the weather service, with the exact spot', async () => {
  const stormreports = require('../lib/sources/stormreports');
  const reports = await stormreports.reportsNear(MUSKEGON, 3, 24);
  assert.equal(reports.length, 2);
  const [wind, hail] = reports;
  assert.equal(wind.title, 'Thunderstorm wind damage');
  assert.equal(wind.severity, 2);
  assert.equal(wind.category, 'weather');
  assert.equal(wind.place, 'Muskegon, Muskegon County, MI');
  assert.equal(wind.details, 'Large tree down on Fixture St blocking both lanes.');
  assert.match(wind.sources[0].name, /NWS GRR storm report/);
  assert.deepEqual(wind.unconfirmed, []);
  assert.ok(Math.abs(minsOld(wind.time) - 70) < 1);
  assert.equal(hail.title, 'Hail: 1 inch'.replace('1 inch', '1.00 inch'));
  assert.equal(hail.severity, 1);
  assert.equal(hail.unconfirmed.length, 1, 'public reports are flagged as not yet surveyed');
  const url = decodeURIComponent(calls.find((u) => u.includes('lsr.geojson')));
  assert.match(url, /west=-86\.7\d+&south=42\.8\d+&east=-85\.7\d+&north=43\.5\d+&hours=24/, '25-mile box at least');
});

test('Bluesky: government handles are official, others unverified, place must be clear', async () => {
  const bluesky = require('../lib/sources/bluesky');
  const place = { label: 'Muskegon, MI', city: 'Muskegon', county: 'Muskegon', state: 'MI', stateName: 'Michigan' };
  const posts = await bluesky.postsFor(place, MUSKEGON, 24);
  assert.deepEqual(posts.map((p) => p.sources[0].name), ['@police.muskegon-mi.gov on Bluesky', '@someone.bsky.social on Bluesky'], 'non-safety and unclear-place posts dropped');
  const [gov, user] = posts;
  assert.equal(gov.sources[0].kind, 'official');
  assert.equal(gov.sources[0].url, 'https://bsky.app/profile/police.muskegon-mi.gov/post/3kfix1');
  assert.equal(user.sources[0].kind, 'social');
  assert.equal(user.category, 'fire');
  assert.equal(bluesky.isGov('nws.noaa.gov'), true);
  assert.equal(bluesky.isGov('gov.bsky.social'), false);
  assert.equal(bluesky.mentionsPlace('Crash in Springfield', { city: 'Springfield', state: 'IL', stateName: 'Illinois' }), false);
  assert.equal(bluesky.mentionsPlace('Crash in Springfield, IL tonight', { city: 'Springfield', state: 'IL', stateName: 'Illinois' }), true);
  const url = decodeURIComponent(calls.find((u) => u.includes('searchPosts')));
  assert.match(url, /q="Muskegon"&sort=latest&limit=100&since=/);
});
