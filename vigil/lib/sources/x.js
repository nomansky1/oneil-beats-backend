'use strict';

// Posts on X. Police, fire and NWS offices often post before anyone else,
// so X is the fastest signal we have — and the least reliable. Rules:
//   - Accounts X marks as government-verified (grey check) count as official.
//   - Every other post is "Unverified" until an official feed or 2+
//     established outlets confirm it. Unverified posts are hidden when the
//     viewer turns on "Verified only".
//
// X's API is paid per post read (about $0.005 per post as of 2026), so this
// source is off unless X_BEARER_TOKEN is set, and results are cached per
// city for X_CACHE_SECONDS (default 120) to keep the bill predictable.
const { fetchJson } = require('../http');
const { classify } = require('../classify');

const TERMS = '(police OR sheriff OR "fire department" OR shooting OR crash OR evacuation OR "shelter in place" OR missing OR "road closed")';

function configured() {
  return Boolean(process.env.X_BEARER_TOKEN);
}

function normalize(post, author, place, center) {
  const cls = classify(post.text) || { category: 'community', severity: 1 };
  const official = author && author.verified_type === 'government';
  const name = author ? `${author.name} (@${author.username})` : 'X post';
  const url = author ? `https://x.com/${author.username}/status/${post.id}` : `https://x.com/i/web/status/${post.id}`;
  const text = post.text.replace(/https:\/\/t\.co\/\S+/g, '').trim();
  return {
    id: `x:${post.id}`,
    kind: 'story',
    category: cls.category,
    severity: cls.severity,
    title: text.length > 140 ? `${text.slice(0, 137)}…` : text,
    summary: official ? `Posted by ${name}, a government account` : `Posted on X by ${name}`,
    details: text,
    lat: center.lat,
    lon: center.lon,
    precision: 'city',
    place: place.label,
    time: post.created_at,
    sources: [{
      name: author ? `@${author.username} on X` : 'X',
      kind: official ? 'official' : 'social',
      tier: official ? 'gov' : 'unrated',
      url,
      time: post.created_at,
    }],
    confirmed: official ? [`${name} posted this`] : [],
    unconfirmed: official ? [] : ['Posted by an account X has not verified as a government agency'],
  };
}

async function postsFor(place, center) {
  if (!configured()) {
    const err = new Error('Add X_BEARER_TOKEN to enable');
    err.notConfigured = true;
    throw err;
  }
  if (!place.city) return [];
  const query = encodeURIComponent(`"${place.city}" ${TERMS} -is:retweet -is:reply`);
  const url = `https://api.x.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=created_at,lang&expansions=author_id&user.fields=name,username,verified,verified_type`;
  const ttl = Number(process.env.X_CACHE_SECONDS) || 120;
  const data = await fetchJson(url, { headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }, ttl });
  const users = new Map(((data.includes || {}).users || []).map((u) => [u.id, u]));
  return (data.data || [])
    .filter((p) => classify(p.text))
    .map((p) => normalize(p, users.get(p.author_id), place, center));
}

module.exports = { postsFor, normalize, configured };
