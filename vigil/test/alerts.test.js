'use strict';

// Background registry alerts: phone sign-up (/api/push), the 15-minute
// check (lib/watch.js) and its endpoint, with the database and push
// service stubbed and registries answered from fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixture-fetch').install();
const db = require('../lib/alerts-db');
const push = require('../lib/push');
const registry = require('../lib/sources/registry');
const { runWatch, IOWA_PER_RUN } = require('../lib/watch');
const pushApi = require('../api/push');
const watchApi = require('../api/registry-watch');

const ENV = {
  SUPABASE_URL: 'https://fixture.supabase.co',
  SUPABASE_KEY: 'sb_publishable_fixture',
  WATCH_SECRET: 'f'.repeat(64),
  VAPID_PUBLIC_KEY: 'BFixturePublicKey',
  VAPID_PRIVATE_KEY: 'fixture-private',
  VIGIL_CONTACT: 'https://vigil.example',
};
const DES_MOINES = { lat: 41.5868, lon: -93.625 };
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture-a', keys: { p256dh: 'BKey', auth: 'auth' } };

function call(handler, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end: (out) => resolve({ status: res.statusCode, body: JSON.parse(out) }),
    };
    handler({ method, body, headers, query: {}, url: '/' }, res);
  });
}

// Answers Supabase RPCs; everything else goes to the fixtures.
function withRpc(answers) {
  const fixtures = global.fetch;
  const rpcs = [];
  global.fetch = async (url, opts = {}) => {
    const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(String(url));
    if (!m) return fixtures(url, opts);
    const args = JSON.parse(opts.body);
    rpcs.push({ fn: m[1], args, apikey: opts.headers.apikey });
    const out = answers[m[1]];
    return new Response(JSON.stringify(typeof out === 'function' ? out(args) : out ?? null), { status: 200 });
  };
  return { rpcs, restore: () => { global.fetch = fixtures; } };
}

function stub(obj, fns) {
  const saved = Object.fromEntries(Object.keys(fns).map((k) => [k, obj[k]]));
  Object.assign(obj, fns);
  return () => Object.assign(obj, saved);
}

test('/api/push is off until the server has its keys', async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  assert.deepEqual((await call(pushApi)).body, { enabled: false, publicKey: null });
  assert.equal((await call(pushApi, { method: 'POST', body: { subscription: SUB, ...DES_MOINES, radiusMi: 2 } })).status, 503);
});

test('/api/push saves a phone only where a registry is on the map', async () => {
  Object.assign(process.env, ENV);
  const { rpcs, restore } = withRpc({ vigil_subscribe: 'IA:41.59,-93.63,2', vigil_unsubscribe: null });
  try {
    assert.deepEqual((await call(pushApi)).body, { enabled: true, publicKey: ENV.VAPID_PUBLIC_KEY });

    const ok = await call(pushApi, { method: 'POST', body: { subscription: SUB, ...DES_MOINES, radiusMi: 2 } });
    assert.deepEqual(ok.body, { ok: true });
    const save = rpcs.find((r) => r.fn === 'vigil_subscribe');
    assert.equal(save.args.p_state, 'IA');
    assert.equal(save.args.p_secret, ENV.WATCH_SECRET);
    assert.equal(save.args.p_endpoint, SUB.endpoint);
    assert.equal(save.apikey, ENV.SUPABASE_KEY);

    const michigan = await call(pushApi, { method: 'POST', body: { subscription: SUB, lat: 43.23, lon: -86.25, radiusMi: 2 } });
    assert.deepEqual(michigan.body, { ok: false, reason: 'No registry map for this area yet' });
    assert.equal(rpcs.filter((r) => r.fn === 'vigil_subscribe').length, 1, 'nothing stored for Michigan');

    assert.equal((await call(pushApi, { method: 'POST', body: { subscription: SUB, ...DES_MOINES, radiusMi: 50 } })).status, 400);
    assert.equal((await call(pushApi, { method: 'POST', body: { subscription: {}, ...DES_MOINES, radiusMi: 2 } })).status, 400);

    const del = await call(pushApi, { method: 'DELETE', body: { endpoint: SUB.endpoint } });
    assert.deepEqual(del.body, { ok: true });
    assert.equal(rpcs.at(-1).fn, 'vigil_unsubscribe');
  } finally {
    restore();
  }
});

test('the 15-minute check pushes newly listed registrants, without names', async () => {
  Object.assign(process.env, ENV);
  registry._iowaCalls.length = 0;
  const sent = [];
  const dropped = [];
  const undo = [
    stub(db, {
      watchAreas: async () => [
        { area_key: 'IA:41.59,-93.63,2', state: 'IA', lat: 41.59, lon: -93.63, radius_mi: 2, subscribers: 2, baseline: true },
        { area_key: 'MI:43.23,-86.25,2', state: 'MI', lat: 43.23, lon: -86.25, radius_mi: 2, subscribers: 1, baseline: true },
      ],
      watchDiff: async (key, ids) => {
        assert.deepEqual(ids.sort(), ['iowa-sor:90001', 'iowa-sor:90002']);
        return ['iowa-sor:90002'];
      },
      areaSubscribers: async () => [{ endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: 'k', auth: 'a' }, { endpoint: 'https://fcm.googleapis.com/fcm/send/gone', p256dh: 'k', auth: 'a' }],
      unsubscribe: async (endpoint) => { dropped.push(endpoint); },
    }),
    stub(push, { send: async (s, message) => { sent.push({ to: s.endpoint, message }); return { status: /gone/.test(s.endpoint) ? 'gone' : 'sent' }; } }),
  ];
  try {
    const report = await runWatch();
    assert.equal(report.checked, 1);
    assert.equal(report.skipped, 1, 'Michigan has no registry map');
    assert.equal(report.fresh, 1);
    assert.equal(report.sent, 1);
    assert.equal(report.gone, 1);
    assert.deepEqual(dropped, ['https://fcm.googleapis.com/fcm/send/gone'], 'phones that dropped the subscription are forgotten');
    const { message } = sent[0];
    assert.equal(message.title, 'Newly listed near you');
    assert.match(message.body, /within 2 mi on the Iowa Dept\. of Public Safety registry/);
    assert.deepEqual(message.open, { kind: 'reg', id: 'iowa-sor:90002' });
    assert.ok(!/Registrant/.test(JSON.stringify(message)), 'no names in notifications');
  } finally {
    undo.forEach((u) => u());
  }
});

test('a capped registry answer announces no one', async () => {
  Object.assign(process.env, ENV);
  registry._iowaCalls.length = 0;
  const fixtures = global.fetch;
  // A full page of 100, which Iowa doesn't pick by distance.
  global.fetch = async (url, opts) => {
    if (!/iowasexoffender\.gov\/api/.test(String(url))) return fixtures(url, opts);
    const records = Array.from({ length: 100 }, (_, i) => ({ registrant: String(1000 + i), name: `Fixture ${i}`, lat: DES_MOINES.lat + i * 0.00025, lon: DES_MOINES.lon }));
    return new Response(JSON.stringify({ records }), { status: 200 });
  };
  const sent = [];
  const undo = [
    stub(db, {
      watchAreas: async () => [{ area_key: 'IA:x', state: 'IA', lat: DES_MOINES.lat, lon: DES_MOINES.lon, radius_mi: 5, subscribers: 1, baseline: true }],
      watchDiff: async () => ['iowa-sor:1003', 'iowa-sor:1099'],
      areaSubscribers: async () => [{ endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: 'k', auth: 'a' }],
    }),
    stub(push, { send: async (s, message) => { sent.push(message); return { status: 'sent' }; } }),
  ];
  try {
    const report = await runWatch();
    assert.equal(report.checked, 1);
    assert.equal(report.capped, 1);
    assert.equal(report.fresh, 0, 'which of them is new can’t be told from a shifting 100');
    assert.deepEqual(sent, []);
  } finally {
    undo.forEach((u) => u());
    global.fetch = fixtures;
  }
});

test('Iowa is asked about a few areas per check, to stay under its hourly limit', async () => {
  Object.assign(process.env, ENV);
  registry._iowaCalls.length = 0;
  const areas = Array.from({ length: IOWA_PER_RUN + 2 }, (_, i) => ({ area_key: `IA:${i}`, state: 'IA', lat: 41.59, lon: -93.63, radius_mi: 2, subscribers: 1, baseline: true }));
  const undo = stub(db, { watchAreas: async () => areas, watchDiff: async () => [] });
  try {
    const report = await runWatch();
    assert.equal(report.checked, IOWA_PER_RUN);
    assert.equal(report.skipped, 2, 'the rest wait for the next check (least recently checked go first)');
  } finally {
    undo();
  }
});

test('/api/registry-watch needs the shared secret', async () => {
  Object.assign(process.env, ENV);
  assert.equal((await call(watchApi, { headers: {} })).status, 401);
  assert.equal((await call(watchApi, { headers: { 'x-vigil-watch': 'wrong' } })).status, 401);
  const undo = stub(db, { watchAreas: async () => [] });
  try {
    const ok = await call(watchApi, { headers: { 'x-vigil-watch': ENV.WATCH_SECRET } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.areas, 0);
  } finally {
    undo();
  }
});
