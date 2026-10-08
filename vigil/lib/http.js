'use strict';

// Every upstream (NWS, Nominatim) asks callers to identify themselves.
// Set VIGIL_CONTACT to an email or URL before deploying.
const CONTACT = process.env.VIGIL_CONTACT || 'set-VIGIL_CONTACT';
const USER_AGENT = `Vigil/0.1 (${CONTACT})`;

const cache = new Map(); // key -> { expires, value }
const MAX_CACHE = 500;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { cache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key, value, ttlSec) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { expires: Date.now() + ttlSec * 1000, value });
}

async function request(url, { headers = {}, ttl = 60, timeoutMs = 8000, as = 'json' } = {}) {
  const key = `${as}:${url}:${headers.Authorization ? 'auth' : ''}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`${new URL(url).hostname} responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const value = as === 'json' ? await res.json() : await res.text();
  cacheSet(key, value, ttl);
  return value;
}

const fetchJson = (url, opts) => request(url, { ...opts, as: 'json' });
const fetchText = (url, opts) => request(url, { ...opts, as: 'text' });

function sendJson(res, status, body, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (cacheSeconds > 0) {
    // Vercel's CDN serves the cached copy to everyone in the same area for
    // `cacheSeconds`, then refreshes in the background.
    res.setHeader('Cache-Control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 5}`);
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.end(JSON.stringify(body));
}

function queryOf(req) {
  if (req.query) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams);
}

module.exports = { fetchJson, fetchText, sendJson, queryOf, USER_AGENT, _cache: cache };
