'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('../lib/verify');
const { classify } = require('../lib/classify');
const { clusterArticles } = require('../lib/cluster');
const { parseRss } = require('../lib/rss');
const { zonedToUtc, utcToFloating } = require('../lib/time');
const { tierFor } = require('../lib/outlets');
const nws = require('../lib/sources/nws');
const opendata = require('../lib/sources/opendata');
const x = require('../lib/sources/x');
const news = require('../lib/sources/news');
const fx = require('./fixtures/upstream');

test('verification levels follow the sources', () => {
  assert.equal(verify({ sources: [{ kind: 'official', name: 'NWS' }] }).level, 4);
  assert.equal(verify({ sources: [{ kind: 'news', tier: 'established', name: 'A' }, { kind: 'news', tier: 'established', name: 'B' }] }).level, 3);
  assert.equal(verify({ sources: [{ kind: 'news', tier: 'unrated', name: 'A' }, { kind: 'news', tier: 'unrated', name: 'B' }, { kind: 'news', tier: 'unrated', name: 'C' }] }).level, 3);
  assert.equal(verify({ sources: [{ kind: 'news', tier: 'established', name: 'A' }, { kind: 'news', tier: 'established', name: 'A' }] }).level, 2, 'same outlet twice is one source');
  assert.equal(verify({ sources: [{ kind: 'social', name: '@someone' }] }).level, 1);
  assert.equal(verify({ sources: [] }).level, 1);
});

test('classify sorts headlines and skips false fire matches', () => {
  assert.deepEqual(classify('Two people shot near park'), { category: 'crime', severity: 3 });
  assert.equal(classify('House fire displaces family').category, 'fire');
  assert.equal(classify('Coach fired after losing season'), null);
  assert.equal(classify('Crash closes I-96 lanes').category, 'traffic');
  assert.equal(classify('AMBER Alert issued for 4-year-old').category, 'missing');
  assert.equal(classify('City approves park budget'), null);
});

test('clusters headlines about the same event', () => {
  const groups = clusterArticles([
    { title: 'Man hospitalized after overnight stabbing in Muskegon', published: '2026-10-08T01:00:00Z' },
    { title: 'Muskegon police investigate overnight stabbing; man hospitalized', published: '2026-10-08T01:30:00Z' },
    { title: 'Crash closes US-31 ramp near Norton Shores', published: '2026-10-08T02:00:00Z' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 2);
});

test('RSS parser handles CDATA, entities and source tags', () => {
  const items = parseRss(fx.googleNews());
  assert.equal(items.length, 4);
  assert.equal(items[2].title, 'Crash closes US-31 ramp near Muskegon & Norton Shores - WOOD TV8');
  assert.equal(items[0].sourceUrl, 'https://www.mlive.com');
  assert.ok(!Number.isNaN(new Date(items[0].published).getTime()));
});

test('floating local timestamps convert to UTC and back', () => {
  assert.equal(zonedToUtc('2026-07-01T12:00:00.000', 'America/Los_Angeles'), '2026-07-01T19:00:00.000Z');
  assert.equal(zonedToUtc('2026-01-15T12:00:00', 'America/New_York'), '2026-01-15T17:00:00.000Z');
  assert.equal(utcToFloating(new Date('2026-07-01T19:00:00Z'), 'America/Los_Angeles'), '2026-07-01T12:00:00');
});

test('outlet tiers', () => {
  assert.equal(tierFor('https://www.wzzm13.com/article/x'), 'established');
  assert.equal(tierFor('https://www.mlive.com/news'), 'established');
  assert.equal(tierFor('https://www.woodtv.com/news'), 'established');
  assert.equal(tierFor('https://www.muskegon-mi.gov/news'), 'gov');
  assert.equal(tierFor('https://example-blog.net/post'), 'unrated');
});

test('NWS relays non-weather emergencies with the right category', () => {
  const [storm, amber] = fx.nwsAlerts().features.map((f) => nws.normalize(f, { lat: 43.23, lon: -86.25 }));
  assert.equal(storm.category, 'weather');
  assert.equal(storm.severity, 2);
  assert.equal(amber.category, 'missing');
  assert.equal(amber.severity, 3);
  assert.equal(amber.lat, 43.23, 'falls back to the query point when there is no polygon');
});

test('city dispatch rows become block-level official items', () => {
  const feed = opendata.FEEDS.find((f) => f.id === 'seattle-fire-911');
  const it = opendata.normalize(feed, { address: '3rd Ave / Pine St', type: 'Aid Response', datetime: '2026-07-01T12:00:00.000', latitude: '47.61', longitude: '-122.33', incident_number: 'F1' });
  assert.equal(it.category, 'medical');
  assert.equal(it.precision, 'block');
  assert.equal(it.time, '2026-07-01T19:00:00.000Z');
  assert.equal(it.sources[0].kind, 'official');
  assert.equal(opendata.normalize(feed, { type: 'Aid Response', latitude: '0', longitude: '0' }), null);
  assert.equal(opendata.feedsFor({ lat: 47.6, lon: -122.33 }).length, 1);
  assert.equal(opendata.feedsFor({ lat: 43.23, lon: -86.25 }).length, 0);
});

test('X posts: government accounts are official, others unverified', () => {
  const place = { label: 'Muskegon, MI' };
  const c = { lat: 43.23, lon: -86.25 };
  const gov = x.normalize({ id: '1', text: 'Road closed after crash on Seaway Dr https://t.co/abc', created_at: '2026-10-08T10:00:00Z' }, { name: 'Muskegon Police', username: 'MuskegonPD', verified_type: 'government' }, place, c);
  const anon = x.normalize({ id: '2', text: 'Heard shots fired downtown??', created_at: '2026-10-08T10:00:00Z' }, { name: 'Someone', username: 'someone', verified_type: 'blue' }, place, c);
  assert.equal(verify(gov).level, 4);
  assert.equal(gov.title, 'Road closed after crash on Seaway Dr');
  assert.equal(verify(anon).level, 1);
  assert.equal(anon.sources[0].url, 'https://x.com/someone/status/2');
});

test('news stories cluster across indexes and drop non-safety items', () => {
  const place = { label: 'Muskegon, MI', city: 'Muskegon', state: 'MI' };
  const articles = parseRss(fx.googleNews()).map((it) => ({ title: news.splitGoogleTitle(it.title, it.sourceName), url: it.link, outletUrl: it.sourceUrl, outlet: it.sourceName, published: it.published }))
    .concat(fx.gdeltDoc().articles.map((a) => ({ title: a.title, url: a.url, outletUrl: `https://${a.domain}`, outlet: a.domain, published: news.gdeltDate(a.seendate) })));
  const stories = news.toStories(articles, place, { lat: 43.23, lon: -86.25 });
  assert.equal(stories.length, 2, 'stabbing + crash; park budget dropped');
  const stabbing = stories.find((s) => /stabb/i.test(s.title));
  assert.equal(stabbing.sources.length, 3);
  assert.equal(stabbing.verification.level, 3);
  assert.equal(stabbing.precision, 'city');
});
