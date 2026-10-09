'use strict';

// Local news, from two free indexes:
//   - Google News search RSS (fast, broad local coverage)
//   - GDELT DOC 2.0 API (open data, commercial use allowed with attribution)
// Articles about the same event are clustered into one story, classified,
// and scored by how many independent outlets carry it.
const { fetchJson, fetchText } = require('../http');
const { parseRss } = require('../rss');
const { clusterArticles } = require('../cluster');
const { classify } = require('../classify');
const { tierFor, hostOf } = require('../outlets');
const { withVerification } = require('../verify');
const { ogImage, safeImage } = require('../og-image');

const TERMS = '(police OR sheriff OR shooting OR stabbing OR robbery OR arrested OR crash OR fire OR missing OR evacuation OR "shelter in place" OR homicide)';

function splitGoogleTitle(title, sourceName) {
  // Google News titles end with " - Outlet Name".
  const suffix = ` - ${sourceName}`;
  return sourceName && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

async function googleNews(place, hours) {
  const when = hours <= 24 ? '1d' : hours <= 168 ? '7d' : '30d';
  const where = place.city && place.state ? `"${place.city}" ${place.stateName || place.state}` : `"${place.label}"`;
  const q = encodeURIComponent(`${where} ${TERMS} when:${when}`);
  const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, { ttl: 120 });
  return parseRss(xml).map((it) => ({
    title: splitGoogleTitle(it.title, it.sourceName),
    url: it.link,
    outletUrl: it.sourceUrl,
    outlet: it.sourceName || hostOf(it.sourceUrl),
    published: it.published,
    via: 'Google News',
  }));
}

function gdeltDate(s) {
  // "20261008T141500Z" -> ISO
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(s || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

// GDELT allows one request per 5 seconds from an address (Vercel's are
// shared) and is often slow. After a refusal or a stall, rest it a few
// minutes so it doesn't hold up every feed; Google News still answers.
let gdeltRestUntil = 0;

async function gdelt(place, hours) {
  if (Date.now() < gdeltRestUntil) throw new Error('GDELT is resting after a refusal or timeout');
  const span = hours <= 24 ? '1d' : hours <= 168 ? '7d' : '30d';
  const where = place.city || place.label;
  const q = encodeURIComponent(`${where ? `"${where}" ` : ''}${TERMS} sourcecountry:US`);
  let data;
  try {
    data = await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=json&maxrecords=75&sort=datedesc&timespan=${span}`, { ttl: 180, timeoutMs: 4000 });
  } catch (err) {
    gdeltRestUntil = Date.now() + 5 * 60e3;
    throw err;
  }
  return (data.articles || []).map((a) => ({
    title: a.title,
    url: a.url,
    outletUrl: `https://${a.domain}`,
    outlet: a.domain,
    published: gdeltDate(a.seendate),
    image: safeImage(a.socialimage),
    via: 'GDELT',
  }));
}

// Turn clustered articles into story items placed at the city (news
// articles rarely give a precise location, and we won't invent one).
function toStories(articles, place, center) {
  const stories = [];
  for (const group of clusterArticles(articles)) {
    const text = group.map((a) => a.title).join(' ');
    const cls = classify(text);
    if (!cls) continue; // not a safety story
    const byOutlet = new Map();
    for (const a of group) if (!byOutlet.has(a.outlet)) byOutlet.set(a.outlet, a);
    const sources = [...byOutlet.values()].map((a) => {
      const tier = tierFor(a.outletUrl || a.url);
      return { name: a.outlet, kind: tier === 'gov' ? 'official' : 'news', tier, url: a.url, time: a.published, headline: a.title };
    });
    // Lead with the first established outlet's headline, else the earliest.
    const lead = sources.find((s) => s.tier === 'established' || s.tier === 'gov') || sources[0];
    const first = group[0];
    // The lead outlet's own picture if it has one, else any outlet's.
    const arts = [...byOutlet.values()];
    const leadArt = arts.find((a) => a.url === lead.url);
    const picArt = leadArt && leadArt.image ? leadArt : arts.find((a) => a.image);
    stories.push(withVerification({
      id: `story:${hashOf(lead.url)}`,
      kind: 'story',
      category: cls.category,
      severity: cls.severity,
      title: lead.headline,
      summary: sources.length > 1 ? `Reported by ${sources.length} outlets` : `Reported by ${lead.name}`,
      details: '',
      lat: center.lat,
      lon: center.lon,
      precision: 'city',
      place: place.label,
      time: first.published,
      updated: group[group.length - 1].published,
      image: picArt ? { url: picArt.image, credit: picArt.outlet, link: picArt.url } : null,
      sources,
      confirmed: [],
      unconfirmed: ['Location is the city named in the coverage, not the exact scene'],
    }));
  }
  return stories;
}

// Stories without a picture borrow the article's own share image. Google
// News links are redirects, so only direct article links are tried.
async function addImages(stories, limit = 6) {
  const missing = stories.filter((st) => !st.image).slice(0, limit);
  await Promise.allSettled(missing.map(async (st) => {
    const src = st.sources.find((s) => s.url && !/^https:\/\/news\.google\.com\//.test(s.url));
    if (!src) return;
    const url = await ogImage(src.url);
    if (url) st.image = { url, credit: src.name, link: src.url };
  }));
  return stories;
}

function hashOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

async function storiesFor(place, center, hours) {
  const settled = await Promise.allSettled([googleNews(place, hours), gdelt(place, hours)]);
  const articles = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = settled.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (!articles.length && errors.length === settled.length) throw new Error(errors.join('; '));
  const cutoff = Date.now() - hours * 3600e3;
  const recent = articles.filter((a) => a.title && a.published && new Date(a.published) >= cutoff);
  return addImages(toStories(recent, place, center));
}

async function nationalStories(hours = 24) {
  const place = { label: 'United States', city: '', state: '' };
  const q = encodeURIComponent(`${TERMS} when:1d`);
  const settled = await Promise.allSettled([
    fetchText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, { ttl: 180 }).then((xml) =>
      parseRss(xml).map((it) => ({ title: splitGoogleTitle(it.title, it.sourceName), url: it.link, outletUrl: it.sourceUrl, outlet: it.sourceName, published: it.published }))
    ),
    gdelt({}, hours),
  ]);
  const articles = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const cutoff = Date.now() - hours * 3600e3;
  return addImages(toStories(articles.filter((a) => a.published && new Date(a.published) >= cutoff), place, { lat: null, lon: null }));
}

module.exports = { storiesFor, nationalStories, toStories, addImages, splitGoogleTitle, gdeltDate };
