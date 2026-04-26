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
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'public', 'index.html');
const OUT_DIR = path.join(ROOT, 'public', 'beat');
const SITE_URL = 'https://oneilbeats.store';

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

// ── Build per-beat <title>, description, schema ────────────────────────────
function beatTitleTag(beat) {
  const year = new Date().getFullYear();
  const parts = [
    beat.title,
    `${beat.genre || 'Rap'} Type Beat ${year}`,
    beat.bpm ? `${beat.bpm} BPM` : null,
    beat.key || null,
  ].filter(Boolean);
  return `${parts.join(' | ')} — Buy at O'Neil Beats`;
}
function beatDescription(beat) {
  const bpm = beat.bpm ? `${beat.bpm} BPM` : '';
  const key = beat.key ? ` in ${beat.key}` : '';
  const mood = beat.mood ? ` ${String(beat.mood).toLowerCase()}` : '';
  const sub = beat.subgenre || beat.genre || 'rap';
  const desc1 = `Buy "${beat.title}" — a${mood} ${sub} type beat${bpm ? ' at ' + bpm : ''}${key}.`;
  let desc2 = '';
  if (beat.description) {
    const d = String(beat.description).replace(/\s+/g, ' ').trim();
    const firstSentence = d.split(/(?<=[.!?])\s/)[0] || d;
    desc2 = ' ' + firstSentence.slice(0, 160);
  }
  const desc3 = ' Lease from $29.99. Instant MP3/WAV delivery. Reggaeton, trap, hip-hop, drill instrumentals by O\'Neil.';
  return (desc1 + desc2 + desc3).slice(0, 320);
}

// MusicRecording + Product schema. Google Music carousel + product rich snippets.
function beatJsonLd(beat, slug) {
  const url = `${SITE_URL}/beat/${slug}`;
  const offers = [];
  if (beat.lease_price)     offers.push({ '@type': 'Offer', name: 'Basic Lease (MP3)', price: String(beat.lease_price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url });
  if (beat.premium_price)   offers.push({ '@type': 'Offer', name: 'Premium Lease (MP3 + WAV)', price: String(beat.premium_price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url });
  if (beat.stems_price)     offers.push({ '@type': 'Offer', name: 'Stems / Track Out', price: String(beat.stems_price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url });
  if (beat.exclusive_price) offers.push({ '@type': 'Offer', name: 'Exclusive Rights', price: String(beat.exclusive_price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url });

  const node = {
    '@context': 'https://schema.org',
    '@type': ['MusicRecording', 'Product'],
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
function renderBeatPage(template, beat, slug) {
  const url = `${SITE_URL}/beat/${slug}`;
  const titleTag = beatTitleTag(beat);
  const descTag  = beatDescription(beat);
  const cover    = beat.cover_art_url || beat.cover_url || `${SITE_URL}/og-image.jpg`;
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
  // og:type for individual song page
  html = html.replace(/<meta\s+property="og:type"\s+content="website">/i,
    `<meta property="og:type" content="music.song">`);

  // twitter:title, twitter:description, twitter:image
  html = html.replace(/<meta\s+name="twitter:title"\s+content="[^"]*">/i,
    `<meta name="twitter:title" content="${esc(ogTitle)}">`);
  html = html.replace(/<meta\s+name="twitter:description"\s+content="[^"]*">/i,
    `<meta name="twitter:description" content="${esc(descTag)}">`);
  html = html.replace(/<meta\s+name="twitter:image"\s+content="[^"]*">/i,
    `<meta name="twitter:image" content="${esc(cover)}">`);

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
  const crawlerBlock = renderCrawlerBlock(beat, slug, url);
  html = html.replace(/<body([^>]*)>/i, `<body$1>${crawlerBlock}`);

  return html;
}

// Hidden-but-indexable content. .sr-only is already defined in index.html's CSS.
function renderCrawlerBlock(beat, slug, url) {
  const tags = Array.isArray(beat.tags) ? beat.tags : (typeof beat.tags === 'string' ? beat.tags.split(',') : []);
  const desc = beat.description ? esc(String(beat.description).slice(0, 1500)) : '';
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
  ${tags.length ? `<p>Tags: ${tags.map(t => esc(String(t).trim())).filter(Boolean).join(', ')}</p>` : ''}
  <p><a href="${SITE_URL}/">Browse all beats</a> · <a href="${SITE_URL}/#catalog">Reggaeton</a> · <a href="${SITE_URL}/#catalog">Trap</a> · <a href="${SITE_URL}/#catalog">Drill</a></p>
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
  const beats = (data || []).filter(b => b && b.id && b.title).map(b => ({
    ...b,
    // Alias DB columns to the names the rest of this script (and the SPA's data shape) expects.
    stems_price: b.stem_price,
    cover_art_url: b.cover_url, // SPA uses cover_url; cover_art_url is just a synonym
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

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  let written = 0;
  for (const beat of beats) {
    const slug = beatSlug(beat);
    const html = renderBeatPage(template, beat, slug);
    const outPath = path.join(OUT_DIR, slug + '.html');
    fs.writeFileSync(outPath, html, 'utf8');
    written++;
  }
  console.log(`[build-beat-pages] wrote ${written} beat pages → ${path.relative(ROOT, OUT_DIR)}`);
}

if (require.main === module) {
  main().catch(e => { console.error('[build-beat-pages] FATAL', e); process.exit(0); /* don't fail build */ });
}

module.exports = { slugify, shortId, beatSlug, renderBeatPage, beatJsonLd };
