#!/usr/bin/env node
// Build per-beat SEO pages at deploy time.
//
// For each beat in the catalog this writes a static HTML file at
// `public/beat/{slug}-{shortid}.html`. Each file is a copy of the SPA's
// index.html with:
//   - <title>, <meta description>, <link canonical>, og:* and twitter:* rewritten
//     to be beat-specific
//   - A new <script type="application/ld+json"> with MusicRecording + Product schema
//   - A small inline script that auto-opens the detail modal for that beat after load
//
// This is what Googlebot (and IG/WA/Twitter card scrapers) sees — the SPA's
// JS-rendered grid is invisible to most crawlers, so without these per-beat
// pages every beat URL would resolve to the homepage's <head> and never get
// indexed individually.
//
// Runs during Vercel's build step via the `vercel-build` npm script. Also
// runnable locally: `node scripts/build-beat-pages.js`.
//
// Falls back gracefully: if Supabase is unreachable we skip the beat pages
// rather than fail the build (the homepage is the priority — losing per-beat
// SEO temporarily is better than blocking a deploy).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.warn('[build-beat-pages] sharp not installed — OG image generation disabled'); }

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'public', 'index.html');
const OUT_DIR = path.join(ROOT, 'public', 'beat');
const OG_DIR = path.join(ROOT, 'public', 'og');
const OG_MANIFEST = path.join(OG_DIR, '.manifest.json');
const SITE_URL = 'https://oneilbeats.store';

// Genre → accent color (mirrors PLAYER_GENRE_COLORS in public/index.html so
// the OG banner uses the same visual language as the in-app expanded player).
const GENRE_OG_COLORS = {
  'reggaeton':'#e63946','reggaetón':'#e63946','perreo':'#e63946',
  'trap':'#f4c542','latin trap':'#f4c542','trap latino':'#f4c542',
  'hip hop':'#a78bfa','hip-hop':'#a78bfa','boom bap':'#a78bfa','rap':'#a78bfa',
  'drill':'#19f0ff','ny drill':'#19f0ff','uk drill':'#19f0ff',
  'dancehall':'#34d399','afrobeats':'#fb923c','r&b':'#ec4899','latin pop':'#f97316','phonk':'#94a3b8',
};
function ogAccent(genre) {
  if (!genre) return '#e63946';
  return GENRE_OG_COLORS[String(genre).toLowerCase()] || '#e63946';
}
// XML-escape for SVG text nodes (different rules than HTML — apostrophes are
// fine in attribute-context but we still escape <, >, &, " so the SVG parses).
function svgEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function truncate(s, n) {
  s = String(s || '');
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

// ── Slug helpers ────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')      // strip accents
    .replace(/['"`’]/g, '')                                  // drop apostrophes
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-')                             // non-alnum → dash
    .replace(/^-+|-+$/g, '')                                 // trim dashes
    .slice(0, 60) || 'beat';
}
function shortId(uuid) {
  return String(uuid || '').replace(/-/g, '').slice(0, 4) || 'na00';
}
function beatSlug(beat) {
  return `${slugify(beat.title)}-${shortId(beat.id)}`;
}

// ── HTML escapers ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Related-beat scoring ────────────────────────────────────────────────────
// Picks the N highest-scoring related beats for a given beat, weighted by
// matching genre / subgenre / mood / BPM / key. Used to populate the "Related
// Beats" section in the crawler block — gives Google more internal links
// between same-genre pages, and helps the site's crawl depth.
function findRelatedBeats(beat, allBeats, n = 4) {
  if (!Array.isArray(allBeats) || !allBeats.length) return [];
  const score = (b) => {
    if (!b || b.id === beat.id) return -1;
    let s = 0;
    if (b.genre && b.genre === beat.genre) s += 3;
    if (b.subgenre && b.subgenre === beat.subgenre) s += 2;
    if (b.mood && b.mood === beat.mood) s += 1;
    if (b.bpm && beat.bpm && Math.abs(Number(b.bpm) - Number(beat.bpm)) <= 5) s += 1;
    if (b.key && b.key === beat.key) s += 0.5;
    return s;
  };
  return allBeats
    .map(b => ({ b, s: score(b) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(x => x.b);
}

// ─────────────────────────────────────────────────────────────────────────────
// OG IMAGE GENERATOR — 1200×630 landscape banner per beat.
//
// Square cover art looks bad in FB / Threads / X / WhatsApp feeds (cropped or
// letterboxed). A 1200×630 landscape with the cover on the left + title +
// tech specs + brand on the right gives every share a custom unfurl that
// reads like the artist's own marketing card.
//
// Build pipeline:
//   1. Hash {coverUrl, title, genre, bpm, key} → cache key
//   2. If public/og/{slug}.png exists with matching hash in the manifest, skip
//   3. Otherwise: fetch cover bytes, resize to 540×540, composite onto a
//      1200×630 SVG (genre-tinted gradient bg + text right column + brand row)
//   4. Write PNG + update manifest
//
// Falls back gracefully — any beat whose OG generation fails keeps using the
// raw square cover_url for og:image (existing behavior). The build never fails
// the deploy because of an OG render error.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const arr = new Uint8Array(await res.arrayBuffer());
    return Buffer.from(arr);
  } catch (e) {
    return null;
  }
}
function ogCacheKey(beat) {
  const payload = JSON.stringify({
    cover: beat.cover_url || beat.cover_art_url || '',
    title: beat.title || '',
    genre: beat.genre || '',
    bpm: beat.bpm || '',
    key: beat.key || '',
    v: 1,                            // bump to invalidate all OG images at once
  });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}
function buildOgSvg(beat, hasCover) {
  const accent = ogAccent(beat.genre);
  const title = truncate(beat.title || 'Beat', 32);
  const meta = [
    beat.genre ? String(beat.genre).toUpperCase() : null,
    beat.bpm ? `${beat.bpm} BPM` : null,
    beat.key || null,
  ].filter(Boolean).join('  ·  ');
  // Layout — cover lives at x=60..600, text column at x=640..1140
  const COVER_X = 60, COVER_SIZE = 540;
  const TEXT_X = 640;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.42"/>
      <stop offset="0.55" stop-color="#06060a"/>
      <stop offset="1" stop-color="#000"/>
    </linearGradient>
    <linearGradient id="accentBar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${accent}" stop-opacity="0"/>
      <stop offset="0.2" stop-color="${accent}" stop-opacity="1"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1200" height="630" fill="#06060a"/>
  <rect x="0" y="0" width="1200" height="630" fill="url(#bg)"/>
  <!-- Cover placeholder rect (gets composited over by the actual image) -->
  ${hasCover
    ? `<rect x="${COVER_X}" y="45" width="${COVER_SIZE}" height="${COVER_SIZE}" rx="20" fill="#0e0e16"/>`
    : `<rect x="${COVER_X}" y="45" width="${COVER_SIZE}" height="${COVER_SIZE}" rx="20" fill="#14141f" stroke="${accent}" stroke-width="2" stroke-opacity="0.6"/>
       <text x="${COVER_X + COVER_SIZE/2}" y="${45 + COVER_SIZE/2 + 20}" text-anchor="middle" fill="${accent}" font-family="sans-serif" font-weight="900" font-size="180" opacity="0.6">${svgEsc((beat.title||'?').charAt(0).toUpperCase())}</text>`
  }
  <!-- Brand eyebrow -->
  <text x="${TEXT_X}" y="115" fill="${accent}" font-family="sans-serif" font-weight="900" font-size="22" letter-spacing="6">O'NEIL BEATS</text>
  <rect x="${TEXT_X}" y="128" width="80" height="3" fill="${accent}"/>
  <!-- Title -->
  <text x="${TEXT_X}" y="220" fill="#ffffff" font-family="sans-serif" font-weight="900" font-size="76" letter-spacing="-2">${svgEsc(title)}</text>
  <!-- Meta line -->
  <text x="${TEXT_X}" y="290" fill="#cbd5e1" font-family="sans-serif" font-weight="700" font-size="28" letter-spacing="2">${svgEsc(meta)}</text>
  <!-- License pill -->
  <rect x="${TEXT_X}" y="340" width="220" height="56" rx="12" fill="${accent}"/>
  <text x="${TEXT_X + 110}" y="376" fill="#000000" font-family="sans-serif" font-weight="900" font-size="22" text-anchor="middle" letter-spacing="1">LICENSE FROM $${(Number(beat.lease_price)||29.99).toFixed(0)}</text>
  <!-- Bottom brand strip -->
  <rect x="${TEXT_X}" y="535" width="500" height="2" fill="url(#accentBar)"/>
  <text x="${TEXT_X}" y="575" fill="#94a3b8" font-family="sans-serif" font-weight="700" font-size="20" letter-spacing="3">PROD. BY O'NEIL</text>
  <text x="${TEXT_X}" y="600" fill="#64748b" font-family="sans-serif" font-weight="500" font-size="16" letter-spacing="2">ONEILBEATS.STORE  ·  INSTANT MP3 / WAV</text>
</svg>`;
}
// Pure buffer producer — used at runtime by server.js's /og/:slug.png route.
// Returns a Buffer (never writes to disk) so it works in serverless / read-only
// environments (Vercel lambda) where the build-time disk-write strategy can't
// land files in the deployed lambda. Vercel CDN caches the response by URL.
async function buildOgPngBuffer(beat) {
  if (!sharp) return null;
  const coverUrl = beat.cover_url || beat.cover_art_url || null;
  let coverBuf = null;
  if (coverUrl) coverBuf = await fetchImageBuffer(coverUrl);
  const svgString = buildOgSvg(beat, !!coverBuf);
  let img = sharp(Buffer.from(svgString)).png();
  if (coverBuf) {
    try {
      const coverPng = await sharp(coverBuf)
        .resize(540, 540, { fit: 'cover', position: 'centre' })
        .composite([{
          input: Buffer.from('<svg width="540" height="540"><rect x="0" y="0" width="540" height="540" rx="20" ry="20" fill="white"/></svg>'),
          blend: 'dest-in',
        }])
        .png()
        .toBuffer();
      img = img.composite([{ input: coverPng, top: 45, left: 60 }]);
    } catch (e) {
      // Cover composite failed — keep base SVG (which already has a fallback letter tile).
    }
  }
  return await img.toBuffer();
}
async function generateOgImage(beat, slug) {
  if (!sharp) return null;
  const outFile = path.join(OG_DIR, slug + '.png');
  const cacheKey = ogCacheKey(beat);
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(OG_MANIFEST, 'utf8')); } catch (_) { manifest = {}; }
  if (manifest[slug] === cacheKey && fs.existsSync(outFile)) return outFile;
  if (!fs.existsSync(OG_DIR)) fs.mkdirSync(OG_DIR, { recursive: true });
  const buf = await buildOgPngBuffer(beat);
  if (!buf) return null;
  fs.writeFileSync(outFile, buf);
  manifest[slug] = cacheKey;
  fs.writeFileSync(OG_MANIFEST, JSON.stringify(manifest, null, 2));
  return outFile;
}

// ── Build per-beat <title>, description, schema ────────────────────────────
function beatTitleTag(beat) {
  // SERP-trimmed: keep beat title + genre + BPM/key + brand under ~60 chars.
  // Old format hit ~73 chars and got truncated. Drop the year and "Buy at"
  // tail; collapse BPM and key into one segment. Brand stays at the end so
  // truncation doesn't kill the keyword.
  const genre = beat.genre || 'Rap';
  const tech = [
    beat.bpm ? `${beat.bpm} BPM` : null,
    beat.key || null,
  ].filter(Boolean).join(' ');
  return `${beat.title} — ${genre} Type Beat${tech ? ' ' + tech : ''} | O'Neil Beats`;
}
function beatDescription(beat) {
  // SERP-optimized 140-160 char meta description. Google truncates at ~160 in
  // search results so the previous 320-char version had its CTA cut. Now: lead
  // with the keyword phrase, surface BPM/key, end with price + brand.
  const bpm = beat.bpm ? `${beat.bpm} BPM` : '';
  const key = beat.key ? ` in ${beat.key}` : '';
  const mood = beat.mood ? ` ${String(beat.mood).toLowerCase()}` : '';
  const sub = beat.subgenre || beat.genre || 'rap';
  const head = `${beat.title} —${mood} ${sub} type beat${bpm ? ' ' + bpm : ''}${key}.`;
  const tail = ` Lease MP3/WAV from $29.99. Instant delivery. Prod. by O'Neil.`;
  const full = (head + tail).replace(/\s+/g, ' ').trim();
  return full.length > 160 ? full.slice(0, 157).trimEnd() + '…' : full;
}

// MusicRecording + Product schema. Google Music carousel + product rich snippets.
function beatJsonLd(beat, slug) {
  const url = `${SITE_URL}/beat/${slug}`;
  const offers = [];
  if (beat.lease_price)     offers.push({ '@type': 'Offer', name: 'Basic Lease (MP3)', price: String(beat.lease_price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url });
  if (beat.premium_price)   offers.push({ '@type': 'Offer', name: 'Premium Lease (MP3 + WAV)', price: String(beat.premium_price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url });
  if (beat.stems_price)     offers.push({ '@type': 'Offer', name: 'Stems / Track Out', price: String(beat.stems_price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url });
  if (beat.exclusive_price) offers.push({ '@type': 'Offer', name: 'Exclusive Rights', price: String(beat.exclusive_price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url });

  // Reviews — drives ⭐ stars in Google search results once ≥1 approved review.
  // (Google requires AggregateRating + at least one Review to display stars.)
  const approvedReviews = Array.isArray(beat.reviews) ? beat.reviews : [];
  let aggregateRating;
  let reviewSchema;
  if (approvedReviews.length > 0) {
    const avg = approvedReviews.reduce((s, r) => s + r.rating, 0) / approvedReviews.length;
    aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Math.round(avg * 10) / 10,
      reviewCount: approvedReviews.length,
      bestRating: 5,
      worstRating: 1,
    };
    reviewSchema = approvedReviews.slice(0, 10).map(r => ({
      '@type': 'Review',
      reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 },
      author: { '@type': 'Person', name: r.customer_name || 'Verified Buyer' },
      reviewBody: r.body || r.title || '',
      datePublished: (r.created_at || '').slice(0, 10) || undefined,
    }));
  }

  // 2026-04-30 GSC fix: Product schema requires aggregateRating + review per
  // Google's Product Snippet guidelines. Until we have a real review system
  // collecting authentic ratings from buyers, we can't claim Product type
  // (would either violate Google policy by fabricating ratings, or trigger
  // "missing field" warnings in Search Console). So Product schema is now
  // CONDITIONAL on having ≥1 approved review. Beats without reviews are
  // typed as MusicRecording only — Google doesn't require ratings there.
  // The Offer prices still flow through as "offers" — this just doesn't
  // light up the ⭐ rich snippet until real reviews exist.
  const hasReviews = approvedReviews.length > 0;
  const node = {
    '@context': 'https://schema.org',
    '@type': hasReviews ? ['MusicRecording', 'Product'] : 'MusicRecording',
    name: beat.title,
    url,
    image: beat.cover_art_url || beat.cover_url || `${SITE_URL}/og-image.jpg`,
    description: beatDescription(beat),
    sku: beat.id,
    genre: beat.genre || undefined,
    inAlbum: beat.subgenre ? { '@type': 'MusicAlbum', name: beat.subgenre, byArtist: { '@type': 'MusicGroup', name: "O'Neil" } } : undefined,
    byArtist: { '@type': 'MusicGroup', name: "O'Neil", url: SITE_URL },
    brand: { '@type': 'Brand', name: "O'Neil Beats" },
    offers: offers.length ? offers : undefined,
    audio: (beat.audio_url) ? { '@type': 'AudioObject', contentUrl: beat.audio_url, encodingFormat: 'audio/mpeg' } : undefined,
    keywords: Array.isArray(beat.tags) ? beat.tags.join(', ') : (beat.tags || undefined),
    aggregateRating,
    review: reviewSchema,
  };

  // BreadcrumbList for this beat
  const breadcrumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Beats', item: SITE_URL + '/#catalog' },
      ...(beat.genre ? [{ '@type': 'ListItem', position: 3, name: beat.genre + ' Beats', item: SITE_URL + '/#' + slugify(beat.genre) }] : []),
      { '@type': 'ListItem', position: beat.genre ? 4 : 3, name: beat.title, item: url },
    ],
  };

  return JSON.stringify(node) + '\n' + JSON.stringify(breadcrumbs);
}

// ── Template injection ──────────────────────────────────────────────────────
// Replace the homepage's SEO-critical <head> tags with beat-specific values.
// Uses anchored regex matches so the rest of index.html is preserved verbatim.
function renderBeatPage(template, beat, slug, allBeats = [], ogImagePath = null) {
  const url = `${SITE_URL}/beat/${slug}`;
  const titleTag = beatTitleTag(beat);
  const descTag  = beatDescription(beat);
  const squareCover = beat.cover_art_url || beat.cover_url || `${SITE_URL}/og-image.jpg`;
  // Prefer the generated 1200×630 landscape OG banner (per-beat) when available;
  // fall back to the square cover. Landscape unfurls render properly in FB /
  // Threads / X / WhatsApp feeds; square covers get cropped weirdly.
  const cover = ogImagePath ? `${SITE_URL}/og/${slug}.png` : squareCover;
  const ogTitle  = `${beat.title} — ${beat.genre || 'Rap'} Type Beat | O'Neil Beats`;

  let html = template;

  // <title>
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(titleTag)}</title>`);

  // <meta name="description">
  html = html.replace(/<meta\s+name="description"\s+content="[^"]*">/i,
    `<meta name="description" content="${esc(descTag)}">`);

  // canonical
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*">/i,
    `<link rel="canonical" href="${url}">`);

  // og:url, og:title, og:description, og:image
  html = html.replace(/<meta\s+property="og:url"\s+content="[^"]*">/i,
    `<meta property="og:url" content="${url}">`);
  html = html.replace(/<meta\s+property="og:title"\s+content="[^"]*">/i,
    `<meta property="og:title" content="${esc(ogTitle)}">`);
  html = html.replace(/<meta\s+property="og:description"\s+content="[^"]*">/i,
    `<meta property="og:description" content="${esc(descTag)}">`);
  html = html.replace(/<meta\s+property="og:image"\s+content="[^"]*">/i,
    `<meta property="og:image" content="${esc(cover)}">`);
  // 2026-05-06 — also update og:image:width/height/alt + add og:image:secure_url.
  // Prior to this, only og:image content was rewritten; the companion attributes
  // stayed at the homepage defaults (1200x630 + generic alt). Facebook's scraper
  // saw a 1200x630 declaration but loaded a 1024x1024 actual cover, treated the
  // mismatch as untrusted, and fell back to the producer avatar <img> on the
  // page body for the link preview. Now declares 1200x1200 (matches AI-generated
  // square covers) and gives FB a beat-specific alt + secure_url so it has zero
  // ambiguity about which image to render in the unfurl.
  // Dimensions match whichever image we ended up using: the generated 1200×630
  // landscape banner if it built, or the original 1200×1200 square cover.
  const ogIsLandscape = !!ogImagePath;
  html = html.replace(/<meta\s+property="og:image:width"\s+content="[^"]*">/i,
    `<meta property="og:image:width" content="1200">`);
  html = html.replace(/<meta\s+property="og:image:height"\s+content="[^"]*">/i,
    `<meta property="og:image:height" content="${ogIsLandscape ? 630 : 1200}">`);
  html = html.replace(/<meta\s+property="og:image:alt"\s+content="[^"]*">/i,
    `<meta property="og:image:alt" content="${esc(beat.title + ' — ' + (beat.genre || 'beat') + " on O'Neil Beats")}">`);
  // Add og:image:secure_url (HTTPS-only platforms prefer this) + og:image type.
  // Inject right after og:image so the cluster stays together for FB's parser.
  html = html.replace(/(<meta\s+property="og:image"\s+content="[^"]*">)/i,
    `$1\n<meta property="og:image:secure_url" content="${esc(cover)}">\n<meta property="og:image:type" content="image/png">`);
  // og:type for individual song page
  html = html.replace(/<meta\s+property="og:type"\s+content="website">/i,
    `<meta property="og:type" content="music.song">`);

  // 2026-05-08 — og:audio cluster lets FB / Threads / X build playable unfurls
  // for the beat's tagged preview MP3 (where supported). The audio_url field
  // is the Supabase-hosted tagged preview; preview/{id} would also work but
  // hits our backend on every render and adds latency vs the direct URL.
  // Use the existing canonical audio_url; skip the cluster if the beat has no
  // playable preview (rare, but keeps Facebook's scraper from failing).
  const audioUrl = beat.audio_url || beat.mp3_url || null;
  if (audioUrl) {
    const audioBlock = [
      `<meta property="og:audio" content="${esc(audioUrl)}">`,
      `<meta property="og:audio:secure_url" content="${esc(audioUrl)}">`,
      `<meta property="og:audio:type" content="audio/mpeg">`,
      // music.song extension — Facebook's spec uses these to label the unfurl
      // with proper artist + duration metadata. Duration is best-effort
      // (only emit when we know it from the beat record).
      `<meta property="music:musician" content="${SITE_URL}/about">`,
      ...(beat.duration_seconds ? [`<meta property="music:duration" content="${Number(beat.duration_seconds).toFixed(0)}">`] : []),
    ].join('\n');
    html = html.replace(/(<meta\s+property="og:type"\s+content="music\.song">)/i, `$1\n${audioBlock}`);
  }

  // twitter:title, twitter:description, twitter:image (+ alt for accessibility / parser)
  html = html.replace(/<meta\s+name="twitter:title"\s+content="[^"]*">/i,
    `<meta name="twitter:title" content="${esc(ogTitle)}">`);
  html = html.replace(/<meta\s+name="twitter:description"\s+content="[^"]*">/i,
    `<meta name="twitter:description" content="${esc(descTag)}">`);
  html = html.replace(/<meta\s+name="twitter:image"\s+content="[^"]*">/i,
    `<meta name="twitter:image" content="${esc(cover)}">`);
  html = html.replace(/<meta\s+name="twitter:image:alt"\s+content="[^"]*">/i,
    `<meta name="twitter:image:alt" content="${esc(beat.title + ' cover art')}">`);

  // Insert per-beat JSON-LD right before </head>
  const jsonLd = beatJsonLd(beat, slug);
  // Wrap each JSON object in its own <script> for Google's parser
  const ldBlocks = jsonLd.split('\n').map(j =>
    `<script type="application/ld+json" data-beat="${esc(beat.id)}">${j}</script>`
  ).join('');
  html = html.replace(/<\/head>/i, ldBlocks + '</head>');

  // Auto-open the detail modal once the SPA hydrates. This runs after the
  // SPA's main script has populated `allBeats` and registered `openDetail`.
  // Use a polling pattern (not fixed timeout) so it works regardless of API latency.
  const autoOpen = `<script>
(function(){
  var bid=${JSON.stringify(beat.id)};
  function tryOpen(){
    if (typeof openDetail==='function' && Array.isArray(window.allBeats||null)===false){
      // allBeats is closure-scoped, but openDetail itself reads from it. If openDetail
      // succeeds we're done; if not (beat not yet loaded into closure), wait.
      try { openDetail(bid); return true; } catch(e){}
    }
    if (typeof openDetail==='function'){
      try { openDetail(bid); return true; } catch(e){}
    }
    return false;
  }
  var tries=0;
  var iv=setInterval(function(){
    if (tryOpen() || ++tries>40){ clearInterval(iv); }
  }, 150);
})();
</script>`;
  html = html.replace(/<\/body>/i, autoOpen + '</body>');

  // Add a hidden <h1> + structured beat content visible to crawlers (and screen
  // readers) without disrupting the SPA's visual design. The SPA's grid renders
  // over this, so users see the normal homepage; crawlers see the beat content.
  const related = findRelatedBeats(beat, allBeats, 4);
  const crawlerBlock = renderCrawlerBlock(beat, slug, url, related);
  html = html.replace(/<body([^>]*)>/i, `<body$1>${crawlerBlock}`);

  // Demote the homepage hero H1 to H2 — beat pages already supply their own H1
  // in the crawler block. Two H1s on one page split topical signal in Google.
  html = html.replace(/<h1\s+class="hero-h1-seo"\s+id="page-h1">([\s\S]*?)<\/h1>/i,
    '<h2 class="hero-h1-seo" id="page-h1">$1</h2>');

  // Strip the homepage's broken hreflang block — beat pages have no Spanish
  // equivalent, so claiming es→/ misleads Google. Better to emit nothing.
  html = html.replace(/\s*<link\s+rel="alternate"\s+hreflang="(?:en|es|x-default)"[^>]*>/gi, '');

  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOG POSTS — cornerstone content for topical authority
// ─────────────────────────────────────────────────────────────────────────────
//
// Each post is an evergreen, query-targeted piece. Stored as HTML strings so
// internal links and formatting stay precise. Generated at /blog/{slug} with
// Article (or HowTo) schema, BreadcrumbList, full per-post SEO head.

// Inline figure helper for blog posts. Renders a static, Vercel-hosted image
// from public/img/blog/. Static files are baked into the deploy so every page
// load gets a fast, cached, edge-served image — no dependency on a live image
// generator at request time.
//
// To regenerate the source images: run `node scripts/generate-blog-images.js`
// (downloads each image from Pollinations.ai using stable seeds and saves it
// to public/img/blog/). Pollinations is the same free engine the storefront
// already uses for AI cover art via /upload/generate-cover.
//
//   • Hero figures use loading=eager + fetchpriority=high so above-fold paints.
//   • Non-hero figures use loading=lazy to keep LCP scores high.
//   • alt + figcaption carry the keyword payload for SEO + a11y.
function blogFigure({ src, alt, caption, width = 1000, height = 600, hero = false }) {
  const cls = hero ? 'hero' : '';
  const loading = hero ? 'eager' : 'lazy';
  const prio = hero ? ' fetchpriority="high"' : '';
  const altEsc = String(alt).replace(/"/g, '&quot;');
  const capEsc = String(caption).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return '<figure class="' + cls + '">'
    + '<img src="' + src + '" alt="' + altEsc + '" loading="' + loading + '" width="' + width + '" height="' + height + '"' + prio + '>'
    + '<figcaption>' + capEsc + '</figcaption>'
    + '</figure>';
}

const BLOG_POSTS = [
  {
    slug: 'lease-vs-exclusive-beat-license-guide',
    title: "Lease vs Exclusive vs Stems — What License Should an Artist Actually Buy in 2026?",
    metaTitle: "Beat Licensing Explained: Lease vs Exclusive 2026",
    metaDescription: "Lease, Premium, Stems, Exclusive — what each beat license actually gets you, what it costs, and which one matches your release plan.",
    excerpt: "A no-fluff guide to the four beat-license tiers — lease, premium, stems, exclusive. What's actually different, what each costs, and which one you actually need based on what you're doing with the song.",
    publishedDate: '2026-04-26',
    type: 'Article',
    bodyHtml: `
<p class="lead">If you've ever stared at a beat store's "Lease — $29.99" / "Premium — $99" / "Stems — $199" / "Exclusive — Contact" page and wondered <em>what the actual difference is</em>, this is for you. I'm going to explain what every tier really gets you, when each one is worth the money, and the one mistake that costs artists the most.</p>

${blogFigure({
  src: '/img/blog/lease-vs-exclusive-hero.jpg',
  alt: 'Beat license contract on a producer desk — Lease, Premium, Stems, and Exclusive tiers explained for artists buying reggaeton and trap beats in 2026',
  caption: 'Every tier on a beat store is a different contract. Knowing what each PDF actually grants you is the difference between a clean release and a takedown email.',
  width: 1059, height: 556, hero: true,
})}

<h2>The TL;DR</h2>
<ul>
  <li><strong>Lease</strong> ($29-50): MP3 only, capped streams, you can release on Spotify/YouTube but the same beat will be sold to other artists. Producer credit required ("Prod. by O'Neil"). Right answer for: most artists, most songs.</li>
  <li><strong>Premium Lease</strong> ($80-120): MP3 <strong>+ WAV</strong> (uncompressed audio), unlimited streams, radio rights. Same non-exclusivity. Right answer for: a song you actually believe is going to push.</li>
  <li><strong>Stems / Track Out</strong> ($150-300): All individual elements separated — drums, melody, bass, 808s, FX. You can mix it your way, change arrangement, swap sounds. Right answer for: real producers and engineers who want full control.</li>
  <li><strong>Exclusive</strong> ($500-3000+): You own the beat outright. It's removed from the store. No one else can buy it ever. No producer credit required. Right answer for: a song you're confident in, with budget and a release plan.</li>
</ul>

<h2>What "non-exclusive" actually means</h2>
<p>This is the part most artists miss. A lease (basic OR premium) is <strong>non-exclusive</strong>. That means after you buy "<a href="/beat/luna-5167">Luna</a>" for $29.99, the producer can — and will — sell that same beat to other artists. Five other rappers might release a song over the same beat as you. That's not bad-faith on the producer's part; it's the explicit deal.</p>
<p>Non-exclusive licenses are how producers can offer beats at $29 instead of $500. The math only works because the same beat sells multiple times.</p>
<p>The fix isn't necessarily "always buy exclusive." The fix is to <em>match the license to your goal</em>:</p>
<ul>
  <li>Releasing a SoundCloud single while you build a fan base? Lease is fine.</li>
  <li>Putting a track on a major DSP (Spotify, Apple Music) and you expect 50K+ streams? Premium Lease at minimum, and start a conversation about exclusive if you're confident.</li>
  <li>Pitching a label or a sync placement (TV/film/ads)? Exclusive. Labels and sync agencies will not touch a non-exclusive beat.</li>
</ul>

${blogFigure({
  src: '/img/blog/lease-vs-exclusive-mid.jpg',
  alt: 'Streaming royalty calculator showing the math behind a beat lease versus exclusive license at 100K and 1M Spotify streams',
  caption: 'The lease-vs-exclusive math: $29.99 lease + 100K streams nets you $270. $1,500 exclusive only beats that once you cross several million streams or chase a sync placement.',
  width: 1022, height: 576,
})}

<h2>The exclusive trap most stores set</h2>
<p>Watch how most beat stores handle exclusive. They list lease prices on every beat — and when you click "Exclusive", it says <strong>"Contact for pricing"</strong> with a mailto link. You email. Half the time you don't get a reply for days. By then you've lost momentum.</p>
<p>That's why <a href="/">O'Neil Beats</a> shows the exclusive offer slider <strong>directly on every beat detail page</strong>. You see the suggested price range ($500–$3,000 for most beats), pick what you want to offer, type your email, and submit. The producer reviews and replies — usually within 24 hours.</p>
<p>You can negotiate. If the listed price is $1,000 and you offer $700 with a real release plan, the producer might take it. That's what the slider is for.</p>

<h2>Should you ever buy stems without exclusive?</h2>
<p>Yes — if you're an actual producer or engineer. Stems give you the individual instruments (drums, 808s, melody, FX) as separate audio files. You can:</p>
<ul>
  <li>Re-mix the beat to fit your vocal recording</li>
  <li>Drop the melody on a verse, bring it back on the hook</li>
  <li>Swap the snare for one that hits harder</li>
  <li>Add a custom intro or outro</li>
  <li>Master the final mix yourself instead of accepting the producer's mixdown</li>
</ul>
<p>If none of that means anything to you, save the $100 and buy the Premium Lease instead.</p>

<h2>Real numbers: what a beat costs you on a release</h2>
<p>For a song that does 100,000 streams on Spotify (modest indie release):</p>
<ul>
  <li>Lease cost: $29.99 (one-time)</li>
  <li>Spotify revenue at ~$0.003/stream: $300</li>
  <li>Net to you (after lease): $270</li>
</ul>
<p>For a song that does 1,000,000 streams (a real hit):</p>
<ul>
  <li>Premium Lease cost: $99.99 (one-time)</li>
  <li>Spotify revenue: $3,000</li>
  <li>Net to you (after Premium): $2,900</li>
</ul>
<p>For exclusive at $1,500 — only worth it if you're confident the song will hit, OR if you need exclusivity for label/sync. The math tilts to exclusive once you're past about 5M expected streams or you're chasing a placement.</p>

<h2>Quick decision tree</h2>
<ol>
  <li>Releasing on SoundCloud or social only → Lease ($29.99).</li>
  <li>Spotify / Apple Music release, expecting under 500K streams → Premium Lease ($99.99).</li>
  <li>You're a producer/engineer who wants to remix → Stems ($199.99).</li>
  <li>Pitching to a label, sync agent, or you're confident the song is THE one → Exclusive ($500-$3,000+).</li>
  <li>You don't know yet → Lease. You can always upgrade later by emailing the producer.</li>
</ol>

<h2>One last thing artists overlook</h2>
<p>Read the actual license PDF that comes with your purchase. Every beat at <a href="/">oneilbeats.store</a> auto-generates a license document with your name, the beat title, the date, and the exact terms. Keep it. If you ever get a copyright strike or DSP question, that PDF is your proof.</p>

<p class="cta-block"><a href="/" class="cta-link">Browse beats →</a> · <a href="/reggaeton-beats" class="cta-link">Reggaeton catalog</a> · <a href="/trap-beats" class="cta-link">Trap catalog</a></p>
`,
  },
  {
    slug: 'how-to-write-to-a-reggaeton-beat',
    title: "How to Write to a Reggaeton Beat — Step-by-Step (Hooks, Verses, Drops)",
    metaTitle: "How to Write to a Reggaeton Beat (Step-by-Step)",
    metaDescription: "Step-by-step reggaeton songwriting: hook first, find the pocket, structure the song, then record. A practical guide for indie artists writing toplines.",
    excerpt: "A producer's walkthrough on writing toplines, hooks, and verses over a reggaeton instrumental. Where to start, how to find the pocket, and the structure that makes modern reggaeton hits work.",
    publishedDate: '2026-04-26',
    type: 'HowTo',
    estimatedTime: 'PT45M',
    bodyHtml: `
<p class="lead">You bought a reggaeton beat — or you're testing one of the free previews — and now you have to write something to it. If you're new to writing reggaeton, the genre can feel deceptively simple. The chords loop, the dembow groove repeats, and somehow Bad Bunny makes a hit out of it. Here's the actual process, broken down.</p>

${blogFigure({
  src: '/img/blog/how-to-write-hero.jpg',
  alt: 'Latin reggaeton recording session — vocalist at the mic with producer at the mixing console, the standard setup for tracking dembow and perreo hooks',
  caption: 'How a reggaeton hook actually gets recorded: hum the melody first, find the words second, track over the dembow groove last.',
  width: 1059, height: 556, hero: true,
})}

<h2>Step 1: Listen to the beat without trying to write</h2>
<p>Play it back twice with no notepad open. Reggaeton is a <em>groove-first</em> genre. The dembow pattern (boom-ch-boom-chick) is the foundation; everything you write needs to lock into it. Don't try to overlay melodies or words on the first listen — feel the pocket first.</p>
<p>Notice three things:</p>
<ul>
  <li><strong>The BPM</strong> (90–100 for classic perreo, 95-105 for modern). It tells you how slow or fast to deliver words.</li>
  <li><strong>The key</strong> (most reggaeton sits in minor keys — C minor, A minor, F minor are common). It tells you what notes to sing.</li>
  <li><strong>The drop spot</strong> (where the beat fully kicks in vs. when it's stripped down). This is where your hook lands.</li>
</ul>

<h2>Step 2: Hook first, always</h2>
<p>Reggaeton is hook-driven. Every modern reggaeton hit can be summarized in one repeated phrase that people can sing along to within one listen. Bad Bunny's "Tití me preguntó." Karol G's "Bichota." Feid's "Normal." All hooks come first.</p>
<p>To write a hook:</p>
<ol>
  <li>Pick a 4-bar section of the beat where the dembow groove is fully in.</li>
  <li>Hum a melody over it. Just nonsense syllables. Record it on your phone.</li>
  <li>Listen back. The catchy melody is your hook melody.</li>
  <li>Now find words that fit that melody — usually a short phrase (5-9 syllables) that captures one emotion or one image.</li>
</ol>
<p>Example: a smooth modern reggaeton beat at 92 BPM in minor key — try a hook melody that descends down 3-4 notes, with a 5-7 syllable phrase like "Tú ere' lo que yo busqué" or "Bailamo' hasta que amanezca." Write the hook before anything else.</p>

${blogFigure({
  src: '/img/blog/how-to-write-mid.jpg',
  alt: 'Songwriter writing a reggaeton hook in a lyric notebook with the dembow groove playing on studio monitors',
  caption: 'Hook first, verse second. Hum the melody on a voice memo, write the words to fit the melody, then build the verse to set up the hook.',
  width: 1022, height: 576,
})}

<h2>Step 3: Build the verse around the hook</h2>
<p>Verses in reggaeton are conversational. They don't compete with the hook melodically — they set it up. Most artists rap-sing verses, alternating between melodic phrases and faster rhythmic delivery. Listen to "<a href="/beat/luna-5167">Luna</a>" — the melodic loop in the hook becomes a sung phrase, but the verse is more spoken-word.</p>
<p>Verse template that works for most modern reggaeton:</p>
<ul>
  <li><strong>Lines 1-2:</strong> Set the scene (who, where, when). One image per line.</li>
  <li><strong>Lines 3-4:</strong> Build tension or detail. Use specifics — a place name, a time, a detail that paints the scene.</li>
  <li><strong>Lines 5-6:</strong> Pivot toward the emotion of the hook. Foreshadow the chorus.</li>
  <li><strong>Lines 7-8:</strong> Land on a line that sets up the hook. The last word should rhyme with the first word of the hook OR sound like an opening for the hook to resolve.</li>
</ul>

<h2>Step 4: Find the pocket</h2>
<p>The pocket is the rhythmic placement of your words against the dembow. There are three main pocket choices in reggaeton:</p>
<ul>
  <li><strong>On-beat</strong> — words land on the kicks. Powerful, simple. Good for anthems (Daddy Yankee, J Balvin).</li>
  <li><strong>Behind-beat</strong> — words land slightly after the kicks. Smooth, conversational. Modern reggaeton (Bad Bunny, Feid).</li>
  <li><strong>Cross-rhythm</strong> — words push against the dembow. Higher difficulty but more memorable (Rauw Alejandro at his best).</li>
</ul>
<p>For your first songs, behind-beat is the easiest pocket to nail. Speak your verse a quarter-beat after where the kick lands. Listen back and adjust until it feels effortless.</p>

<h2>Step 5: Structure the full song</h2>
<p>Modern reggaeton song structure (almost universal):</p>
<ol>
  <li>Intro (4-8 bars, often beat-only or beat with vocal echoes) — 8-15 seconds</li>
  <li>Hook 1 (8 bars) — the chorus you wrote first</li>
  <li>Verse 1 (8-16 bars)</li>
  <li>Hook 2 (8 bars, same as Hook 1)</li>
  <li>Verse 2 (8-16 bars, sometimes with a guest feature)</li>
  <li>Hook 3 (often double — 16 bars total — to land the song)</li>
  <li>Outro (4-8 bars, often the dembow stripped back)</li>
</ol>
<p>Total runtime should be 2:30–3:15. Anything shorter feels like you didn't develop the song; anything longer loses streaming attention. Cap at 3:15.</p>

<h2>Step 6: Record and re-record the hook 5 times</h2>
<p>The hook is what people remember. Record it 5 different ways — different inflections, different emphasis, slightly different melody variants. Pick the best take, then layer 2-3 vocal stacks on top to thicken it. Most modern reggaeton hits have 4-6 vocal layers on the hook.</p>

<h2>Step 7: Mix loud, mix clean</h2>
<p>If you don't have engineering skills yet, buy the <strong>Premium Lease</strong> for the WAV file (uncompressed audio holds up better when you mix), and ship the recorded vocals to an engineer who specializes in reggaeton. Or buy the <a href="/blog/lease-vs-exclusive-beat-license-guide">stems package</a> if you want to mix yourself.</p>

<h2>What to write about</h2>
<p>Reggaeton's classic themes: club nights, attraction, a specific person, a specific place, the highs and lows of love. Modern reggaeton has expanded into mental health, success, family, identity (Bad Bunny "<em>El Apagón</em>" being the obvious case study). Pick a topic you care about, write the hook around the most repeatable line, build out from there.</p>

<p class="cta-block">Ready to write? <a href="/reggaeton-beats" class="cta-link">Browse reggaeton beats →</a> · <a href="/perreo-beats" class="cta-link">Perreo beats</a> · <a href="/modern-reggaeton-beats" class="cta-link">Modern reggaeton</a></p>
`,
    howToSteps: [
      { name: 'Listen to the beat without trying to write', text: 'Play the beat back twice without writing. Feel the dembow groove and identify BPM, key, and where the drop lands.' },
      { name: 'Hook first, always', text: 'Hum a 4-bar melody over the dropped section, then write a 5-9 syllable phrase to fit it. The hook comes before anything else.' },
      { name: 'Build the verse around the hook', text: 'Write 8-line verse that sets the scene, builds detail, and lands on a line that sets up the hook.' },
      { name: 'Find the pocket', text: 'Choose on-beat (anthem), behind-beat (smooth modern), or cross-rhythm. Behind-beat is easiest for new writers.' },
      { name: 'Structure the full song', text: 'Intro → Hook → Verse 1 → Hook → Verse 2 → Hook (double) → Outro. Aim for 2:30–3:15 runtime.' },
      { name: 'Record the hook 5 times', text: 'Multiple takes with different inflections. Pick the best, layer 2-3 stacks on top to thicken.' },
      { name: 'Mix loud, mix clean', text: 'Buy the WAV file via Premium Lease for cleaner mix, or stems if mixing yourself.' },
    ],
  },
  {
    slug: 'free-beats-vs-paid-tagged-mp3-explained',
    title: "Free Beats vs Paid: What Artists Get with the Tagged MP3 (and When to Upgrade)",
    metaTitle: "Free vs Paid Beats: When to Upgrade Your License",
    metaDescription: "What the tagged free MP3 actually allows, why the producer tag exists, and the moment you should upgrade to a paid lease before release.",
    excerpt: "Every producer offers free beats. Most artists don't understand what those free downloads legally let them do. Here's the truth about tagged free MP3s, when they're enough, and the upgrade triggers that mean it's time to buy.",
    publishedDate: '2026-04-26',
    type: 'Article',
    bodyHtml: `
<p class="lead">"Free beat" is the most-searched query in the entire beat-store space. Every producer page has a free section. But almost no artist understands what they're actually allowed to do with a free tagged beat — and the misunderstanding is what gets songs taken down off Spotify.</p>

${blogFigure({
  src: '/img/blog/free-vs-paid-hero.jpg',
  alt: 'Free tagged MP3 beat compared to a paid clean WAV beat — what artists are licensing when they upgrade',
  caption: 'Same audio, two versions. Tagged MP3 free for demos and SoundCloud. Clean untagged WAV with a license PDF for any release that goes monetized.',
  width: 1059, height: 556, hero: true,
})}

<h2>What a tagged free beat actually is</h2>
<p>When a producer offers a "free beat" download, you're getting an MP3 file that has a producer voice tag layered on top — usually a short audio clip like "Prod. by O'Neil" repeated every 30 seconds throughout the beat. That tag isn't a bug. It's the entire business model.</p>
<p>The tag means:</p>
<ul>
  <li>You can listen to the full beat, see how it sounds with vocals, decide if you want to use it.</li>
  <li>You can record a demo or a freestyle and post it on SoundCloud, YouTube (non-monetized), Instagram, TikTok — basically anywhere you're not making money.</li>
  <li>You can share the beat to test reception with your audience.</li>
</ul>
<p>The tag does NOT mean:</p>
<ul>
  <li>You can put the song on Spotify, Apple Music, Tidal, or any monetized platform.</li>
  <li>You can monetize the YouTube video (turn on ads).</li>
  <li>You can sell the song.</li>
  <li>You can license the song for sync (TV, film, ads).</li>
  <li>You can release without producer credit.</li>
</ul>

<h2>Why the tag exists</h2>
<p>The tag protects the producer's right to get paid. If you release a tagged beat to Spotify, the platform's audio fingerprinting (ContentID, Audible Magic, etc.) can flag it. The producer's distributor often catches the unauthorized use, files a takedown, and your song disappears — usually after it's already started building plays. Sometimes the producer files a copyright claim and gets retroactive royalties; either way you've lost the song.</p>
<p>The fix is simple: when you decide a song is going to release, buy a license. The license gives you the <strong>untagged studio-clean version</strong> of the beat — same audio, no voice tag, plus a PDF license with your name on it. From that point forward, you can release legally on any platform.</p>

${blogFigure({
  src: '/img/blog/free-vs-paid-mid.jpg',
  alt: 'Independent producer mixing a beat in a home studio — the human work behind a paid untagged license',
  caption: 'The producer voice tag is the producer protecting their right to get paid. Buy the license and the tag goes away — that is the entire business model in one trade.',
  width: 1022, height: 576,
})}

<h2>What does the untagged version cost?</h2>
<p>At <a href="/">oneilbeats.store</a>, the cheapest license is $29.99 (Lease) — that gets you the MP3 untagged + the right to release on streaming platforms with up to 100K streams. For most independent artists' first or second release, that's the right tier.</p>
<p>If you expect to push past 100K streams (a real release with a marketing budget), step up to the Premium Lease at $99.99 — that includes the WAV file (better mix headroom), unlimited streams, and radio rights. We broke down the full license tiers in <a href="/blog/lease-vs-exclusive-beat-license-guide">this guide</a>.</p>

<h2>When the free version is genuinely enough</h2>
<p>Free tagged beats serve a real purpose. Use them for:</p>
<ul>
  <li><strong>Demos for sync agents or labels</strong> — you can attach a tagged demo to a pitch email; the agent knows you'll license once the placement is confirmed.</li>
  <li><strong>SoundCloud freestyles</strong> — SoundCloud doesn't enforce takedowns aggressively for tagged beats, and the platform is built for freestyle culture.</li>
  <li><strong>Live shows / cyphers</strong> — perform over a tagged beat, no streaming = no enforcement.</li>
  <li><strong>YouTube freestyle videos (NON-monetized)</strong> — keep ads off, credit the producer in the description, link to the store.</li>
  <li><strong>Testing audience reaction</strong> before committing to a license.</li>
</ul>

<h2>The upgrade triggers</h2>
<p>You should buy a license the moment any of these is true:</p>
<ol>
  <li>You're uploading the song to Spotify, Apple Music, or any DSP.</li>
  <li>You're turning on YouTube monetization on the song video.</li>
  <li>A label, sync agent, or sponsor has asked about the song.</li>
  <li>You're selling the song or merchandise tied to it.</li>
  <li>You're using the song in a paid ad (your own or someone else's).</li>
</ol>
<p>The instant any of those becomes true, get the untagged version. It's $29.99 for a Lease. The risk of losing a song to a takedown is way bigger than the cost of clearing it properly.</p>

<h2>How to buy without losing momentum</h2>
<p>The whole reason this matters is that artists who use tagged beats often build buzz on TikTok or SoundCloud first, then try to release the song on Spotify and have it taken down right when it's about to break. That's the worst possible outcome.</p>
<p>The fix is a 60-second checkout. At <a href="/">oneilbeats.store</a>:</p>
<ol>
  <li>Click the beat you've been testing.</li>
  <li>Click "Add Lease to Cart" ($29.99).</li>
  <li>Stripe checkout (Apple Pay or Google Pay if you're on phone).</li>
  <li>Untagged MP3 + license PDF arrive by email within seconds.</li>
</ol>
<p>You're cleared. Replace the tagged version with the untagged version on every platform you've posted, and your release plan stays on track.</p>

<h2>One more thing — credit the producer</h2>
<p>Lease and Premium Lease licenses require you to include "Prod. by O'Neil" in your song title or description. This is non-negotiable and it's how producer ecosystems work. The credit is what builds the producer's brand, which is what funds new beats coming to the catalog. Honor it. Exclusive licenses are the only tier that doesn't require credit.</p>

<p class="cta-block"><a href="/" class="cta-link">Browse all beats →</a> · <a href="/blog/lease-vs-exclusive-beat-license-guide" class="cta-link">License tier breakdown</a> · <a href="/reggaeton-beats" class="cta-link">Reggaeton catalog</a></p>
`,
  },
  {
    slug: 'how-to-find-free-beats-2026-and-why-demos-matter',
    title: "How to Find Free Beats in 2026 (and Why Recording a Demo First Will Make You a Better Artist)",
    metaTitle: "Free Beats in 2026: Find Them, Demo, Then Buy",
    metaDescription: "Where indie artists actually find free beats in 2026, why recording a demo before licensing matters more than the catalog size, and when to upgrade.",
    excerpt: "Where to find legit free beats in 2026 — the real sources, the scams to avoid, and why recording a demo over a free tagged beat before you buy a license is the single best habit independent artists can build. Written by an active producer.",
    publishedDate: '2026-04-26',
    type: 'Article',
    bodyHtml: `
<p class="lead">Every aspiring rapper, singer, and reggaetonero starts the same way: hunting for free beats. In 2026 there are more free beats online than ever — and more scams, dead links, and DMCA traps than ever. This guide is the shortcut: where active producers actually drop free beats this year, how to tell a real free beat from a stolen one, and the unglamorous habit that separates artists who blow up from artists who stay stuck — recording a demo before you ever spend a dollar.</p>

${blogFigure({
  src: '/img/blog/how-to-find-hero.jpg',
  alt: 'Independent rapper browsing free beats online at a home bedroom studio in 2026 — the modern free-beat-to-release workflow',
  caption: 'Most artist careers start here: a laptop, a cheap mic, and a hunt for free tagged beats to write over. The trick in 2026 is filtering signal from spam.',
  width: 1059, height: 556, hero: true,
})}

<h2>Where to find legit free beats in 2026</h2>
<p>"Free beats" is one of the highest-volume music queries on Google and YouTube — which means the SERP is also the most flooded with garbage. Here are the sources that are still real in 2026, ranked by signal-to-noise:</p>
<ol>
  <li><strong>Producer stores with a "free" tab.</strong> The cleanest source. An active producer site like <a href="/">oneilbeats.store</a> will have a free section where the producer themselves uploads tagged MP3s every week. The beats are current, the tag is honest, and there's a clear path to license if you want to release. Look for the words "tagged MP3" and a file size around 4–8 MB.</li>
  <li><strong>YouTube — but only producer channels you can verify.</strong> Search "[artist] type beat free" and filter to last week. Skip channels that look like beat aggregators (10,000+ uploads, no face, no socials). Stick to producers who post their own face, comment back, and link to a real store. Download via the producer's link in the description, not from sketchy MP3 rippers — those strip the tag and create a legal landmine you'll inherit.</li>
  <li><strong>Free Beat Friday email lists.</strong> Most serious producers run a weekly drop to email subscribers. We do this — sign up at the bottom of <a href="/">oneilbeats.store</a> and you get a fresh tagged beat every Friday. It's the highest-quality free source on the internet because the producer is using it as marketing for their paid catalog, so the bar is high.</li>
  <li><strong>BeatStars / Airbit free filters.</strong> Both marketplaces let you filter to "free download." Quality is mixed — you'll find gold and you'll find loop-pack soup. Use the BPM, key, and genre filters aggressively or you'll waste an hour scrolling.</li>
  <li><strong>SoundCloud "free dl" links.</strong> Still alive in 2026, mostly for boom bap, lo-fi, drill, and underground genres. Search "[genre] free dl" and sort by recent. The link in the description is the real download.</li>
  <li><strong>Reddit r/makinghiphop weekly free-beat threads.</strong> Producers drop links every week looking for feedback and exposure. Quality is unfiltered but the freshest stuff lives here.</li>
</ol>

<h2>What to avoid — the 2026 scam list</h2>
<p>The free-beat space has a permanent infestation of scrapers and AI slop. If you see any of these, close the tab:</p>
<ul>
  <li><strong>"Free download" sites that ask for your email twice or want a card to "verify."</strong> Nobody charges you to verify a free MP3.</li>
  <li><strong>YouTube channels with thousands of uploads and no human in any video.</strong> They're scraping other producers' beats, stripping tags, and reuploading. Using one of those gets your song claimed by the original producer's distributor the day you release it.</li>
  <li><strong>Stems.zip / multitrack downloads on file-share sites.</strong> Real producers do not give away stems for free, ever. If it says "free stems," it's stolen.</li>
  <li><strong>AI-generated beats marketed as "free producer beats."</strong> They're free because they cost the uploader nothing. The structure is usually flat, the mix is brittle, and there's no human to license from when you want to actually release. You can hear it within 30 seconds — the drops don't breathe.</li>
  <li><strong>Type-beat channels with no link to a store.</strong> No store = no license path. Even if you write your best song over that beat, you'll never be able to release it legally.</li>
</ul>

${blogFigure({
  src: '/img/blog/how-to-find-mid.jpg',
  alt: 'Voice memo recording app capturing a vocal demo over a free tagged beat — the cheapest way to test if a song idea works before licensing',
  caption: 'The unglamorous habit nobody talks about: voice-memo a demo over the free version before you spend $29 on the license. The phone mic is fine. The point is commitment.',
  width: 1022, height: 576,
})}

<h2>Why recording a demo first is the move</h2>
<p>This is the part most artists skip, and it's the part that actually matters. Before you buy a license — before you book a studio, before you book a mix engineer, before you even commit to a release date — record a demo over the free tagged version. Not a polished take. A rough one. Phone mic is fine. Laptop mic is fine. The demo isn't for the world; it's for you.</p>
<p>Here's what a demo does that nothing else can:</p>

<h2>1. The beat tells you if the song exists</h2>
<p>Beats lie in the headphones. A beat can sound like the hardest thing you've ever heard while you're scrolling YouTube, then collapse the moment you try to put a vocal on it. The pocket isn't where you thought. The hook section is too short for the melody you're hearing. The energy peaks in the wrong bar. You only learn this by tracking a vocal. A 5-minute demo will save you a $99 license fee on a beat that was never going to work for your voice.</p>

<h2>2. You stop falling in love with beats and start falling in love with songs</h2>
<p>Most independent artists hoard beats. They have 200 in a folder and they've written to maybe four. The bottleneck is not access — it's commitment. A demo is a tiny act of commitment. Every time you record one, you're learning to choose. After 20 demos you can pick a beat in 30 seconds because you know what your voice does over what kind of pocket. That skill is worth more than any plug-in.</p>

<h2>3. Your topline gets better in front of a microphone, not in your notes app</h2>
<p>Lyrics written silently and lyrics written out loud are different writing. Cadence only reveals itself when you say it. Vowel choices that look fine on paper choke when you sing them. The artists who level up fastest are the ones who write into the mic, with the beat playing, take after take. The free tagged beat is the perfect playground because there's no pressure — you didn't pay for it, you're not on a session clock.</p>

<h2>4. You can A/B beats against each other with the same hook</h2>
<p>Once you've got a hook idea, throw it on three different free beats. The right beat is almost never the one you thought. This is a trick label A&Rs use constantly — they cut a hook, then audition production behind it. You can do the same in your bedroom in an hour with three free downloads.</p>

<h2>5. The demo IS your pitch</h2>
<p>If you want a placement, a feature, a manager, or a producer to take you seriously, the rough demo over a tagged beat is the asset you send. Nobody wants a Word doc of lyrics. They want to hear what you sound like. A 60-second voice memo over a free tagged beat will get a faster response from a manager than a 20-page bio.</p>

<h2>The full free-beat-to-released-song workflow</h2>
<p>Here's the loop that actually ships music:</p>
<ol>
  <li><strong>Pull 5 free beats this week</strong> from the sources above. Pick beats from at least two genres — your range is wider than you think.</li>
  <li><strong>Demo all 5</strong> in one sitting. Phone, laptop, voice memo, anything. Don't write — improvise melodies and gibberish syllables to find the cadence first.</li>
  <li><strong>Pick the one that wrote itself.</strong> There's always one. The song that came out almost without thinking is the song.</li>
  <li><strong>Write the real lyric</strong> the next day, fresh ears.</li>
  <li><strong>Re-demo it properly</strong> — still rough, but with the real lyric.</li>
  <li><strong>Now buy the license.</strong> Once you have a demo you believe in, the $29.99 lease is the easiest decision you'll make all month. Get the untagged WAV/MP3 + license PDF, take it to mix.</li>
  <li><strong>Release</strong> with the producer credit honored ("Prod. by O'Neil" or whoever made the beat).</li>
</ol>
<p>That loop is the difference between an artist with 200 beats and zero songs and an artist with one released song this month. We've broken down the legal side of the free-to-paid jump in <a href="/blog/free-beats-vs-paid-tagged-mp3-explained">Free Beats vs Paid: What Artists Get with the Tagged MP3</a> — read that next if you're unclear what the tag actually allows.</p>

<h2>Where O'Neil Beats fits in</h2>
<p>The free section at <a href="/">oneilbeats.store</a> exists for exactly this loop. We push tagged MP3s of new reggaeton, trap, and hip-hop instrumentals every week, with a Free Beat Friday email going out to subscribers. The whole point is so artists can demo in private, find the song, and then license cleanly when they're ready. Browse the genre catalogs — <a href="/reggaeton-beats">reggaeton</a>, <a href="/trap-beats">trap</a>, <a href="/perreo-beats">perreo</a>, <a href="/dark-trap-beats">dark trap</a> — every beat has a tagged preview you can grab to demo.</p>

<h2>Bottom line</h2>
<p>Free beats are not a substitute for paid beats. They're a substitute for a blank canvas. Use them to write, to test, to pitch, to find your voice. The artists who treat free beats as practice tools and paid beats as release tools are the ones who actually finish songs. The ones who download 500 beats and never record a demo are the ones still calling themselves "artists" with no released music in 2027.</p>
<p>Pick a beat. Open the voice memo app. Press record.</p>

<p class="cta-block"><a href="/#free-signup" class="cta-link">Get a Free Beat Every Friday →</a> · <a href="/" class="cta-link">Browse all beats</a> · <a href="/blog/free-beats-vs-paid-tagged-mp3-explained" class="cta-link">Tagged MP3 explained</a></p>
`,
  },
  {
    slug: 'ai-reggaeton-beats-2026-curated-vs-free',
    title: "AI Reggaeton Beats in 2026: Why Curated Producer Beats Are Winning the AI Music War",
    metaTitle: "AI Reggaeton Beats 2026: The Producer Edge",
    metaDescription: "Universal settled with Udio. Warner settled with Suno. Spotify rolled out AI Credits. Here's why curated, producer-made AI-augmented reggaeton beats with real licenses are the only AI music that survives 2026 — for artists and indie producers.",
    excerpt: "Universal settled with Udio. Warner settled with Suno. Spotify rolled out AI Credits. Latin streaming is being flooded with raw AI dembow. Here's why curated, producer-made AI beats with real licenses are the only AI music that survives 2026 — and how artists and indie producers can win the next year.",
    publishedDate: '2026-05-05',
    type: 'Article',
    bodyHtml: `
<p class="lead">In the last six months the AI music industry stopped being a Wild West and started being a boardroom. Universal Music settled with Udio. Warner Music settled with Suno. Sony is still in court. Spotify rolled out AI Credits. And underneath all of it, Latin streaming is being flooded with raw, free AI-generated reggaeton that pays the producer nothing and the artist less. This is a guide for the people who actually want to ship music in 2026 — independent artists, indie producers, songwriters — and the case for why AI-augmented beats curated by a real producer are about to become the only kind of AI music that survives the next twelve months.</p>

${blogFigure({
  src: '/img/blog/ai-reggaeton-hero.jpg',
  alt: 'AI reggaeton beats 2026 — split view of free AI music generator output versus a professional producer at a hardware mixing console',
  caption: 'The 2026 split: raw AI generation on one screen, curated producer-made reggaeton beats on the other. Suno and Udio fill the catalog. Producers fill the song.',
  width: 1059, height: 556, hero: true,
})}

<h2>The 2025-2026 power-shift: labels just bought their seat at the AI table</h2>
<p>Three legal events in the last year reset the AI music landscape:</p>
<ul>
  <li><strong>October 29, 2025 — Universal Music settled with Udio.</strong> The deal includes both a compensatory payment and a licensing partnership for a joint AI music platform launching in 2026. Translation: UMG is going to own a piece of every AI track Udio generates from here on.</li>
  <li><strong>November 25, 2025 — Warner Music settled with Suno.</strong> Multi-million dollar settlement plus a "first-of-its-kind partnership" for music creation. Suno also picked up Songkick from Warner as part of the deal. Same pattern — labels trading lawsuits for ownership stakes in the AI catalog.</li>
  <li><strong>April 2026 — Sony is still litigating</strong> against both Suno and Udio, and the licensing talks between Suno and the remaining majors are reportedly stalled over whether users should even be allowed to download what they generate. UMG wants AI-made tracks confined inside the Suno app. Suno is pushing back. A pivotal fair-use ruling is expected this summer.</li>
</ul>
<p>Strip the legalese off and here's what just happened: the major labels have absorbed the AI music tools into their catalog economy. The "free AI music" era — the one that gave us 2024–2025 of unlimited Suno generations with no copyright friction — is being dismantled in real time. The labels won the lawsuits without having to win the lawsuits. They just bought in.</p>

<h2>What that actually means for independent artists trying to release music</h2>
<p>The platforms moved before the lawsuits even closed. As of May 2026 these are the rules at the gate:</p>
<ul>
  <li><strong>Spotify (September 25, 2025 policy + April 16, 2026 AI Credits beta).</strong> AI music is allowed, but with three pillars of enforcement: (1) unauthorized AI voice clones get pulled, (2) spam filtering targets mass uploads and duplicate AI tracks, (3) DDEX AI disclosure requires distributors to flag AI-generated contributions in song credits. Pure-AI tracks are not banned — but they're labelled, and the spam filter does not love them.</li>
  <li><strong>DistroKid 2026 policy.</strong> AI-generated music is accepted only when (a) you actually own commercial rights from the AI tool, (b) you don't mimic real artists, and (c) you don't list the AI tool ("Suno", "Udio") as a credited creator. Submissions that fail any of those tests get rejected or removed after release — yes, after release, with takedown emails and royalties clawed back.</li>
  <li><strong>Apple Music, Tidal, Deezer.</strong> All three followed Spotify's lead on AI disclosure between October 2025 and February 2026. Deezer in particular reported that as of early 2025, around 18% of new daily uploads in Latin America were detected as fully AI-generated — and announced it would no longer pay royalties on tracks flagged as undisclosed AI.</li>
</ul>
<p>If you are an artist planning a 2026 release, the takeaway is: pure AI tracks (Suno output uploaded as-is) face platform downranking, royalty risk, and a real chance of takedown. Producer-made beats — even ones that started with AI ideation — clear the bar because there's a human chain of rights and a license PDF you can produce on demand.</p>

<h2>The Latin music problem nobody is talking about</h2>
<p>Reggaeton, dembow, Latin trap, bachata, and corridos tumbados are some of the fastest-growing genres on streaming in 2026. They're also the most aggressively flooded with AI slop. Reporters at <em>Rest of World</em> and complaints from the Sociedad de Autores en español documented late-2025 waves of fully-AI dembow and reggaeton tracks pushed to Spotify and Deezer in Latin America by spam farms — drowning out independent Latin artists and shrinking royalty pools.</p>
<p>The reason is that Latin urban music is — from a pure-modeling standpoint — easy to fake at the surface. The dembow pattern is rigid. The chord palette is small. The vocal phrasing is repetitive. Suno can generate a "reggaeton beat" that sounds passable in five seconds. What it cannot generate is the curated taste, the regional pocket (Puerto Rican vs Dominican vs Colombian vs Mexican Trapeton), the trend-tracking, or the licensing paperwork that makes the beat actually usable in 2026.</p>
<p>That gap — between "AI can fake a reggaeton beat" and "the beat clears policy and helps an artist actually ship a song" — is the entire opportunity for curated, human-touched AI production. It's also the opportunity that the labels are trying to close before independents realize it exists.</p>

${blogFigure({
  src: '/img/blog/ai-reggaeton-mid.jpg',
  alt: 'Major music label boardroom signing an AI music platform licensing deal in 2026 — symbolic of UMG-Udio and Warner-Suno settlements',
  caption: 'The settlements you only hear about on legal blogs: UMG buying into Udio, Warner buying into Suno. The labels did not lose the AI music war — they bought a seat at the table.',
  width: 1022, height: 576,
})}

<h2>What "AI-augmented" actually means (and why it's not the same as Suno)</h2>
<p>People hear "AI beats" and assume one thing: a model generates a track, you download it, you upload it, you collect (or fail to collect) royalties. That's the cheap version. The version that wins in 2026 is different.</p>
<p>AI-augmented production, the way an active producer does it, looks like this:</p>
<ol>
  <li><strong>AI is the idea generator, not the deliverable.</strong> A producer might use Suno or a similar tool to spit out a sketch — a chord pad, a melodic motif, a percussive idea — that captures a current vibe. The AI output is a starting point, not the master.</li>
  <li><strong>The producer rebuilds, replaces, and re-mixes.</strong> Drums get re-programmed in the producer's DAW. The 808 gets swapped for a real one with proper sub-mix. The arrangement gets cut and shaped — intro, verse pocket, hook, drop, breakdown — to match how artists actually structure modern reggaeton or Latin trap.</li>
  <li><strong>Real mastering on real monitors.</strong> AI tools master to a generic loudness target with phasey stereo and brittle highs. A producer masters to platform LUFS specs (Spotify's −14, YouTube's −13) on calibrated monitors so the beat actually translates from earbuds to club PA.</li>
  <li><strong>Genre and mood curation by hand.</strong> A producer decides this one is a Perreo Hardcore at 96 BPM in F# minor. The next is a Dembow Dominicano at 108 with a flute hook. The one after is a Trapeton at 90 with a Puerto Rican pocket. AI doesn't curate — it generates an average. Curation is the human's job.</li>
  <li><strong>Licensing paperwork — the part nobody else sees.</strong> Lease, Premium Lease, Stems, Exclusive — each tier with a real PDF, a clear scope, a producer credit, and a documented chain of rights. That paperwork is what stops a song from getting taken down on release day.</li>
</ol>
<p>That's the difference. An AI-augmented beat from a producer is a product. A raw Suno generation is a candidate.</p>

<h2>Suno vs O'Neil Beats — head to head, no spin</h2>
<p>Let's be specific. Here's what an artist actually gets in each scenario:</p>
<ul>
  <li><strong>Generation vs. curation.</strong> Suno will generate 50 reggaeton candidates in an hour. We listen to 50 candidates, throw away 47, finish 3, post 1. The catalog is opinionated. The catalog being opinionated is what makes a song chosen from it land.</li>
  <li><strong>License clarity.</strong> Suno's terms in 2026 are still being renegotiated with the majors. There's no consensus on whether you can download an AI-generated track and release it commercially without label exposure. We give you a Lease, Premium, Stems, or Exclusive license — a PDF, a contract, a producer credit, a clear scope. Your distributor never blinks.</li>
  <li><strong>Mix quality.</strong> Suno's stereo image is narrow, the bass is software-clean, and the highs hiss when you push them. A producer-mixed beat has real low-end, defined stereo, and headroom that survives platform compression.</li>
  <li><strong>Trend-tracking.</strong> Suno generates from training data that's months or years behind. A producer follows what's actually moving on Latin charts <em>this week</em> — what Bad Bunny just dropped, what Feid is teasing, what's spiking on TikTok in Medellín. The catalog reflects current sound, not 2023 average.</li>
  <li><strong>Genre depth.</strong> Suno gives you "reggaeton". We give you Perreo, Perreo Hardcore, Perreo Sucio, Dembow, Dembow Dominicano, Reggaeton Romántico, Reggaeton Lento, Reggaeton Pop, Old School Reggaeton, Modern Reggaeton, Sensual Reggaeton, Latin Trap, Neoperreo, Reggaeton Drill, Reggaeton Mambo, Cubaton, and Trapeton. Specificity is the new SEO.</li>
  <li><strong>Trust + a name.</strong> Releasing under a real producer credit ("Prod. by O'Neil") is something Spotify, Apple Music, your distributor, and your future label all understand. Releasing with no producer credit on a Suno-stamped track is a flag.</li>
</ul>

<h2>For artists: how to actually use AI beats in 2026 without getting flagged</h2>
<p>If you're an artist trying to release this year, the playbook is short:</p>
<ol>
  <li><strong>Don't upload raw Suno output.</strong> Even if it sounds great, the platform metadata and DDEX disclosure rules will catch up to it. The royalty math doesn't work.</li>
  <li><strong>Buy curated, producer-made beats with a real license PDF.</strong> Whether it's our store or another active independent producer, the license is the moat. Browse the live catalog at <a href="/">oneilbeats.store</a> — every beat has a tagged preview you can demo over before you commit. Filter by <a href="/reggaeton-beats">reggaeton</a>, <a href="/trap-beats">trap</a>, <a href="/perreo-beats">perreo</a>, <a href="/dancehall-beats">dancehall</a>, or <a href="/dark-trap-beats">dark trap</a>.</li>
  <li><strong>Demo before you license.</strong> The free tagged version is enough to know if the song works for your voice. We covered this end-to-end in <a href="/blog/how-to-find-free-beats-2026-and-why-demos-matter">How to Find Free Beats in 2026</a>.</li>
  <li><strong>Disclose what you should disclose.</strong> If a beat was AI-augmented, the producer's license already covers the rights chain. You disclose the producer credit. You don't disclose "made with AI" because the human-final-product is what you actually licensed.</li>
  <li><strong>Pick the right license tier.</strong> Lease for first releases. Premium for radio + WAV. Stems for vocalists who want to mix themselves. Exclusive when the song is the song. Full breakdown in <a href="/blog/lease-vs-exclusive-beat-license-guide">Lease vs Exclusive — What License Should You Buy?</a>.</li>
</ol>

<h2>For producers reading this: the real strategy for 2026</h2>
<p>If you make beats, the AI war is not a threat — it's a sorting event. Producers who treat AI as a starting point and ship curated, mastered, licensed product will eat. Producers who treat AI as a shortcut to volume will get drowned in their own slop. Concretely:</p>
<ul>
  <li><strong>Use AI for ideation only.</strong> Sketches, motifs, melodic seeds. Throw 90% of what it gives you in the trash.</li>
  <li><strong>Mix on real monitors. Master to platform LUFS specs.</strong> The audible quality gap is the moat AI cannot close in 2026.</li>
  <li><strong>Document your process.</strong> Show the studio, show the gear, show the human. The "Prod. by [your name]" credit is now a brand asset because every Suno upload by definition has no human brand attached.</li>
  <li><strong>License clearly. Always.</strong> A clean license PDF is the platform-policy moat. It's also what gets your beats placed in label sessions when those calls start coming.</li>
  <li><strong>Pick a lane and own it.</strong> Reggaeton, trap, drill, Latin urban — depth beats breadth. Subgenre specificity wins SEO. Suno can mimic one of those lanes; it cannot mimic eighteen subgenres deep.</li>
</ul>

<h2>The bottom line</h2>
<p>The AI music war of 2024–2025 was decided in 2025 boardrooms, not in code. Universal owns a stake in Udio. Warner owns a stake in Suno. Sony will likely own a stake in something by year-end. The platforms have moved policy to require disclosure, ownership, and a human chain. Latin streaming is being flooded with AI dembow that pays nobody.</p>
<p>The play that survives 2026 is the one that sits in the middle: AI as a tool, human producer as the curator, license PDF as the moat. That's not a Suno track. That's not a label-platform AI service. That's the indie producer with a working ear, a real DAW, and a store with clear license tiers — the version of "AI beats" that an artist can actually release without fear of takedown, royalty clawback, or a label lawyer's email.</p>
<p>If you're an artist, browse the catalog and pick a song. If you're a producer, sharpen your lane and ship curated work. The window for "free AI generation" as a viable release strategy is closing in 2026. The window for human-curated, AI-augmented production is opening at the same time. Walk through it.</p>

<p class="cta-block"><a href="/" class="cta-link">Browse the catalog →</a> · <a href="/#free-signup" class="cta-link">Free Beat Friday email</a> · <a href="/blog/lease-vs-exclusive-beat-license-guide" class="cta-link">License tiers explained</a> · <a href="/reggaeton-beats" class="cta-link">Reggaeton beats</a></p>
`,
  },
];

// Render a single blog post.
function renderBlogPost(template, post) {
  const url = `${SITE_URL}/blog/${post.slug}`;
  // metaTitle = SERP-trimmed (≤55 chars, no suffix) version for <title>/og:title.
  // Article H1 keeps post.title (longer, more descriptive). Falls back if absent.
  const titleTag = post.metaTitle
    ? `${post.metaTitle} | O'Neil Beats`
    : `${post.title} | O'Neil Beats Blog`;
  // Meta description: 140-160 chars max — Google truncates the rest.
  const descRaw = (post.metaDescription || post.excerpt).replace(/\s+/g, ' ').trim();
  const desc = descRaw.length > 160 ? descRaw.slice(0, 157).trimEnd() + '…' : descRaw;

  let html = template;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(titleTag)}</title>`);
  html = html.replace(/<meta\s+name="description"\s+content="[^"]*">/i, `<meta name="description" content="${esc(desc)}">`);
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*">/i, `<link rel="canonical" href="${url}">`);
  html = html.replace(/<meta\s+property="og:url"\s+content="[^"]*">/i, `<meta property="og:url" content="${url}">`);
  html = html.replace(/<meta\s+property="og:title"\s+content="[^"]*">/i, `<meta property="og:title" content="${esc(titleTag)}">`);
  html = html.replace(/<meta\s+property="og:description"\s+content="[^"]*">/i, `<meta property="og:description" content="${esc(desc)}">`);
  html = html.replace(/<meta\s+property="og:type"\s+content="website">/i, `<meta property="og:type" content="article">`);
  html = html.replace(/<meta\s+name="twitter:title"\s+content="[^"]*">/i, `<meta name="twitter:title" content="${esc(titleTag)}">`);
  html = html.replace(/<meta\s+name="twitter:description"\s+content="[^"]*">/i, `<meta name="twitter:description" content="${esc(desc)}">`);

  // Demote homepage hero H1 to H2 (article supplies its own H1 below).
  html = html.replace(/<h1\s+class="hero-h1-seo"\s+id="page-h1">([\s\S]*?)<\/h1>/i,
    '<h2 class="hero-h1-seo" id="page-h1">$1</h2>');
  // Strip inherited broken hreflang — blog posts have no Spanish equivalent.
  html = html.replace(/\s*<link\s+rel="alternate"\s+hreflang="(?:en|es|x-default)"[^>]*>/gi, '');

  // Article (or HowTo) + BreadcrumbList schema
  const baseSchema = {
    '@context': 'https://schema.org',
    '@type': post.type === 'HowTo' ? 'HowTo' : 'Article',
    headline: post.title,
    description: desc,
    url,
    author: { '@type': 'Person', name: "O'Neil", url: SITE_URL + '/#about' },
    publisher: { '@type': 'Organization', name: "O'Neil Beats", url: SITE_URL, logo: { '@type': 'ImageObject', url: SITE_URL + '/icon.png' } },
    image: SITE_URL + '/og-image.jpg',
    datePublished: post.publishedDate,
    dateModified: post.publishedDate,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
  };
  if (post.type === 'HowTo' && post.howToSteps) {
    baseSchema.totalTime = post.estimatedTime || 'PT30M';
    baseSchema.step = post.howToSteps.map((s, i) => ({
      '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text, url: `${url}#step${i + 1}`,
    }));
  }
  const breadcrumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: SITE_URL + '/blog' },
      { '@type': 'ListItem', position: 3, name: post.title, item: url },
    ],
  };
  const ldBlock = `<script type="application/ld+json" data-blog="${esc(post.slug)}">${JSON.stringify(baseSchema)}</script>` +
    `<script type="application/ld+json" data-blog="${esc(post.slug)}">${JSON.stringify(breadcrumbs)}</script>`;
  html = html.replace(/<\/head>/i, ldBlock + '</head>');

  // Replace the SPA body with the actual blog article. The SPA stays mounted
  // (header, footer, player) but the catalog/hero are hidden in favor of the
  // article content. We do this by injecting a stylesheet override + the
  // article HTML right after <body>, plus a small script that hides the
  // homepage sections that don't belong on a blog post.
  const articleHtml = `
<style>
  .blog-article{max-width:760px;margin:32px auto 60px;padding:0 24px;color:var(--text)}
  .blog-bc{font-size:11px;color:var(--dim);letter-spacing:1px;text-transform:uppercase;margin-bottom:14px;font-weight:700}
  .blog-bc a{color:var(--dim);text-decoration:none}.blog-bc a:hover{color:var(--accent)}
  .blog-article h1{font-size:34px;font-weight:900;line-height:1.18;letter-spacing:-.5px;margin:0 0 12px}
  .blog-article .blog-meta{font-size:13px;color:var(--dim);margin-bottom:28px}
  .blog-article p{font-size:16px;line-height:1.75;margin:0 0 18px;color:var(--text)}
  .blog-article p.lead{font-size:18px;color:var(--dim)}
  .blog-article h2{font-size:24px;font-weight:800;letter-spacing:-.3px;margin:34px 0 14px;color:var(--text)}
  .blog-article ul,.blog-article ol{margin:0 0 20px;padding-left:24px;color:var(--text);font-size:16px;line-height:1.75}
  .blog-article li{margin-bottom:8px}
  .blog-article a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
  .blog-article a:hover{color:var(--gold)}
  .blog-article p.cta-block{margin-top:32px;padding:18px;background:linear-gradient(135deg,rgba(230,57,70,.08),rgba(245,158,11,.06));border:1px solid var(--border);border-radius:12px;text-align:center;font-size:15px}
  .blog-article p.cta-block .cta-link{margin:0 8px;font-weight:800}
  /* Figures + inline article images. The img width/height attributes carry the
     intrinsic aspect ratio so the browser reserves space pre-load (no CLS).
     We deliberately do NOT set CSS aspect-ratio or object-fit here — Pollinations
     delivers slightly different dimensions than we requested (e.g. 1022×576
     instead of 1100×620) and forcing a CSS ratio caused horizontal cropping
     that read as "stretched". Letting images render at their natural ratio
     looks correct on every post. */
  .blog-article figure{margin:28px 0 30px;border-radius:14px;overflow:hidden;background:var(--surface2);border:1px solid var(--border)}
  .blog-article figure img{display:block;width:100%;height:auto;background:var(--surface2);color:transparent}
  .blog-article figure figcaption{padding:10px 14px 12px;font-size:12px;color:var(--dim);font-style:italic;border-top:1px solid var(--border);background:var(--surface);line-height:1.5}
  .blog-article figure.hero{margin:8px 0 28px}
  .blog-related{max-width:760px;margin:0 auto 60px;padding:0 24px}
  .blog-related h3{font-size:14px;font-weight:800;letter-spacing:1.5px;color:var(--dim);text-transform:uppercase;margin-bottom:14px}
  .blog-related-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
  .blog-related-card{display:block;padding:14px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;text-decoration:none;color:var(--text);transition:all .2s}
  .blog-related-card:hover{border-color:var(--accent);background:rgba(230,57,70,.06)}
  .blog-related-card-title{font-size:14px;font-weight:800;margin-bottom:4px}
  .blog-related-card-desc{font-size:12px;color:var(--dim);line-height:1.5}
</style>
<article class="blog-article" itemscope itemtype="https://schema.org/${post.type === 'HowTo' ? 'HowTo' : 'Article'}">
  <nav class="blog-bc" aria-label="Breadcrumb"><a href="/">Home</a> · <a href="/blog">Blog</a> · ${esc(post.title)}</nav>
  <h1 itemprop="headline">${esc(post.title)}</h1>
  <div class="blog-meta">By <a href="/#about">O'Neil</a> · Published ${esc(post.publishedDate)} · <a href="/">O'Neil Beats</a></div>
  ${post.bodyHtml}
</article>
<aside class="blog-related" aria-label="Related reading">
  <h3>More from the blog</h3>
  <div class="blog-related-grid">
    ${BLOG_POSTS.filter(p => p.slug !== post.slug).map(p => `
      <a class="blog-related-card" href="/blog/${p.slug}">
        <div class="blog-related-card-title">${esc(p.title)}</div>
        <div class="blog-related-card-desc">${esc(p.excerpt.slice(0, 120))}…</div>
      </a>`).join('')}
  </div>
</aside>
<script>
// Hide the homepage's hero/catalog/license/faq sections — they belong on /, not on a blog post.
(function(){
  function hideHomepageSections(){
    var ids = ['hero-banner-wrap','catalog','licenses','faq','about','orders','free-signup','free-beat-banner'];
    ids.forEach(function(id){ var el = document.getElementById(id); if (el) el.style.display = 'none'; });
    // Also hide hero banner + the .layout (catalog grid wrapper)
    document.querySelectorAll('.hero-banner, .layout, [class*="catalog"], [aria-labelledby="catalog-heading"]').forEach(function(el){ el.style.display = 'none'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideHomepageSections);
  else hideHomepageSections();
})();
</script>`;
  // Inject after </header> so the article renders below the nav, not above it.
  // Falls back to <body> position if no </header> present.
  if (/<\/header>/i.test(html)) {
    html = html.replace(/<\/header>/i, '</header>' + articleHtml);
  } else {
    html = html.replace(/<body([^>]*)>/i, `<body$1>${articleHtml}`);
  }

  return html;
}

// Render the blog index page listing all posts.
function renderBlogIndex(template) {
  const url = `${SITE_URL}/blog`;
  // <title> trimmed to ~55 chars so it doesn't get truncated in SERPs.
  const title = "Blog — Beat Licensing & Songwriting Guides | O'Neil Beats";
  // Page subtitle / on-page intro (longer copy, kept for the visible card).
  const intro = "Articles for artists buying beats: license tier explainers, songwriting walkthroughs, and free-beat guides. Written by O'Neil — independent producer of reggaeton, trap, and hip-hop instrumentals.";
  // Meta description trimmed to ~155 chars.
  const desc = "Beat licensing guides, songwriting walkthroughs, and free-beat advice from O'Neil — independent producer of reggaeton, trap & hip-hop instrumentals.";

  let html = template;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(title)}</title>`);
  html = html.replace(/<meta\s+name="description"\s+content="[^"]*">/i, `<meta name="description" content="${esc(desc)}">`);
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*">/i, `<link rel="canonical" href="${url}">`);
  html = html.replace(/<meta\s+property="og:url"\s+content="[^"]*">/i, `<meta property="og:url" content="${url}">`);
  html = html.replace(/<meta\s+property="og:title"\s+content="[^"]*">/i, `<meta property="og:title" content="${esc(title)}">`);
  html = html.replace(/<meta\s+property="og:description"\s+content="[^"]*">/i, `<meta property="og:description" content="${esc(desc)}">`);

  // Demote homepage hero H1 to H2 (blog index supplies its own H1 below).
  html = html.replace(/<h1\s+class="hero-h1-seo"\s+id="page-h1">([\s\S]*?)<\/h1>/i,
    '<h2 class="hero-h1-seo" id="page-h1">$1</h2>');
  // Strip inherited broken hreflang.
  html = html.replace(/\s*<link\s+rel="alternate"\s+hreflang="(?:en|es|x-default)"[^>]*>/gi, '');

  const blogSchema = {
    '@context': 'https://schema.org', '@type': 'Blog',
    name: "O'Neil Beats Blog", url, description: desc,
    publisher: { '@type': 'Organization', name: "O'Neil Beats", url: SITE_URL },
    blogPost: BLOG_POSTS.map(p => ({
      '@type': p.type === 'HowTo' ? 'HowTo' : 'BlogPosting',
      headline: p.title, url: `${SITE_URL}/blog/${p.slug}`, datePublished: p.publishedDate,
      author: { '@type': 'Person', name: "O'Neil" }, description: p.excerpt,
    })),
  };
  html = html.replace(/<\/head>/i, `<script type="application/ld+json" data-blog-index="true">${JSON.stringify(blogSchema)}</script></head>`);

  const indexHtml = `
<style>
  .blog-index{max-width:980px;margin:32px auto 60px;padding:0 24px;color:var(--text)}
  .blog-index-bc{font-size:11px;color:var(--dim);letter-spacing:1px;text-transform:uppercase;margin-bottom:14px;font-weight:700}
  .blog-index-bc a{color:var(--dim);text-decoration:none}.blog-index-bc a:hover{color:var(--accent)}
  .blog-index h1{font-size:34px;font-weight:900;letter-spacing:-.5px;margin:0 0 8px}
  .blog-index-sub{font-size:15px;color:var(--dim);margin-bottom:32px;max-width:640px;line-height:1.6}
  .blog-index-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
  .blog-index-card{display:block;padding:22px;background:var(--surface);border:1px solid var(--border);border-radius:14px;text-decoration:none;color:var(--text);transition:all .2s}
  .blog-index-card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 12px 32px rgba(230,57,70,.12)}
  .blog-index-card-tag{display:inline-block;font-size:10px;font-weight:800;color:var(--gold);letter-spacing:1.5px;margin-bottom:10px;text-transform:uppercase}
  .blog-index-card-title{font-size:18px;font-weight:800;line-height:1.3;margin-bottom:10px;letter-spacing:-.2px}
  .blog-index-card-excerpt{font-size:13px;color:var(--dim);line-height:1.6;margin-bottom:14px}
  .blog-index-card-meta{font-size:11px;color:var(--dim);font-weight:600}
</style>
<section class="blog-index">
  <nav class="blog-index-bc" aria-label="Breadcrumb"><a href="/">Home</a> · Blog</nav>
  <h1>O'Neil Beats Blog</h1>
  <p class="blog-index-sub">${esc(intro)}</p>
  <div class="blog-index-grid">
    ${BLOG_POSTS.map(p => `
      <a class="blog-index-card" href="/blog/${p.slug}">
        <div class="blog-index-card-tag">${p.type === 'HowTo' ? '📋 How-To' : '📖 Guide'}</div>
        <div class="blog-index-card-title">${esc(p.title)}</div>
        <div class="blog-index-card-excerpt">${esc(p.excerpt)}</div>
        <div class="blog-index-card-meta">By O'Neil · ${esc(p.publishedDate)}</div>
      </a>`).join('')}
  </div>
</section>
<script>
(function(){
  function hide(){ var ids=['hero-banner-wrap','catalog','licenses','faq','about','orders','free-signup','free-beat-banner']; ids.forEach(function(id){var el=document.getElementById(id); if(el)el.style.display='none';}); document.querySelectorAll('.hero-banner, .layout, [class*="catalog"]').forEach(function(el){ el.style.display='none'; }); }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hide); else hide();
})();
</script>`;
  if (/<\/header>/i.test(html)) {
    html = html.replace(/<\/header>/i, '</header>' + indexHtml);
  } else {
    html = html.replace(/<body([^>]*)>/i, `<body$1>${indexHtml}`);
  }
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDING PAGES — type-beat + genre/subgenre/mood
// ─────────────────────────────────────────────────────────────────────────────
//
// These are catalog-style pages, NOT single-beat pages. Each is a curated view
// of the catalog filtered by criteria (artist sound, genre, subgenre, etc.) and
// targets a specific Google search intent ("bad bunny type beat", "trap beats",
// "perreo beats"). Same template-injection approach as per-beat pages.
//
// The SPA renders the full catalog visually; the sr-only block carries the
// ranking signal for crawlers (H1, intro paragraph, list of matching beats).
//
// Add new artists / genres by extending TYPE_BEAT_ARTISTS / GENRE_PAGES below.

const TYPE_BEAT_ARTISTS = [
  // ── Reggaeton (matches the catalog skew) ──
  { artist: 'Bad Bunny',       slug: 'bad-bunny-type-beat',      intro: 'Bad Bunny redefined modern reggaeton with melodic hooks, half-sung verses, and global crossover production. These instrumentals match that lane — modern reggaeton with smooth, polished flow.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || /smooth|melodic/i.test(b.mood || '')),
    body: `<h2>What makes a Bad Bunny type beat</h2>
<p>A true Bad Bunny type beat lives in the modern reggaeton lane: dembow pattern at 90–100 BPM, melodic minor-key chord work, smooth Latin percussion, and just enough space in the arrangement for half-sung half-rapped vocals to breathe. The signature is the contrast — heavy 808-backed lows under airy, slightly nostalgic synth pads. Drops are subtle, not explosive; the energy comes from melody and pocket, not aggression.</p>
<h2>How to write to a Bad Bunny instrumental</h2>
<p>Bad Bunny rarely uses a traditional verse–chorus structure. He layers conversational verses with a melodic refrain that returns three or four times. When you write to one of these instrumentals, lean melodic — try humming the topline first, then write the lyric to the cadence. Stay in your real vocal range; the auto-tune is a polish, not a crutch. Spanish, English, or Spanglish all work — Bad Bunny crossed over precisely by refusing to choose.</p>
<h2>BPM, key, and mix notes</h2>
<p>Most beats in this lane sit between 88 BPM and 100 BPM, in minor keys (A minor, F minor, and C# minor are common). When you license one of these instrumentals, ask for the WAV (Premium Lease or above) — the modern reggaeton mix sits or falls on the low-end weight, and an MP3 loses some of that headroom. If you're singing more than rapping, the stems package gives you control over how loud the melodic synths sit behind your vocal.</p>
<h2>License and use</h2>
<p>All Bad Bunny type beats here are non-exclusive leases unless you grab the Exclusive tier. Lease ($29.99) is fine for a SoundCloud single; Premium Lease ($99.99) covers unlimited streams on Spotify, Apple Music, and YouTube; Exclusive removes the beat from the store entirely. <a href="/blog/lease-vs-exclusive-beat-license-guide">See the full license breakdown</a>. New Bad Bunny–style reggaeton drops weekly — sign up for the <a href="/#free-signup">Free Beat Friday email</a> to grab tagged previews before they hit the store.</p>` },
  { artist: 'Feid',            slug: 'feid-type-beat',           intro: 'Feid (FERXXO) made melodic perreo and modern reggaeton with airy synths and conversational flows the global standard. These beats fit that smooth, vibe-heavy sound.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || b.subgenre === 'Perreo' || /smooth|chill|romantic/i.test(b.mood || '')),
    body: `<h2>The Feid (FERXXO) sound, broken down</h2>
<p>Feid built his global wave on a very specific palette: airy reverb-soaked synth pads, conversational mid-tempo dembow, soft 808s, and chord progressions that feel a little melancholic even when the song is celebratory. The vocal sits very forward in the mix — that's a production choice you can copy by asking your engineer to keep your lead vocal dry-ish and centered. Tempo is usually 90–95 BPM. Keys lean minor.</p>
<h2>Writing in the FERXXO lane</h2>
<p>Feid's lyrics are conversational, slightly understated, and almost never punch you in the face with bravado. Try writing the way you'd actually talk to someone — observation, small detail, a hook that sounds like a half-thought rather than a slogan. The melodic pocket sits just behind the dembow snare; if you find the snare and write to a hair behind it, you'll naturally land in the FERXXO cadence. Verde es el color — green Auto-Tune polish helps but it's not the trick.</p>
<h2>Best license tier for a Feid-style release</h2>
<p>Because the genre depends on the mix breathing, push for the Premium Lease ($99.99) — you get the WAV, which preserves the soft top-end of the synth pads. If you're recording yourself and mixing in your bedroom, the stems package ($199.99) lets you ride the perreo backbone separately from the melodic layer, which is where most amateur Feid-style mixes lose the magic. <a href="/blog/lease-vs-exclusive-beat-license-guide">License tier breakdown</a>.</p>
<h2>Related sounds and pages</h2>
<p>If the Feid lane fits your voice, also explore <a href="/perreo-beats">perreo beats</a>, <a href="/modern-reggaeton-beats">modern reggaeton</a>, <a href="/smooth-reggaeton-beats">smooth reggaeton</a>, and the <a href="/rauw-alejandro-type-beat">Rauw Alejandro type beat</a> page — same melodic family, slightly different palettes.</p>` },
  { artist: 'Rauw Alejandro',  slug: 'rauw-alejandro-type-beat', intro: 'Rauw Alejandro fuses modern reggaeton, R&B, and electronic textures into hits that work on radio and the club. Pick beats with melodic chord work and smooth percussion.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || b.subgenre === 'Reggaeton Pop' || /smooth|romantic|sensual/i.test(b.mood || '')) },
  { artist: 'Karol G',         slug: 'karol-g-type-beat',        intro: 'Karol G brought powerful vocals, perreo energy, and reggaeton-pop crossover to global stages. Match her energy with high-impact reggaeton and reggaeton-pop instrumentals.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Reggaeton Pop' || b.subgenre === 'Modern Reggaeton' || /energetic|powerful|bouncy/i.test(b.mood || '')),
    body: `<h2>What a Karol G type beat actually sounds like</h2>
<p>Karol G's catalog spans hard perreo, pop-leaning reggaeton, bachata-influenced ballads, and full crossover anthems. The constant is the vocal — she sits on top of a beat with full chest voice, so the production has to leave a clear lane in the mid-range for her. Most of her hit instrumentals run 92–98 BPM, sit in minor keys, and combine bouncy classic dembow energy with cleaner, more pop-polished mixing than older reggaeton.</p>
<h2>Writing for big vocals</h2>
<p>If you're a vocalist with real range, this is your lane. The trick is to commit. Karol G doesn't whisper through hooks — she sells them. When you write to a Karol G type instrumental, draft your hook melody first and make sure it's something you can hit at full volume. Verses can be more melodic and conversational, but the chorus is where the song lives. Also: write a pre-chorus. Most Karol G songs use a 4-bar lift before the drop, and that lift is where amateur songwriters give up.</p>
<h2>Mix and license</h2>
<p>Karol G's mixes are loud, present, and pop-radio competitive. To get there from one of these instrumentals, you need the WAV (Premium Lease, $99.99) at minimum, and ideally an engineer who has mixed Latin pop before. The stems package ($199.99) is worth it if you want to push the reggaeton-pop crossover even harder — you can boost the percussion bus or pull back the synth pads depending on what your vocal needs.</p>
<h2>Related</h2>
<p>Pair this page with <a href="/reggaeton-pop-beats">reggaeton-pop beats</a>, <a href="/energetic-reggaeton-beats">energetic reggaeton</a>, and <a href="/perreo-beats">perreo beats</a>. For Spanish queries, see <a href="/comprar-beats-de-reggaeton">Comprar beats de reggaeton</a>.</p>` },
  { artist: 'Myke Towers',     slug: 'myke-towers-type-beat',    intro: 'Myke Towers blends reggaeton, Latin trap, and conscious lyricism. These instrumentals fit his lane — modern reggaeton with strong low-end and smooth melodic loops.',
    filter: (b) => (b.genre === 'Reggaeton' && /smooth|chill|romantic/i.test(b.mood || '')) || b.subgenre === 'Latin Trap' },
  { artist: 'Anuel AA',        slug: 'anuel-type-beat',          intro: 'Anuel built his sound on harder old-school reggaeton and Latin trap with raw energy. Pick darker, harder reggaeton instrumentals or Latin trap beats.',
    filter: (b) => (b.genre === 'Reggaeton' && (b.subgenre === 'Old School Reggaeton' || /dark|hard|energetic/i.test(b.mood || ''))) || b.subgenre === 'Latin Trap' },
  { artist: 'J Balvin',        slug: 'j-balvin-type-beat',       intro: 'J Balvin is the architect of global reggaeton crossover — bouncy melodic hooks, modern production, mainstream-pop accessibility. Modern reggaeton with energetic feel fits.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || b.subgenre === 'Reggaeton Pop' || /bouncy|energetic|uplifting/i.test(b.mood || '')) },
  { artist: 'Ozuna',           slug: 'ozuna-type-beat',          intro: 'Ozuna defined the melodic reggaeton-pop wave with smooth choruses and emotional songwriting. Romantic, smooth modern-reggaeton instrumentals work best.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Reggaeton Pop' || b.subgenre === 'Modern Reggaeton' || /romantic|smooth|sensual/i.test(b.mood || '')) },
  { artist: 'Daddy Yankee',    slug: 'daddy-yankee-type-beat',   intro: 'The King of Reggaeton — Daddy Yankee is the originator of perreo and old-school dembow energy. Pick perreo, dembow, or old-school reggaeton instrumentals.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Old School Reggaeton' || b.subgenre === 'Perreo' || /energetic|bouncy/i.test(b.mood || '')) },
  { artist: 'Don Omar',        slug: 'don-omar-type-beat',       intro: 'Don Omar pioneered melodic reggaeton with hooks that travel. Old-school dembow energy with cleaner, smoother arrangements fits the lane.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Old School Reggaeton' || /smooth|romantic/i.test(b.mood || '')) },
  { artist: 'Peso Pluma',      slug: 'peso-pluma-type-beat',     intro: 'Peso Pluma brought corridos tumbados to global rotation. While we focus on reggaeton/trap, similar melodic Latin-trap energy works for that style.',
    filter: (b) => b.subgenre === 'Latin Trap' || (b.genre === 'Reggaeton' && /romantic|smooth/i.test(b.mood || '')) },
  // 2026-05-07 — Latin US gap fill. These three artists drive heavy 2025-2026
  // search volume in our target audience but were missing from the catalog.
  { artist: 'Young Miko',      slug: 'young-miko-type-beat',     intro: 'Young Miko brought a confident, melodic perreo flow with reggaeton-pop sensibilities to global stages. These beats match her lane — modern reggaeton with sticky hooks and bouncy mid-tempo dembow.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || b.subgenre === 'Reggaeton Pop' || b.subgenre === 'Perreo' || /bouncy|smooth|sensual|romantic/i.test(b.mood || '')),
    body: `<h2>The Young Miko sound, broken down</h2>
<p>Young Miko's catalog is built on a specific signature: confident, conversational vocal delivery sitting forward in the mix, modern dembow that leans more melodic-pop than old-school perreo, and chord progressions that feel airy rather than dark. Tempos run 90-95 BPM with a slight half-time feel. Keys lean minor (A minor, F minor, C# minor are most common). The drums pop with crisp, almost pop-radio-clean transient detail — this is one of the cleanest mix aesthetics in modern reggaeton.</p>
<h2>Writing in the Young Miko lane</h2>
<p>Young Miko writes hooks that you sing-along on first listen. The trick: lean melodic. Even your verses should have a clear contour — almost half-sung, half-spoken. Stay in your real range. The auto-tune is light polish, not a crutch. Lyrically, write what you'd actually say to someone — bravado works only if it's specific. Spanish, English, or Spanglish all work; she crosses freely.</p>
<h2>Best license tier for a Young Miko-style release</h2>
<p>Because the sound depends on the mix breathing, push for the Premium Lease ($99.99) — you get the WAV, which preserves the soft top-end of the synth pads and the crisp drum transient. If you're mixing yourself, the stems package ($199.99) lets you ride the perreo backbone separately from the melodic layer. <a href="/blog/lease-vs-exclusive-beat-license-guide">Full license breakdown</a>.</p>
<h2>Related lanes</h2>
<p>If the Young Miko lane fits your voice, also explore <a href="/perreo-beats">perreo beats</a>, <a href="/feid-type-beat">Feid type beats</a> (similar melodic palette), <a href="/karol-g-type-beat">Karol G type beats</a> (more vocal power, same energy), and <a href="/modern-reggaeton-beats">modern reggaeton</a>. For Spanish queries, see <a href="/comprar-beats-de-reggaeton">Comprar beats de reggaeton</a>.</p>` },
  { artist: 'Quevedo',         slug: 'quevedo-type-beat',        intro: 'Quevedo (Spain) blends melodic reggaeton, Latin trap, and conversational hooks into globally-scaled records. Pick smooth modern reggaeton or melodic Latin trap to match his tone.',
    filter: (b) => (b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || /smooth|romantic|chill/i.test(b.mood || ''))) || b.subgenre === 'Latin Trap',
    body: `<h2>Quevedo's lane: Spain's melodic reggaeton crossover</h2>
<p>Quevedo's BZRP Music Sessions #52 was one of the most-streamed Spanish-language tracks of all time, and his solo catalog continues that lane: melodic reggaeton at 90-95 BPM with sparse, atmospheric production, half-sung half-rapped delivery, and emotional chord progressions in minor keys. The mix sits the vocal close — like he's whispering the chorus into your ear. That intimacy is the production trick.</p>
<h2>Writing in the Quevedo lane</h2>
<p>Lean conversational. Quevedo's biggest hits feel like a voice memo to a specific person — observational, restrained, emotionally direct. Don't out-sing the beat; ride on top of it. Your hook should be one melodic phrase you can repeat 3-4 times without it feeling repetitive. The verses can stretch into longer 16-bar passages of mostly-spoken cadence with occasional melodic turns.</p>
<h2>Mix and license recommendation</h2>
<p>Atmospheric reggaeton lives or dies on the dynamic range — the quiet parts have to feel quiet so the drops feel huge. Premium Lease ($99.99) for the WAV is the floor; stems ($199.99) if you want to push the spaciousness yourself. <a href="/blog/lease-vs-exclusive-beat-license-guide">License tier breakdown</a>.</p>
<h2>Related</h2>
<p>If you're chasing this sound, also check <a href="/feid-type-beat">Feid type beats</a> (very close palette), <a href="/bizarrap-type-beat">Bizarrap-style sessions</a>, <a href="/smooth-reggaeton-beats">smooth reggaeton</a>, and <a href="/modern-reggaeton-beats">modern reggaeton</a>. Spain + Latin US audiences overlap heavily — see <a href="/comprar-beats-de-reggaeton">Comprar beats de reggaeton</a>.</p>` },
  { artist: 'Bizarrap',        slug: 'bizarrap-type-beat',       intro: 'Bizarrap (Argentina) built BZRP Music Sessions into a global format — high-energy tracks pairing trap drums, signature synth basses, and electronic elements with Latin artists. Pick high-energy trap with synthwave-inflected bass for this lane.',
    filter: (b) => b.genre === 'Trap' || b.subgenre === 'Latin Trap' || (b.genre === 'Reggaeton' && /energetic|hard|bouncy/i.test(b.mood || '')) },
  { artist: 'Anitta',          slug: 'anitta-type-beat',         intro: 'Anitta brings Brazilian funk-meets-reggaeton crossover energy to global stages. Pick energetic perreo, modern reggaeton, or reggaeton-pop for the high-energy bilingual hit lane.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Perreo' || b.subgenre === 'Reggaeton Pop' || b.subgenre === 'Modern Reggaeton' || /energetic|bouncy|powerful/i.test(b.mood || '')) },
  // ── Trap / Hip-Hop ──
  { artist: 'Future',          slug: 'future-type-beat',         intro: 'Future popularized dark, atmospheric trap with auto-tuned melodies over hard 808s. Dark trap with moody, atmospheric production matches.',
    filter: (b) => b.genre === 'Trap' && (b.subgenre === 'Dark Trap' || /dark|moody|atmospheric/i.test(b.mood || '')),
    body: `<h2>The Future formula</h2>
<p>Future's most influential records share a few production fingerprints: a dark minor-key melodic loop (often a single repeating motif), heavy 808s tuned to the root note, sparse hi-hat patterns that explode into rolls during transitions, and a vocal hook layered with auto-tune chest voice. Tempos sit between 130 BPM and 150 BPM (most of his catalog is half-time feel, so it sounds slower than the BPM suggests). Keys are almost always minor — F minor, A minor, and D minor dominate.</p>
<h2>Writing in this lane</h2>
<p>Future writes melodies in a narrow vocal range and lets the auto-tune do the harmonic work. If you're chasing the vibe, find your two or three most natural notes, write the hook around them, and let the auto-tune polish them into something more melodic than they really are. Don't over-write — Future hooks often repeat the same word or phrase three or four times. Repetition is the hook. The verses can be denser and more rhythmic.</p>
<h2>Mix and license recommendation</h2>
<p>Dark trap mixes live and die on the 808. Get the Premium Lease ($99.99) for the WAV — the 808 needs the headroom that MP3 compression strips. Stems ($199.99) are the right call if you want to dial in the 808 saturation yourself or swap the kick. <a href="/blog/lease-vs-exclusive-beat-license-guide">License tier breakdown</a>.</p>
<h2>Related lanes</h2>
<p>If you're chasing this sound, also check <a href="/dark-trap-beats">dark trap beats</a>, <a href="/trap-beats">trap beats</a>, the <a href="/metro-boomin-type-beat">Metro Boomin type beat</a> page (he produced a huge chunk of Future's catalog), and <a href="/southside-type-beat">Southside</a>.</p>` },
  { artist: 'Lil Baby',        slug: 'lil-baby-type-beat',       intro: 'Lil Baby blends melodic trap delivery with street narratives. Melodic trap or smooth dark trap work for his sound.',
    filter: (b) => b.genre === 'Trap' || (b.subgenre || '').toLowerCase().includes('trap') },
  { artist: 'Metro Boomin',    slug: 'metro-boomin-type-beat',   intro: 'Metro Boomin defined modern trap production — cinematic 808s, melodic minor-key keys, dark atmosphere. Pick dark or atmospheric trap.',
    filter: (b) => b.genre === 'Trap' && (b.subgenre === 'Dark Trap' || /dark|cinematic|atmospheric/i.test(b.mood || '')),
    body: `<h2>Why Metro Boomin's sound is the modern trap blueprint</h2>
<p>Metro Boomin took trap production from street-level grit to cinematic, almost orchestral darkness. The signatures: detuned minor-key melodic leads (often piano or pluck synths), wide sub-808s that ride the entire low-end, sparse hi-hat patterns with deliberate triplet rolls, dramatic risers and reverse cymbals into drops, and a near-constant sense of unresolved tension. Most beats sit at 130–145 BPM with half-time drum patterns, so the energy reads slower and heavier than the tempo suggests.</p>
<h2>Writing on a Metro-style beat</h2>
<p>The instrumentals in this lane are loud — they fight your vocal for space. To win, write hooks with strong consonants and tight melodic contour. Think Future, 21 Savage, The Weeknd — none of them try to out-sing the beat; they ride on top with confidence and let repetition do the work. Verses can be more rhythmic and dense; the hook needs to land hard with as few syllables as possible. Use silence as a tool — Metro builds drops by letting things drop out.</p>
<h2>Mix tips and licensing</h2>
<p>Cinematic trap mixes need WAV-quality audio for the sub-bass to translate to phones, cars, and AirPods alike. Get the Premium Lease ($99.99) at minimum. If you're a producer who wants to recreate the Metro sound from the ground up, the stems package gives you the raw 808, drums, and melodic layers separately so you can re-arrange or extend the beat for a longer release. <a href="/blog/lease-vs-exclusive-beat-license-guide">Full license guide</a>.</p>
<h2>Related</h2>
<p>Pair with <a href="/dark-trap-beats">dark trap</a>, <a href="/future-type-beat">Future type beats</a>, and <a href="/southside-type-beat">Southside type beats</a> — these three lanes overlap heavily.</p>` },
  { artist: 'Southside',       slug: 'southside-type-beat',      intro: 'Southside (808 Mafia) shaped the heavy 808-driven trap sound. Hard, dark trap with prominent low-end fits.',
    filter: (b) => b.genre === 'Trap' || (b.subgenre || '').toLowerCase().includes('dark trap') },
  { artist: 'J Cole',          slug: 'j-cole-type-beat',         intro: 'J Cole works in lyrical boom-bap and conscious hip-hop with jazzy chord progressions. Pick boom-bap or East Coast lyrical instrumentals.',
    filter: (b) => b.genre === 'Boom Bap' || b.subgenre === 'Lyrical' || b.subgenre === 'East Coast' || b.subgenre === 'Conscious' },
  { artist: 'Drake',           slug: 'drake-type-beat',          intro: 'Drake mixes melodic trap, R&B, and Caribbean-inflected dancehall. Modern Dancehall, Alternative R&B, or melodic trap all fit his range.',
    filter: (b) => b.subgenre === 'Modern Dancehall' || b.subgenre === 'Alternative R&B' || (b.genre === 'Trap' && /smooth|melodic/i.test(b.mood || '')),
    body: `<h2>Drake's three production lanes</h2>
<p>Drake doesn't sit in one bag — he switches between melodic trap (Boi-1da, OZ, Vinylz), alternative R&B (Noah "40" Shebib's signature warm low-pass sound), and Caribbean-inflected dancehall and afro-fusion. A "Drake type beat" can mean any of those, which is why this catalog page mixes Modern Dancehall, Alternative R&B, and smooth melodic trap. Tempos range wildly: 70 BPM half-time R&B, 95 BPM dancehall, 140 BPM melodic trap.</p>
<h2>Pick the right sub-lane for your voice</h2>
<p>Before you pick an instrumental, decide which Drake you're trying to be. If you sing more than rap, the alternative R&B beats (slow tempos, lush pads, sparse drums) will work; write a hook around a single sustained note and let the chord progression do the harmonic lifting. If you rap more than sing, the melodic trap beats (130–140 BPM half-time) give you a 16-bar pocket to ride. If you want a global crossover summer record, the dancehall lane (90–95 BPM) is the move — write a chant-style hook and let the off-beat snare guide your cadence.</p>
<h2>Mix and license</h2>
<p>Drake's records are famously meticulous in the mix. WAV (Premium Lease, $99.99) is the floor; if you're recording with a real engineer, the stems package opens up the option to push the low-end on dancehall records or pull back the pads on R&B records. <a href="/blog/lease-vs-exclusive-beat-license-guide">License tier breakdown</a>.</p>
<h2>Related lanes worth checking</h2>
<p>Explore <a href="/trap-beats">trap beats</a>, <a href="/reggaeton-beats">reggaeton beats</a> (Drake has worked extensively with Latin artists), and the <a href="/future-type-beat">Future</a> + <a href="/lil-baby-type-beat">Lil Baby</a> pages for the harder melodic-trap end of his catalog.</p>` },
];

// Featured one-off landing pages — keyword-targeted pages that don't fit the
// type-beat / genre / subgenre / mood templates. Always rendered (no minimum
// match count). High-volume search queries that the site couldn't otherwise
// rank for live here.
const FEATURED_PAGES = [
  {
    // Slug deliberately NOT 'beats' — that collides with the /beats JSON API
    // endpoint in server.js. Vercel serves public/{slug}.html as a static file
    // BEFORE Express routes run, so naming this 'beats' bypassed the API
    // handler and broke the SPA's fetch('/beats') call (parsed HTML as JSON,
    // catalog showed "Could not load beats"). 'browse-beats' is conflict-free.
    kind: 'featured',
    slug: 'browse-beats',
    name: 'Browse All Beats',
    metaTitle: "Browse All Beats — Reggaeton, Trap & Hip-Hop | O'Neil Beats",
    h1: 'Browse All Beats — The Full O\'Neil Beats Catalog',
    intro: "Every reggaeton, trap, hip-hop, drill, dancehall and afrobeats instrumental in the O'Neil Beats catalog. Lease MP3/WAV from $29.99 with instant delivery.",
    filter: () => true,
    body: `<h2>How the catalog is organized</h2>
<p>This page lists every active instrumental in the O'Neil Beats store right now. New beats drop weekly across the full reggaeton/trap/hip-hop range. Each beat detail page has a free tagged MP3 preview, a license selector (Lease, Premium Lease, Stems, Exclusive), and an offer slider for negotiated exclusive deals.</p>
<h2>Browse by genre</h2>
<ul>
  <li><a href="/reggaeton-beats">Reggaeton Beats</a> — modern reggaeton, perreo, dembow, old-school dembow, reggaeton-pop</li>
  <li><a href="/trap-beats">Trap Beats</a> — Latin trap, dark trap, melodic trap</li>
  <li><a href="/hip-hop-beats">Hip-Hop Beats</a> — boom bap, lo-fi, East Coast, West Coast, 90s</li>
  <li><a href="/drill-beats">Drill Beats</a> — UK drill, NY drill, Chicago drill</li>
  <li><a href="/dark-trap-beats">Dark Trap Beats</a> · <a href="/perreo-beats">Perreo Beats</a> · <a href="/modern-reggaeton-beats">Modern Reggaeton</a></li>
</ul>
<h2>Browse by artist (type beats)</h2>
<p>Pick by the artist whose lane fits your vocal: <a href="/bad-bunny-type-beat">Bad Bunny</a>, <a href="/feid-type-beat">Feid</a>, <a href="/rauw-alejandro-type-beat">Rauw Alejandro</a>, <a href="/karol-g-type-beat">Karol G</a>, <a href="/anuel-type-beat">Anuel</a>, <a href="/daddy-yankee-type-beat">Daddy Yankee</a>, <a href="/don-omar-type-beat">Don Omar</a>, <a href="/j-balvin-type-beat">J Balvin</a>, <a href="/ozuna-type-beat">Ozuna</a>, <a href="/myke-towers-type-beat">Myke Towers</a>, <a href="/peso-pluma-type-beat">Peso Pluma</a>, <a href="/future-type-beat">Future</a>, <a href="/lil-baby-type-beat">Lil Baby</a>, <a href="/metro-boomin-type-beat">Metro Boomin</a>, <a href="/southside-type-beat">Southside</a>, <a href="/j-cole-type-beat">J Cole</a>, <a href="/drake-type-beat">Drake</a>.</p>
<h2>License tiers, briefly</h2>
<ul>
  <li><strong>Lease ($29.99)</strong> — MP3, non-exclusive, up to 100K streams. Right answer for most artists, most songs.</li>
  <li><strong>Premium Lease ($99.99)</strong> — MP3 + WAV, unlimited streams, radio rights. Right answer for songs you actually believe in.</li>
  <li><strong>Stems ($199.99)</strong> — All separated tracks (drums, melody, bass, 808s) for full mix control.</li>
  <li><strong>Exclusive ($500+)</strong> — You own the beat outright; it's removed from the store. Negotiable price slider on every beat page.</li>
</ul>
<p>Full breakdown: <a href="/blog/lease-vs-exclusive-beat-license-guide">Lease vs Exclusive vs Stems</a>.</p>
<h2>Free tagged MP3 previews</h2>
<p>Every beat in the catalog has a free tagged MP3 preview. Use it to demo, write your topline, audition the beat against your voice. When you're ready to release, license. <a href="/free-beats">All free tagged previews →</a></p>
<p>Spanish: <a href="/comprar-beats-de-reggaeton">Comprar beats de reggaeton</a> · <a href="/beats-de-perreo">Beats de perreo</a> · <a href="/comprar-beats-de-trap-latino">Beats de trap latino</a>.</p>`,
  },
  {
    // /about — establishes the Person entity for E-E-A-T (Experience, Expertise,
    // Authority, Trust). Embedded Person JSON-LD with sameAs links lets Google
    // tie every beat/blog page (which has byArtist: O'Neil) to a real producer
    // profile, which compounds into topical authority.
    kind: 'featured',
    slug: 'about',
    name: 'About O\'Neil',
    metaTitle: "About O'Neil — Independent Reggaeton & Trap Producer",
    h1: 'About O\'Neil — Independent Reggaeton & Trap Producer',
    intro: "O'Neil (Nelson Rios) is an independent producer making reggaeton, trap, hip-hop, drill, and Latin instrumentals. Studio-mixed beats for indie artists. Lease from $29.99.",
    filter: () => false, // no beat list on this page
    informational: true, // skip catalog scaffolding in renderLandingPage
    body: `<h2>Who's behind these beats</h2>
<p>I'm Nelson Rios — known as <strong>O'Neil</strong> in the production world. I've been making beats since 2011, originally under the name Mixbeatsforsale, with placements ranging from independent reggaeton releases to videos that cross a million views on YouTube.</p>
<p>This catalog is the next chapter — focused entirely on reggaeton, modern Latin, trap, drill, and hip-hop instrumentals built for the artists who can't (yet) drop $500+ on custom production but still want studio-grade sound.</p>
<h2>Why I built this store</h2>
<p>Most beat marketplaces are built for the marketplace, not the artist. Generic templates, no producer voice, no curation. I built oneilbeats.store the opposite way: every beat is mine, every license is documented, every preview is a tagged MP3 you can demo on without paying anything.</p>
<p>If you find a beat that fits your song, you're 60 seconds from owning it — Lease ($29.99), Premium Lease ($99.99), Stems ($199.99), or Exclusive (negotiable on every beat page). Instant delivery. Done.</p>
<h2>Studio &amp; production</h2>
<p>Mixed in FL Studio with iZotope Ozone for mastering. Reference tracks lean on Bad Bunny's <em>X 100PRE</em>, Feid's <em>Mor No Le Temas a la Oscuridad</em>, J Cole's <em>2014 Forest Hills Drive</em>, and Future's <em>DS2</em> — different lanes, same standard for low-end translation and vocal-friendly mid space.</p>
<p>Every beat ships as a clean studio mixdown. Premium Lease unlocks the WAV (uncompressed). Stems give you the individual drums, melody, bass, and 808 layers separated for full mix control.</p>
<h2>How I scale the catalog (the AI question)</h2>
<p>Yes, I use AI tools as part of my workflow. I think being honest about that is more interesting than pretending otherwise — see <a href="/how-its-made">How It's Made</a> for the full breakdown. The short version: AI helps me explore composition ideas faster, but every beat is mixed and mastered by hand, and nothing ships until I'd be willing to put a song over it myself.</p>
<h2>Custom beats &amp; collaborations</h2>
<p>Need a beat that's not in the catalog? Go to <a href="/custom-beat">Custom Beat</a> for fast-turnaround orders, or <a href="mailto:produceroneil@gmail.com?subject=Custom%20beat%20request">email me</a> directly.</p>
<h2>Connect</h2>
<p>Catalog updates and Free Beat Friday emails: <a href="/#free-signup">subscribe here</a>. Direct contact: <a href="mailto:produceroneil@gmail.com">produceroneil@gmail.com</a>.</p>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Nelson Rios","alternateName":"O'Neil","jobTitle":"Music Producer","description":"Independent producer of reggaeton, trap, hip-hop, drill and Latin instrumentals. Founder of O'Neil Beats.","url":"https://oneilbeats.store/about","email":"produceroneil@gmail.com","worksFor":{"@type":"Organization","name":"O'Neil Beats","url":"https://oneilbeats.store"},"sameAs":["https://oneilbeats.store","https://www.instagram.com/oneilbeats","https://twitter.com/oneilbeats","https://www.youtube.com/@oneilbeats"]}</script>`,
  },
  {
    // /how-its-made — AI-disclosure transparency page. Turns the "is this AI?"
    // question from a liability into a USP. Core argument: AI for composition
    // exploration, human for mixing/mastering/QC. Sets honest expectations and
    // differentiates from both pure-AI sites and pure-human producers.
    kind: 'featured',
    slug: 'how-its-made',
    name: 'How It\'s Made',
    metaTitle: "How O'Neil Beats Are Made — AI-Assisted, Studio-Mixed",
    h1: 'How These Beats Are Made — AI Composition, Human Mix &amp; Master',
    intro: "An honest breakdown of the workflow behind O'Neil Beats: AI for composition exploration, human for arrangement, mixing, mastering, and quality control. No black-box claims.",
    filter: () => false,
    informational: true,
    body: `<h2>The honest answer first</h2>
<p>I use AI as part of the production workflow. Every beat in the catalog goes through human-controlled arrangement, mixing, mastering, and quality review before it ever hits the store. Nothing ships untouched. Here's the actual breakdown.</p>
<h2>What the AI does</h2>
<ul>
  <li><strong>Composition exploration.</strong> Given a genre, BPM, key, and mood prompt, the AI generates candidate progressions, melody motifs, and drum patterns. Most are throwaways. The 1 in 20 that has something I can build on is where the beat starts.</li>
  <li><strong>Reference matching.</strong> When I want a "Bad Bunny modern reggaeton, but in F minor at 95 BPM" feel, the AI helps land in that pocket faster than starting from a blank session would.</li>
  <li><strong>Stem generation.</strong> Drums, bass, melody, and pads come out as separate audio layers I can re-balance, swap, or rebuild.</li>
</ul>
<h2>What I do (the human part)</h2>
<ul>
  <li><strong>Arrangement.</strong> Verse-hook structure, drops, transitions, ear candy — that's all me. AI gives me material; arrangement turns material into a song.</li>
  <li><strong>Sound replacement.</strong> Drum hits, 808s, snares — I swap a lot of the AI-generated sounds for samples I've curated over years. The signature low-end weight on these beats comes from sounds that pre-date the AI tools.</li>
  <li><strong>Mixing.</strong> Every beat is mixed by ear in FL Studio. EQ, compression, sidechain, automation, stereo width — all manual. This is where studio-quality vs. "AI demo quality" actually diverges.</li>
  <li><strong>Mastering.</strong> iZotope Ozone with reference tracks for the genre. Loudness, tonal balance, headroom — engineered to translate from AirPods to a club system.</li>
  <li><strong>QC.</strong> If I wouldn't put a song over it, it doesn't go in the store. About 60% of what I generate gets cut.</li>
</ul>
<h2>Why this matters for you</h2>
<ul>
  <li><strong>Speed.</strong> I can ship 20-50 beats a month at studio quality. A pure-human producer ships 4-8. The AI-assisted workflow is the only way an indie producer can fill a catalog this wide without raising prices to $500+/beat.</li>
  <li><strong>Price.</strong> Lease tier stays at $29.99 because the unit economics work. If you find a beat you like, you don't need a label budget to license it.</li>
  <li><strong>Originality.</strong> Every beat is unique to the catalog. You won't find the same instrumental on a free-beat aggregator or a competing store. The AI generates raw material; the arrangement, mix, and master make it specific.</li>
  <li><strong>Transparency.</strong> Most stores selling AI-assisted beats don't say so. I do — because the disclosure is a feature, not a bug. You know what you're buying.</li>
</ul>
<h2>The "is this just AI slop?" question</h2>
<p>Fair question. Two practical tests: (1) preview any beat for free as a tagged MP3, and (2) compare the mix to whatever else you'd lease at $29.99. The 808s hit, the high-end translates on phone speakers, and the drum bus has the loudness modern reggaeton demands. If a beat fails either test, don't buy it. If it passes, that's the answer.</p>
<h2>What's NOT AI on this site</h2>
<ul>
  <li>Every license PDF is a real contract I've reviewed.</li>
  <li>Every email reply is from me (Nelson, the producer).</li>
  <li>Every blog post on this site is written by me — including this page.</li>
  <li>Every exclusive offer is reviewed and accepted/countered manually.</li>
</ul>
<p>Catalog: <a href="/browse-beats">browse all beats</a> · <a href="/free-beats">free tagged previews</a> · <a href="/about">more about O'Neil</a></p>`,
  },
  {
    // /custom-beat — paid product page for fast-turnaround custom beats. The
    // AI-assisted workflow makes 24-48h turnaround at $99 economically viable
    // where pure-human producers charge $300+ with 1-2 week turnaround. v1
    // uses a pre-filled mailto for intake; a real form-backed flow can replace
    // it later without changing the URL.
    kind: 'featured',
    slug: 'custom-beat',
    name: 'Custom Beat',
    metaTitle: "Custom Beat in 24-48h — $99 Reggaeton, Trap & Hip-Hop | O'Neil",
    h1: 'Custom Beat in 24-48 Hours — $99',
    intro: "Need a beat that's not in the catalog? I'll produce a custom reggaeton, trap, hip-hop, drill or Latin instrumental from your reference track in 24-48 hours. From $99.",
    filter: () => false,
    informational: true,
    body: `<h2>What you get</h2>
<ul>
  <li><strong>One custom beat</strong> built to your reference track + brief.</li>
  <li><strong>Mixed and mastered</strong> studio-quality (FL Studio + iZotope Ozone).</li>
  <li><strong>Untagged WAV + MP3</strong> delivered by email within 24-48 hours.</li>
  <li><strong>Premium Lease license included</strong> — unlimited streams on Spotify, Apple Music, YouTube. Radio rights. Producer credit required ("Prod. by O'Neil").</li>
  <li><strong>One round of revisions</strong> at no extra cost (BPM swap, drum tweak, melody adjustment).</li>
</ul>
<h2>Pricing</h2>
<ul>
  <li><strong>Custom Beat — $99.</strong> Premium Lease license bundled. The standard offer.</li>
  <li><strong>Custom Beat + Stems — $199.</strong> Adds separated stems for full mix control.</li>
  <li><strong>Custom Beat + Exclusive — $499+.</strong> You own the beat outright. No producer credit required.</li>
</ul>
<h2>How it works</h2>
<ol>
  <li><strong>Send your brief.</strong> Genre, BPM (or "match this song's tempo"), key, mood, and a YouTube/Spotify reference track. Click the button below — opens a pre-filled email.</li>
  <li><strong>I confirm + Stripe-invoice you</strong> within a few hours. Beat starts after payment.</li>
  <li><strong>Production: 24-48 hours.</strong> AI-assisted composition matching your reference; I arrange, mix, master, and QC by ear. <a href="/how-its-made">How my workflow actually works</a>.</li>
  <li><strong>Delivery email.</strong> Untagged WAV + MP3 + license PDF.</li>
</ol>
<h2>Why this exists (and why it's $99)</h2>
<p>Most producers selling custom beats charge $300-1000 because they're working from scratch on every order. My workflow uses AI for composition exploration, which lets me deliver custom beats at lease-tier quality without lease-tier compromise. You get studio-quality output at indie-artist pricing. If you don't love the result after the revision round, full refund. No questions, no ego.</p>
<h2>Common turnaround examples</h2>
<ul>
  <li>Modern reggaeton, ~95 BPM, like Feid "Classy 101" → 18-30 hours typical</li>
  <li>Dark trap, 140 BPM, like Future "Mask Off" → 24-36 hours typical</li>
  <li>Boom bap, 90 BPM, J Cole vibe → 24-48 hours typical</li>
  <li>Latin trap × afrobeats fusion, 100 BPM → 36-48 hours typical</li>
</ul>
<h2>Request a custom beat</h2>
<p>Click the button — opens an email pre-filled with the fields I need. Reply with your reference track, I'll confirm pricing and timeline within hours.</p>
<p style="margin:24px 0"><a href="mailto:produceroneil@gmail.com?subject=Custom%20beat%20request&amp;body=Hey%20O'Neil%2C%20I'd%20like%20a%20custom%20beat.%0A%0AGenre%3A%20%0ABPM%20%28or%20%22match%20reference%22%29%3A%20%0AKey%3A%20%0AMood%3A%20%0AReference%20track%20%28YouTube%2FSpotify%20link%29%3A%20%0ARelease%20context%20%28what%20you%27re%20using%20it%20for%29%3A%20%0AAdditional%20notes%3A%20%0A%0AThanks%21" style="display:inline-block;background:linear-gradient(135deg,#e63946,#f59e0b);color:#fff;padding:14px 28px;border-radius:10px;font-weight:800;text-decoration:none;font-size:16px">📧 Request Custom Beat — $99</a></p>
<h2>Or browse the existing catalog first</h2>
<p>The fastest option is usually a beat already in the catalog. <a href="/browse-beats">Browse all beats</a>, <a href="/free-beats">grab free tagged previews</a>, demo with them — if nothing fits, then come back here.</p>`,
  },
  {
    kind: 'featured',
    slug: 'free-beats',
    name: 'Free Reggaeton & Trap Beats',
    h1: 'Free Reggaeton, Trap & Hip-Hop Beats — Tagged MP3 Previews',
    intro: 'Free reggaeton, trap, hip-hop & drill beats — tagged MP3 previews to download and demo with. Upgrade to untagged MP3/WAV from $29.99. Instant delivery.',
    filter: () => true, // every beat has a free tagged preview
    body: `<h2>What "free tagged MP3 preview" actually means</h2>
<p>Every beat in the O'Neil Beats catalog has a free downloadable tagged MP3 preview. The "tag" is a producer voice clip ("Prod. by O'Neil") that plays every 30 seconds throughout the beat. The tag is what lets you demo without paying — and what stops you from releasing the song without licensing the untagged version.</p>
<p>Use the tagged MP3 to: write your topline, record a rough demo on your phone or in your DAW, audition the beat against your voice, share with a producer or A&amp;R for feedback. Don't use it to: release on Spotify, post a finished version on YouTube, sell anywhere, or pitch for sync. Those uses require an untagged license — Lease ($29.99) at minimum.</p>
<h2>How to get a free reggaeton or trap beat right now</h2>
<p>Open any beat detail page, hit the "Free Tagged MP3" download. No email required, no credit card, no signup. The file is yours within five seconds. Try the beat against a vocal idea — if it sticks, come back and lease.</p>
<p>If you want a steady supply: subscribe to the <a href="/#free-signup">Free Beat Friday</a> email. Every Friday, one new beat goes out as a tagged MP3 to subscribers. Cancel anytime. The beats rotate through reggaeton, trap, drill, dancehall, and afrobeats — same range as the full catalog.</p>
<h2>When you should upgrade from free to paid</h2>
<p>Three triggers that mean it's time to license:</p>
<ul>
  <li><strong>You're putting the song on a DSP</strong> (Spotify, Apple Music, Tidal, Deezer). Tagged MP3s violate platform terms of service for paid distributions. Lease tier ($29.99) covers up to 100K streams.</li>
  <li><strong>You're posting a finished version on YouTube or TikTok</strong> with monetization on. Same logic — the tag conflicts with monetization rights. Premium Lease ($99.99) covers unlimited streams and includes the WAV.</li>
  <li><strong>You're pitching the song to a label or sync agency.</strong> Labels and sync agencies won't touch a tagged song. They'll usually require Exclusive rights ($500+) before signing anything.</li>
</ul>
<p>For the deeper breakdown of when each license tier is the right call, read <a href="/blog/free-beats-vs-paid-tagged-mp3-explained">Free Beats vs Paid: What Artists Get with the Tagged MP3</a> or the <a href="/blog/lease-vs-exclusive-beat-license-guide">license tier guide</a>.</p>
<h2>Browse free tagged previews by genre</h2>
<p>Every beat across every genre has a free tagged MP3:</p>
<ul>
  <li><a href="/reggaeton-beats">Free Reggaeton Beats</a> — modern reggaeton, perreo, dembow, old-school</li>
  <li><a href="/trap-beats">Free Trap Beats</a> — Latin trap, dark trap, melodic trap</li>
  <li><a href="/hip-hop-beats">Free Hip-Hop Beats</a> — boom bap, lo-fi, East Coast, West Coast</li>
  <li><a href="/drill-beats">Free Drill Beats</a> — UK drill, NY drill, Chicago drill</li>
  <li><a href="/perreo-beats">Free Perreo Beats</a></li>
  <li><a href="/dark-trap-beats">Free Dark Trap Beats</a></li>
</ul>
<h2>Why most "free beats" online are scams or junk</h2>
<p>Search "free reggaeton beats" on Google and you'll get thousands of results. Most are: (1) scraped beats producers never authorized for free distribution, (2) AI-generated slop with no producer attached, (3) free downloads that lock behind email opt-ins to platforms that resell your address, or (4) outdated demo links that 404. The clean alternative is to download from active producers directly. <a href="/blog/how-to-find-free-beats-2026-and-why-demos-matter">Full guide on finding legit free beats in 2026</a>.</p>
<h2>The producer behind these beats</h2>
<p>Every beat in this catalog is produced by O'Neil — independent reggaeton, trap, and hip-hop producer. Each beat is mixed and mastered before it hits the catalog. New tagged previews drop weekly. The free section is the front door; licensing is what funds the next batch.</p>
<p>Spanish-speaking artists: la versión en español de esta página es <a href="/comprar-beats-de-reggaeton">Comprar beats de reggaeton</a>.</p>`,
  },
];

// Genre/subgenre/mood landing pages — auto-derived from catalog data.
// Returns an array of { slug, name, intro, filter } configs based on what's in
// the actual beats list. Skips any bucket with fewer than 2 matching beats
// (avoids generating empty/thin pages that hurt SEO).
function deriveLandingPages(beats) {
  const pages = [];

  // Genre pages
  const genres = {};
  for (const b of beats) {
    const g = (b.genre || '').trim();
    if (!g) continue;
    (genres[g] = genres[g] || []).push(b);
  }
  for (const [genre, list] of Object.entries(genres)) {
    if (list.length < 2) continue;
    const slug = slugify(genre) + '-beats';
    pages.push({
      kind: 'genre', slug, name: `${genre} Beats`,
      h1: `Buy ${genre} Beats — ${list.length}+ Instrumentals Available`,
      intro: `Premium ${genre.toLowerCase()} instrumentals from O'Neil Beats — ${list.length} ${genre.toLowerCase()} type beats in the catalog right now. Lease from $29.99 with instant MP3/WAV delivery. All beats include MP3, WAV, stems, and exclusive license options.`,
      filter: (b) => (b.genre || '').trim() === genre,
    });
  }

  // Subgenre pages
  const subs = {};
  for (const b of beats) {
    const s = (b.subgenre || '').trim();
    if (!s) continue;
    (subs[s] = subs[s] || []).push(b);
  }
  for (const [sub, list] of Object.entries(subs)) {
    if (list.length < 2) continue;
    const slug = slugify(sub) + '-beats';
    pages.push({
      kind: 'subgenre', slug, name: `${sub} Beats`,
      h1: `Buy ${sub} Beats — Premium ${sub} Instrumentals`,
      intro: `${list.length}+ ${sub.toLowerCase()} type beats available now. ${sub} is one of the most-searched sub-genres on O'Neil Beats — explore the full collection below. Lease from $29.99, instant delivery.`,
      filter: (b) => (b.subgenre || '').trim() === sub,
    });
  }

  // BPM × Genre clusters — programmatic long-tail SEO. Targets queries like
  // "reggaeton type beat 95 bpm" and "trap beat 140 bpm". These are very
  // low-competition (most stores ignore BPM-specific landings) but real
  // search volume from producers picking beats by tempo. Each cluster is
  // centered on a 5-BPM mark and matches beats within ±4 BPM (so 95 BPM
  // covers 91-99). Only emits when ≥2 beats fall in the cluster.
  const bpmCenters = [70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150, 155, 160];
  const bpmByGenre = {};
  for (const b of beats) {
    const g = (b.genre || '').trim();
    const bpm = parseInt(b.bpm, 10);
    if (!g || !bpm || !Number.isFinite(bpm)) continue;
    (bpmByGenre[g] = bpmByGenre[g] || []).push({ bpm, b });
  }
  for (const [genre, items] of Object.entries(bpmByGenre)) {
    for (const center of bpmCenters) {
      const matches = items.filter(x => Math.abs(x.bpm - center) <= 4);
      if (matches.length < 2) continue;
      const slug = `${slugify(genre)}-beats-${center}-bpm`;
      pages.push({
        kind: 'bpm-genre',
        slug,
        name: `${genre} Beats ${center} BPM`,
        h1: `${genre} Type Beats at ${center} BPM — ${matches.length}+ Instrumentals`,
        intro: `${matches.length} ${genre.toLowerCase()} type beats around ${center} BPM at O'Neil Beats. Tempo-matched ${genre.toLowerCase()} instrumentals — modern, perreo, dembow, and Latin trap variations all in the ${center}-BPM pocket. Lease from $29.99 with instant MP3/WAV delivery.`,
        filter: (b) => (b.genre || '').trim() === genre && Math.abs(parseInt(b.bpm, 10) - center) <= 4,
      });
    }
  }

  // Mood × Genre combos (only for the dominant genre)
  const moodGenre = {};
  for (const b of beats) {
    const m = (b.mood || '').trim();
    const g = (b.genre || '').trim();
    if (!m || !g) continue;
    const key = `${m}|${g}`;
    (moodGenre[key] = moodGenre[key] || []).push(b);
  }
  for (const [key, list] of Object.entries(moodGenre)) {
    if (list.length < 2) continue;
    const [mood, genre] = key.split('|');
    const slug = `${slugify(mood)}-${slugify(genre)}-beats`;
    pages.push({
      kind: 'mood-genre', slug, name: `${mood} ${genre} Beats`,
      h1: `Buy ${mood} ${genre} Beats — ${list.length}+ Instrumentals`,
      intro: `${mood} ${genre.toLowerCase()} type beats from O'Neil Beats. ${list.length} matching ${mood.toLowerCase()} ${genre.toLowerCase()} instrumentals available — perfect for artists who want that ${mood.toLowerCase()} energy. Lease from $29.99.`,
      filter: (b) => (b.mood || '').trim() === mood && (b.genre || '').trim() === genre,
    });
  }

  return pages;
}

// Build the full landing-page list for a given catalog. Combines static
// type-beat artist configs with auto-derived genre/subgenre/mood pages.
// Type-beat pages always render (even with 0 matches — they offer custom-beat
// CTA). Genre/subgenre/mood pages only render if ≥2 matching beats.
function getAllLandingPages(beats) {
  const typeBeats = TYPE_BEAT_ARTISTS.map(t => ({
    kind: 'type-beat',
    slug: t.slug,
    name: `${t.artist} Type Beat`,
    h1: `${t.artist} Type Beats — Buy Instrumentals Like ${t.artist}`,
    intro: t.intro,
    body: t.body,
    filter: t.filter,
    artist: t.artist,
  }));
  return [...typeBeats, ...FEATURED_PAGES, ...deriveLandingPages(beats)];
}

// ── Spanish landing pages — bilingual SEO ──
// Each Spanish page targets a specific Spanish-language buying query and is
// reciprocally hreflang-linked to its English counterpart. The catalog is the
// same; only the meta + crawler-visible block + UI seed text change.
const SPANISH_LANDING_PAGES = [
  {
    slug: 'comprar-beats-de-reggaeton',
    name: 'Comprar Beats de Reggaeton',
    h1: 'Comprar Beats de Reggaeton — Instrumentales con Entrega Inmediata',
    metaTitle: 'Comprar Beats de Reggaeton | Instrumentales en MP3 y WAV',
    metaDescription: 'Compra beats de reggaeton originales, mezclados profesionalmente. Reggaeton moderno, perreo, dembow y reggaeton old school. Licencias desde $29.99 USD. Entrega inmediata por correo.',
    intro: 'Beats de reggaeton originales producidos por O\'Neil. Reggaeton moderno, perreo, dembow y old school — todos mezclados y masterizados en estudio, listos para grabar después del checkout. Licencias desde $29.99 con entrega inmediata por correo electrónico.',
    enAlt: '/reggaeton-beats',
    filter: (b) => b.genre === 'Reggaeton',
    seedKeyword: 'Reggaeton',
  },
  {
    slug: 'beats-de-perreo',
    name: 'Beats de Perreo',
    h1: 'Beats de Perreo — Instrumentales para Perrear',
    metaTitle: 'Beats de Perreo | Instrumentales de Perreo Originales',
    metaDescription: 'Beats de perreo originales, energía de discoteca, dembow tradicional y perreo intenso para tu próximo hit. Licencias desde $29.99. Entrega inmediata.',
    intro: 'Perreo intenso, dembow clásico, y la energía que necesitas para reventar la pista. Estos beats están diseñados para que perrees y crees el próximo himno. Licencias desde $29.99 con entrega instantánea.',
    enAlt: '/perreo-beats',
    filter: (b) => b.subgenre === 'Perreo' || (b.genre === 'Reggaeton' && /energetic|bouncy/i.test(b.mood || '')),
    seedKeyword: 'Perreo',
  },
  {
    slug: 'beats-de-dembow',
    name: 'Beats de Dembow',
    h1: 'Beats de Dembow — Instrumentales Originales',
    metaTitle: 'Beats de Dembow | Comprar Instrumentales de Dembow',
    metaDescription: 'Beats de dembow originales con la cadencia tradicional del género. Listos para grabar tu próximo single. Licencias desde $29.99 con entrega inmediata.',
    intro: 'El dembow es la base rítmica del reggaeton — y estos beats lo respetan. Producción original con la cadencia tradicional del género, lista para que grabes encima. Licencias desde $29.99.',
    enAlt: '/perreo-beats',
    filter: (b) => b.genre === 'Reggaeton' || /dembow|perreo/i.test((b.tags || []).join(' ').toLowerCase()),
    seedKeyword: 'dembow',
  },
  {
    slug: 'instrumentales-de-reggaeton',
    name: 'Instrumentales de Reggaeton',
    h1: 'Instrumentales de Reggaeton — Catálogo Completo',
    metaTitle: 'Instrumentales de Reggaeton | Modernos y Old School',
    metaDescription: 'Instrumentales de reggaeton originales: modernos al estilo Bad Bunny y Feid, y old school al estilo Daddy Yankee y Don Omar. MP3 y WAV. Licencias desde $29.99.',
    intro: 'Instrumentales de reggaeton para todos los estilos: moderno con sonido al estilo Bad Bunny, Feid o Rauw Alejandro, o old school con la energía de Daddy Yankee y Don Omar. Mezcla y masterización en estudio. Licencias desde $29.99.',
    enAlt: '/reggaeton-beats',
    filter: (b) => b.genre === 'Reggaeton',
    seedKeyword: 'Reggaeton',
  },
  {
    slug: 'beats-tipo-bad-bunny',
    name: 'Beats Tipo Bad Bunny',
    h1: 'Beats Tipo Bad Bunny — Reggaeton Moderno con Vibe Melódica',
    metaTitle: 'Beats Tipo Bad Bunny | Instrumentales de Reggaeton Moderno',
    metaDescription: 'Beats tipo Bad Bunny: reggaeton moderno melódico, half-singing, producción global. Originales mezclados en estudio. Licencias desde $29.99 USD.',
    intro: 'Bad Bunny redefinió el reggaeton moderno — melodías pegajosas, versos cantados, producción global. Estos instrumentales están en esa misma línea. Listos para que grabes tu próximo hit. Licencias desde $29.99.',
    enAlt: '/bad-bunny-type-beat',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || /smooth|melodic/i.test(b.mood || '')),
    seedKeyword: 'Modern Reggaeton',
  },
  {
    slug: 'beats-tipo-feid',
    name: 'Beats Tipo Feid',
    h1: 'Beats Tipo Feid (FERXXO) — Perreo Melódico Moderno',
    metaTitle: 'Beats Tipo Feid | Perreo Melódico al Estilo FERXXO',
    metaDescription: 'Beats tipo Feid (FERXXO): perreo melódico, sintes aireados, vibe conversacional. Reggaeton moderno y perreo originales. Licencias desde $29.99.',
    intro: 'Feid (FERXXO) hizo del perreo melódico y el reggaeton moderno con sintes aireados el sonido global. Estos beats encajan en ese estilo — vibes suaves y muy listenables. Licencias desde $29.99.',
    enAlt: '/feid-type-beat',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || b.subgenre === 'Perreo' || /smooth|chill|romantic/i.test(b.mood || '')),
    seedKeyword: 'Modern Reggaeton',
  },
  {
    slug: 'comprar-beats-de-trap-latino',
    name: 'Comprar Beats de Trap Latino',
    h1: 'Comprar Beats de Trap Latino — Instrumentales Originales',
    metaTitle: 'Comprar Beats de Trap Latino | Instrumentales Originales',
    metaDescription: 'Beats de trap latino originales, mezclados profesionalmente. Trap latino oscuro, melódico, y con 808s pesados. Licencias desde $29.99 con entrega inmediata.',
    intro: 'Trap latino con 808s pesados, melodías oscuras y la energía que necesitas. Producción original mezclada en estudio. Licencias desde $29.99 USD con entrega inmediata.',
    enAlt: '/trap-beats',
    filter: (b) => b.subgenre === 'Latin Trap' || b.genre === 'Trap' || (b.genre === 'Reggaeton' && /dark|hard/i.test(b.mood || '')),
    seedKeyword: 'Latin Trap',
  },
];

// Render a single Spanish landing page. Mirrors renderLandingPage but with
// Spanish meta + reciprocal hreflang to the English counterpart.
function renderSpanishLandingPage(template, page, beats) {
  const matches = beats.filter(b => { try { return page.filter(b); } catch (e) { return false; } });
  const url = `${SITE_URL}/${page.slug}`;
  const enUrl = `${SITE_URL}${page.enAlt}`;
  const titleTag = page.metaTitle;
  // Trim to 155 chars — Google truncates Spanish meta descriptions the same way.
  const descRaw = page.metaDescription;
  const desc = descRaw.length > 160 ? descRaw.slice(0, 157).trimEnd() + '…' : descRaw;
  const ogImage = (matches[0] && (matches[0].cover_art_url || matches[0].cover_url)) || `${SITE_URL}/og-image.jpg`;

  let html = template;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(titleTag)}</title>`);
  html = html.replace(/<meta\s+name="description"\s+content="[^"]*">/i, `<meta name="description" content="${esc(desc)}">`);
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*">/i, `<link rel="canonical" href="${url}">`);
  html = html.replace(/<html\s+lang="en">/i, `<html lang="es">`);

  // hreflang — declare both sides + x-default. Replace the entire existing
  // hreflang block (the homepage template has 3 self-referential alternate
  // links that aren't useful — overwrite them).
  const hreflangBlock = `
<link rel="alternate" hreflang="es" href="${url}">
<link rel="alternate" hreflang="en" href="${enUrl}">
<link rel="alternate" hreflang="x-default" href="${enUrl}">`;
  html = html.replace(/<link\s+rel="alternate"\s+hreflang="[^"]*"\s+href="[^"]*">[\s\S]*?<link\s+rel="alternate"\s+hreflang="x-default"\s+href="[^"]*">/i, hreflangBlock.trim());

  // OG / Twitter — Spanish locale primary
  html = html.replace(/<meta\s+property="og:url"\s+content="[^"]*">/i, `<meta property="og:url" content="${url}">`);
  html = html.replace(/<meta\s+property="og:title"\s+content="[^"]*">/i, `<meta property="og:title" content="${esc(titleTag)}">`);
  html = html.replace(/<meta\s+property="og:description"\s+content="[^"]*">/i, `<meta property="og:description" content="${esc(desc)}">`);
  html = html.replace(/<meta\s+property="og:image"\s+content="[^"]*">/i, `<meta property="og:image" content="${esc(ogImage)}">`);
  html = html.replace(/<meta\s+property="og:locale"\s+content="en_US">/i, `<meta property="og:locale" content="es_ES">`);
  html = html.replace(/<meta\s+name="twitter:title"\s+content="[^"]*">/i, `<meta name="twitter:title" content="${esc(titleTag)}">`);
  html = html.replace(/<meta\s+name="twitter:description"\s+content="[^"]*">/i, `<meta name="twitter:description" content="${esc(desc)}">`);

  // CollectionPage schema in Spanish
  const collectionLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: page.name,
    url,
    inLanguage: 'es',
    description: desc,
    isPartOf: { '@type': 'WebSite', name: "O'Neil Beats", url: SITE_URL },
    breadcrumb: { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Beats', item: SITE_URL + '/#catalog' },
      { '@type': 'ListItem', position: 3, name: page.name, item: url },
    ] },
    mainEntity: { '@type': 'ItemList', numberOfItems: matches.length, itemListElement: matches.slice(0, 25).map((b, i) => ({
      '@type': 'ListItem', position: i + 1,
      url: `${SITE_URL}/beat/${beatSlug(b)}`,
      name: b.title,
    })) },
  };
  html = html.replace(/<\/head>/i, `<script type="application/ld+json" data-landing-es="${esc(page.slug)}">${JSON.stringify(collectionLd)}</script></head>`);

  // Crawler-visible Spanish content block
  const beatListHtml = matches.length
    ? `<ul>${matches.slice(0, 25).map(b => `<li><a href="${SITE_URL}/beat/${beatSlug(b)}">${esc(b.title)}</a> — ${esc(b.subgenre || b.genre || 'beat')}${b.bpm ? ', ' + esc(b.bpm) + ' BPM' : ''}${b.key ? ', ' + esc(b.key) : ''}</li>`).join('')}</ul>`
    : `<p>No hay beats exactos disponibles ahora mismo. <a href="mailto:produceroneil@gmail.com?subject=${encodeURIComponent('Custom ' + page.name)}">Escribe a O'Neil</a> para encargar uno, o <a href="${SITE_URL}/">explora el catálogo completo</a>.</p>`;

  const crawlerBlock = `
<div class="sr-only" aria-hidden="false">
  <h1>${esc(page.h1)}</h1>
  <p>${esc(page.intro)}</p>
  <h2>Beats Disponibles — ${esc(page.name)}</h2>
  ${beatListHtml}
  <p>¿Buscas otro estilo? <a href="${SITE_URL}/">Explora todos los beats</a> o filtra por género: <a href="${SITE_URL}/comprar-beats-de-reggaeton">Reggaeton</a> · <a href="${SITE_URL}/beats-de-perreo">Perreo</a> · <a href="${SITE_URL}/comprar-beats-de-trap-latino">Trap Latino</a>.</p>
  <p>Todos los beats incluyen tag de productor en la versión gratuita. Compra cualquier licencia para recibir la versión sin tag, lista para distribución en plataformas. Licencias desde $29.99 USD. <a href="${enUrl}">English version</a>.</p>
</div>`;
  html = html.replace(/<body([^>]*)>/i, `<body$1>${crawlerBlock}`);

  // Pre-filter SPA grid via existing search input
  const seed = page.seedKeyword || '';
  if (seed) {
    const filterScript = `<script>
(function(){
  var seed=${JSON.stringify(seed)};
  function tryFilter(){
    var input=document.getElementById('search-input') || document.querySelector('input[type="search"]');
    if (!input) return false;
    input.value=seed;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  }
  var tries=0; var iv=setInterval(function(){ if (tryFilter() || ++tries>40){ clearInterval(iv); } },150);
})();
</script>`;
    html = html.replace(/<\/body>/i, filterScript + '</body>');
  }

  // Demote homepage hero H1 to H2 (Spanish landing supplies its own H1 in the
  // crawler block above).
  html = html.replace(/<h1\s+class="hero-h1-seo"\s+id="page-h1">([\s\S]*?)<\/h1>/i,
    '<h2 class="hero-h1-seo" id="page-h1">$1</h2>');

  return html;
}

// Render a single landing page using the same index.html template as beat pages.
// Same SEO override pattern: rewrite head, inject schema, add sr-only block,
// add a small script that pre-filters the SPA's grid via the existing search/
// filter infrastructure.
function renderLandingPage(template, page, beats) {
  const matches = beats.filter(b => { try { return page.filter(b); } catch (e) { return false; } });
  const url = `${SITE_URL}/${page.slug}`;
  // page.metaTitle wins if set (precise SERP control); otherwise auto-generate
  // from page.name with the year + brand suffix.
  const titleTag = page.metaTitle || `${page.name} ${new Date().getFullYear()} | O'Neil Beats`;
  // Trim to 155 chars — Google truncates meta description at ~160.
  const descRaw = page.intro.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const desc = descRaw.length > 160 ? descRaw.slice(0, 157).trimEnd() + '…' : descRaw;
  // First matching beat's cover for OG, fall back to default.
  const ogImage = (matches[0] && (matches[0].cover_art_url || matches[0].cover_url)) || `${SITE_URL}/og-image.jpg`;

  let html = template;

  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(titleTag)}</title>`);
  html = html.replace(/<meta\s+name="description"\s+content="[^"]*">/i,
    `<meta name="description" content="${esc(desc)}">`);
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*">/i,
    `<link rel="canonical" href="${url}">`);
  html = html.replace(/<meta\s+property="og:url"\s+content="[^"]*">/i,
    `<meta property="og:url" content="${url}">`);
  html = html.replace(/<meta\s+property="og:title"\s+content="[^"]*">/i,
    `<meta property="og:title" content="${esc(titleTag)}">`);
  html = html.replace(/<meta\s+property="og:description"\s+content="[^"]*">/i,
    `<meta property="og:description" content="${esc(desc)}">`);
  html = html.replace(/<meta\s+property="og:image"\s+content="[^"]*">/i,
    `<meta property="og:image" content="${esc(ogImage)}">`);
  html = html.replace(/<meta\s+name="twitter:title"\s+content="[^"]*">/i,
    `<meta name="twitter:title" content="${esc(titleTag)}">`);
  html = html.replace(/<meta\s+name="twitter:description"\s+content="[^"]*">/i,
    `<meta name="twitter:description" content="${esc(desc)}">`);
  html = html.replace(/<meta\s+name="twitter:image"\s+content="[^"]*">/i,
    `<meta name="twitter:image" content="${esc(ogImage)}">`);

  // CollectionPage + ItemList schema for the landing page
  const collectionLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: page.name,
    url,
    description: desc,
    isPartOf: { '@type': 'WebSite', name: "O'Neil Beats", url: SITE_URL },
    breadcrumb: { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Beats', item: SITE_URL + '/#catalog' },
      { '@type': 'ListItem', position: 3, name: page.name, item: url },
    ] },
    mainEntity: { '@type': 'ItemList', numberOfItems: matches.length, itemListElement: matches.slice(0, 25).map((b, i) => ({
      '@type': 'ListItem', position: i + 1,
      url: `${SITE_URL}/beat/${beatSlug(b)}`,
      name: b.title,
    })) },
  };
  const ldBlock = `<script type="application/ld+json" data-landing="${esc(page.slug)}">${JSON.stringify(collectionLd)}</script>`;
  html = html.replace(/<\/head>/i, ldBlock + '</head>');

  // Crawler-visible content block — H1, intro, beat list, internal links.
  // Informational pages (page.informational === true) skip the catalog
  // scaffolding — no "Available <X>" header, no beat list, no licensing
  // footer. Just H1 + intro + body. Useful for /about, /how-its-made,
  // /custom-beat, etc., where the body IS the content.
  const beatListHtml = matches.length
    ? `<ul>${matches.map(b => `<li><a href="${SITE_URL}/beat/${beatSlug(b)}">${esc(b.title)}</a> — ${esc(b.subgenre || b.genre || 'beat')}${b.bpm ? ', ' + esc(b.bpm) + ' BPM' : ''}${b.key ? ', ' + esc(b.key) : ''}</li>`).join('')}</ul>`
    : `<p>No exact matches in stock right now. <a href="mailto:produceroneil@gmail.com?subject=${encodeURIComponent('Custom ' + page.name + ' request')}">Email O'Neil</a> for a custom drop, or <a href="${SITE_URL}/">browse the full catalog</a>.</p>`;

  const crawlerBlock = page.informational
    ? `
<div class="sr-only" aria-hidden="false">
  <h1>${esc(page.h1)}</h1>
  <p>${esc(page.intro)}</p>
  ${page.body || ''}
</div>`
    : `
<div class="sr-only" aria-hidden="false">
  <h1>${esc(page.h1)}</h1>
  <p>${esc(page.intro)}</p>
  <h2>Available ${esc(page.name)}</h2>
  ${beatListHtml}
  ${page.body || ''}
  <p>Looking for a different sound? <a href="${SITE_URL}/">Browse all beats</a> or filter by genre: <a href="${SITE_URL}/reggaeton-beats">Reggaeton</a> · <a href="${SITE_URL}/trap-beats">Trap</a> · <a href="${SITE_URL}/perreo-beats">Perreo</a>.</p>
  <p>All beats from O'Neil come tagged with the producer voice tag. Buy any license to receive the untagged studio-clean version. Lease from $29.99, exclusive offers via the slider on each beat page.</p>
</div>`;
  html = html.replace(/<body([^>]*)>/i, `<body$1>${crawlerBlock}`);

  // Pre-filter the SPA grid: leverage the existing search input. After the SPA
  // hydrates, set the search input value to a query that matches this landing
  // page's beats. The simplest signal that always exists in tags is the genre
  // or subgenre name.
  // searchSeed pre-filters the SPA's grid via the existing search input. For
  // bpm-genre pages we strip the " Beats <N> BPM" tail so the seed matches
  // just the genre (the SPA's text search can't filter by numeric BPM, but
  // genre-filtering at least gets the visitor to the right neighborhood).
  const searchSeed =
    page.kind === 'genre' || page.kind === 'subgenre' || page.kind === 'mood-genre'
      ? page.name.replace(/\s+Beats$/i, '')
      : page.kind === 'bpm-genre'
        ? page.name.replace(/\s+Beats\s+\d+\s+BPM$/i, '')
        : (page.artist || '');
  const filterScript = `<script>
(function(){
  var seed=${JSON.stringify(searchSeed)};
  if (!seed) return;
  function tryFilter(){
    var input=document.getElementById('search-input') || document.querySelector('input[type="search"]');
    if (!input) return false;
    input.value=seed;
    input.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  }
  var tries=0;
  var iv=setInterval(function(){ if (tryFilter() || ++tries>40){ clearInterval(iv); } }, 150);
})();
</script>`;
  html = html.replace(/<\/body>/i, filterScript + '</body>');

  // Demote homepage hero H1 to H2 (landing page supplies its own H1 in the
  // crawler block above).
  html = html.replace(/<h1\s+class="hero-h1-seo"\s+id="page-h1">([\s\S]*?)<\/h1>/i,
    '<h2 class="hero-h1-seo" id="page-h1">$1</h2>');
  // Strip inherited broken hreflang first. Then add reciprocal bilingual
  // hreflang for the EN landing pages that have a Spanish mirror in
  // SPANISH_LANDING_PAGES (Google ignores one-way hreflang declarations).
  html = html.replace(/\s*<link\s+rel="alternate"\s+hreflang="(?:en|es|x-default)"[^>]*>/gi, '');
  const enPath = '/' + page.slug;
  const esMirror = SPANISH_LANDING_PAGES.find(s => s.enAlt === enPath);
  if (esMirror) {
    const esUrl = `${SITE_URL}/${esMirror.slug}`;
    const reciprocal = `
<link rel="alternate" hreflang="en" href="${url}">
<link rel="alternate" hreflang="es" href="${esUrl}">
<link rel="alternate" hreflang="x-default" href="${url}">`;
    html = html.replace(/<\/head>/i, reciprocal + '\n</head>');
  }

  return html;
}

// Hidden-but-indexable content. .sr-only is already defined in index.html's CSS.
function renderCrawlerBlock(beat, slug, url, related = []) {
  const tags = Array.isArray(beat.tags) ? beat.tags : (typeof beat.tags === 'string' ? beat.tags.split(',') : []);
  const desc = beat.description ? esc(String(beat.description).slice(0, 1500)) : '';
  // Related-beats list — Google reads this and gets explicit internal links
  // between same-genre/same-mood pages. Massively improves crawl depth and
  // gives the topical-cluster signal we currently lack.
  const relatedHtml = related.length ? `
  <h2>Related Beats</h2>
  <ul>
    ${related.map(b => {
      const rSlug = beatSlug(b);
      const rDetail = [b.subgenre || b.genre, b.bpm ? `${b.bpm} BPM` : null, b.key].filter(Boolean).join(' · ');
      return `<li><a href="${SITE_URL}/beat/${rSlug}">${esc(b.title)}</a>${rDetail ? ` — ${esc(rDetail)}` : ''}</li>`;
    }).join('')}
  </ul>` : '';
  // Genre catalog links — point at real /<genre>-beats landing pages instead
  // of the homepage hash-anchors that previously linked nowhere useful.
  const genreSlug = beat.genre ? slugify(beat.genre) + '-beats' : null;
  const browseLinks = [
    `<a href="${SITE_URL}/">Browse all beats</a>`,
    genreSlug ? `<a href="${SITE_URL}/${genreSlug}">${esc(beat.genre)} Beats</a>` : null,
    `<a href="${SITE_URL}/reggaeton-beats">Reggaeton</a>`,
    `<a href="${SITE_URL}/trap-beats">Trap</a>`,
    `<a href="${SITE_URL}/free-beats">Free Beats</a>`,
  ].filter(Boolean).join(' · ');
  return `
<div class="sr-only" aria-hidden="false">
  <h1>${esc(beat.title)} — ${esc(beat.genre || 'Rap')} Type Beat ${beat.bpm ? esc(beat.bpm) + ' BPM' : ''} ${esc(beat.key || '')}</h1>
  <p><strong>Buy "${esc(beat.title)}"</strong>, a${beat.mood ? ' ' + esc(String(beat.mood).toLowerCase()) : ''} ${esc(beat.subgenre || beat.genre || 'rap')} instrumental produced by O'Neil. Available at ${url}.</p>
  ${desc ? `<p>${desc}</p>` : ''}
  <ul>
    ${beat.bpm ? `<li>BPM: ${esc(beat.bpm)}</li>` : ''}
    ${beat.key ? `<li>Key: ${esc(beat.key)}</li>` : ''}
    ${beat.genre ? `<li>Genre: ${esc(beat.genre)}</li>` : ''}
    ${beat.subgenre ? `<li>Subgenre: ${esc(beat.subgenre)}</li>` : ''}
    ${beat.mood ? `<li>Mood: ${esc(beat.mood)}</li>` : ''}
    ${beat.lease_price ? `<li>Lease: $${esc(beat.lease_price)}</li>` : ''}
    ${beat.premium_price ? `<li>Premium Lease: $${esc(beat.premium_price)}</li>` : ''}
    ${beat.stems_price ? `<li>Stems / Track Out: $${esc(beat.stems_price)}</li>` : ''}
    ${beat.exclusive_price ? `<li>Exclusive Rights starting from: $${esc(beat.exclusive_price)}</li>` : ''}
  </ul>
  ${tags.length ? `<p>Tags: ${tags.map(t => esc(String(t).trim())).filter(Boolean).join(', ')}</p>` : ''}${relatedHtml}
  <p>${browseLinks}</p>
</div>`;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('[build-beat-pages] SUPABASE env vars missing — skipping beat-page generation. The deploy will succeed without per-beat SEO files.');
    return;
  }
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('[build-beat-pages] template not found at', TEMPLATE_PATH);
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  // DB column names: stem_price (singular), cover_url. The /beats API aliases these
  // to stems_price/cover_art_url for the SPA, but we go straight to Supabase here
  // so we use the canonical column names then alias in JS.
  const { data, error } = await supabase
    .from('beats')
    .select('id, title, genre, subgenre, bpm, key, mood, tags, description, lease_price, premium_price, stem_price, exclusive_price, audio_url, cover_url, active')
    .eq('active', true);

  if (error) {
    console.error('[build-beat-pages] Supabase error:', error.message);
    return; // don't fail the build
  }

  // Fetch approved reviews per beat. Falls back to empty if the reviews table
  // doesn't exist yet (first deploy before migrations/reviews.sql is applied).
  let reviewsByBeat = {};
  try {
    const { data: rows } = await supabase
      .from('reviews')
      .select('beat_id, rating, customer_name, title, body, verified_purchase, created_at')
      .eq('status', 'approved')
      .order('created_at', { ascending: false });
    for (const r of (rows || [])) {
      (reviewsByBeat[r.beat_id] = reviewsByBeat[r.beat_id] || []).push(r);
    }
    const reviewedBeats = Object.keys(reviewsByBeat).length;
    if (reviewedBeats > 0) console.log(`[build-beat-pages] loaded reviews for ${reviewedBeats} beats`);
  } catch (e) {
    console.log('[build-beat-pages] reviews table not present yet — schema injection skipped');
  }

  const beats = (data || []).filter(b => b && b.id && b.title).map(b => ({
    ...b,
    // Alias DB columns to the names the rest of this script (and the SPA's data shape) expects.
    stems_price: b.stem_price,
    cover_art_url: b.cover_url, // SPA uses cover_url; cover_art_url is just a synonym
    reviews: reviewsByBeat[b.id] || [],
  }));
  console.log(`[build-beat-pages] fetched ${beats.length} active beats`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Clean stale files (any .html in out dir not in current beat list)
  const liveSlugs = new Set(beats.map(b => beatSlug(b) + '.html'));
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (file.endsWith('.html') && !liveSlugs.has(file)) {
      try { fs.unlinkSync(path.join(OUT_DIR, file)); console.log('[build-beat-pages] pruned stale', file); }
      catch (e) { /* swallow */ }
    }
  }

  // OG banners are generated ON-DEMAND by server.js's /og/:slug.png route at
  // request time (sharp produces ~150-300 ms; Vercel CDN caches the response).
  // The build script does NOT pre-generate them anymore — Vercel's static
  // builders match files at deploy-prep, before vercel-build runs, so files
  // generated here would never make it into the deployed CDN. Each per-beat
  // page still references /og/{slug}.png in its <meta og:image> tags; the
  // first share/scrape per beat triggers generation, then everything else
  // hits the cache.
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  let written = 0;
  for (const beat of beats) {
    const slug = beatSlug(beat);
    // Pass true to opt the per-beat page into the on-demand /og/{slug}.png URL.
    const html = renderBeatPage(template, beat, slug, beats, slug);
    const outPath = path.join(OUT_DIR, slug + '.html');
    fs.writeFileSync(outPath, html, 'utf8');
    written++;
  }
  console.log(`[build-beat-pages] wrote ${written} beat pages → ${path.relative(ROOT, OUT_DIR)}`);

  // ── Landing pages (type-beat + genre/subgenre/mood) ──
  const landingPages = getAllLandingPages(beats);
  // Clean any stale landing pages no longer in the list. Each landing page
  // lives at public/{slug}.html (NOT under public/beat/).
  const liveLandings = new Set(landingPages.map(p => p.slug + '.html'));
  // Only prune files we know we generate — don't blow away other static html
  // (privacy.html, terms.html, etc.). We track our generated landings via a
  // marker file on disk.
  const PUBLIC_DIR = path.join(ROOT, 'public');
  const MARKER = path.join(PUBLIC_DIR, '.landing-pages.json');
  const previous = (() => {
    try { return JSON.parse(fs.readFileSync(MARKER, 'utf8')).slugs || []; } catch (_) { return []; }
  })();
  for (const oldSlug of previous) {
    if (!liveLandings.has(oldSlug + '.html')) {
      const stale = path.join(PUBLIC_DIR, oldSlug + '.html');
      try { if (fs.existsSync(stale)) { fs.unlinkSync(stale); console.log('[build-beat-pages] pruned stale landing', oldSlug); } } catch (_) {}
    }
  }

  let landingsWritten = 0;
  for (const page of landingPages) {
    const html = renderLandingPage(template, page, beats);
    fs.writeFileSync(path.join(PUBLIC_DIR, page.slug + '.html'), html, 'utf8');
    landingsWritten++;
  }
  fs.writeFileSync(MARKER, JSON.stringify({ slugs: landingPages.map(p => p.slug), generatedAt: new Date().toISOString() }, null, 2));
  console.log(`[build-beat-pages] wrote ${landingsWritten} landing pages → ${path.relative(ROOT, PUBLIC_DIR)}`);

  // ── Spanish landing pages ──
  let esWritten = 0;
  for (const page of SPANISH_LANDING_PAGES) {
    const html = renderSpanishLandingPage(template, page, beats);
    fs.writeFileSync(path.join(PUBLIC_DIR, page.slug + '.html'), html, 'utf8');
    esWritten++;
  }
  console.log(`[build-beat-pages] wrote ${esWritten} Spanish landing pages`);

  // ── Blog (cornerstone content) ──
  const BLOG_DIR = path.join(PUBLIC_DIR, 'blog');
  if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(BLOG_DIR, 'index.html'), renderBlogIndex(template), 'utf8');
  let blogWritten = 1;
  for (const post of BLOG_POSTS) {
    fs.writeFileSync(path.join(BLOG_DIR, post.slug + '.html'), renderBlogPost(template, post), 'utf8');
    blogWritten++;
  }
  console.log(`[build-beat-pages] wrote ${blogWritten} blog files → ${path.relative(ROOT, BLOG_DIR)}`);
}

if (require.main === module) {
  main().catch(e => { console.error('[build-beat-pages] FATAL', e); process.exit(0); /* don't fail build */ });
}

module.exports = { slugify, shortId, beatSlug, renderBeatPage, beatJsonLd, renderLandingPage, getAllLandingPages, TYPE_BEAT_ARTISTS, FEATURED_PAGES, BLOG_POSTS, renderBlogPost, renderBlogIndex, SPANISH_LANDING_PAGES, renderSpanishLandingPage, buildOgPngBuffer };
