'use strict';

// Public posts on Bluesky, the open social network (AT Protocol). Free, no
// account or key. Police, fire, weather offices and local newsrooms post
// there. Rules match X:
//   - Bluesky handles are web addresses the owner has proved they control,
//     so a handle ending in .gov or .mil is a government agency: Official.
//   - Every other post is Unverified until official data or 2+ established
//     outlets confirm it.
// Only the text and a link are shown; posts are never stored, so a deleted
// post drops out within minutes. https://docs.bsky.app/
const { fetchJson } = require('../http');
const { classify } = require('../classify');

const SEARCH = 'https://api.bsky.app/xrpc/app.bsky.feed.searchPosts';

const isGov = (handle) => /\.(gov|mil)$/i.test(handle || '');

// A city name alone is ambiguous (there are 20+ Springfields), so a post
// must also name the state, its abbreviation or the county.
function mentionsPlace(text, place) {
  const t = ` ${String(text || '').toLowerCase()} `;
  if (!place.city || !t.includes(place.city.toLowerCase())) return false;
  const hints = [place.stateName, place.county && `${place.county} county`].filter(Boolean).map((s) => s.toLowerCase());
  if (hints.some((h) => t.includes(h))) return true;
  return place.state ? new RegExp(`[\\s,(]${place.state}[\\s.,)!?]`, 'i').test(t) : false;
}

function normalize(post, place, center) {
  const author = post.author || {};
  const text = String((post.record && post.record.text) || '').trim();
  const official = isGov(author.handle);
  const cls = classify(text) || { category: 'community', severity: 1 };
  const rkey = String(post.uri || '').split('/').pop();
  const url = `https://bsky.app/profile/${author.handle || author.did}/post/${rkey}`;
  const name = author.displayName ? `${author.displayName} (@${author.handle})` : `@${author.handle}`;
  const time = (post.record && post.record.createdAt) || post.indexedAt;
  return {
    id: `bsky:${post.uri}`,
    kind: 'story',
    category: cls.category,
    severity: cls.severity,
    title: text.length > 140 ? `${text.slice(0, 137)}…` : text,
    summary: official ? `Posted by ${name}, a government account` : `Posted on Bluesky by ${name}`,
    details: text,
    lat: center.lat,
    lon: center.lon,
    precision: 'city',
    place: place.label,
    time,
    sources: [{
      name: `@${author.handle} on Bluesky`,
      kind: official ? 'official' : 'social',
      tier: official ? 'gov' : 'unrated',
      url,
      time,
    }],
    confirmed: official ? [`${name} posted this from a verified government web address`] : [],
    unconfirmed: official ? [] : ['Posted by an account that is not a verified government agency'],
  };
}

async function postsFor(place, center, hours) {
  if (!place.city) return [];
  const since = new Date(Date.now() - Math.min(hours, 168) * 3600e3).toISOString();
  const q = new URLSearchParams({ q: `"${place.city}"`, sort: 'latest', limit: '100', since });
  const data = await fetchJson(`${SEARCH}?${q}`, { ttl: 120 });
  // A local agency's own web address already says where it is
  // (police.muskegon-mi.gov), so its posts need no state in the text.
  const city = place.city.toLowerCase().replace(/[^a-z]/g, '');
  const localGov = (handle) => isGov(handle) && handle.toLowerCase().replace(/[^a-z]/g, '').includes(city);
  return (data.posts || [])
    .filter((p) => p.record && classify(p.record.text))
    .filter((p) => mentionsPlace(p.record.text, place) || localGov(p.author && p.author.handle))
    .map((p) => normalize(p, place, center));
}

module.exports = { postsFor, normalize, mentionsPlace, isGov };
