'use strict';

// Swaps global fetch for one that answers from test/fixtures/upstream.js.
const { ROUTES } = require('./fixtures/upstream');

function install() {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const hit = ROUTES.find(([re]) => re.test(String(url)));
    if (!hit) return new Response('not in fixtures', { status: 503 });
    const body = hit[1](String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
  return calls;
}

module.exports = { install };
