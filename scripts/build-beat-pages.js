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
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || /smooth|melodic/i.test(b.mood || '')) },
  { artist: 'Feid',            slug: 'feid-type-beat',           intro: 'Feid (FERXXO) made melodic perreo and modern reggaeton with airy synths and conversational flows the global standard. These beats fit that smooth, vibe-heavy sound.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || b.subgenre === 'Perreo' || /smooth|chill|romantic/i.test(b.mood || '')) },
  { artist: 'Rauw Alejandro',  slug: 'rauw-alejandro-type-beat', intro: 'Rauw Alejandro fuses modern reggaeton, R&B, and electronic textures into hits that work on radio and the club. Pick beats with melodic chord work and smooth percussion.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Modern Reggaeton' || b.subgenre === 'Reggaeton Pop' || /smooth|romantic|sensual/i.test(b.mood || '')) },
  { artist: 'Karol G',         slug: 'karol-g-type-beat',        intro: 'Karol G brought powerful vocals, perreo energy, and reggaeton-pop crossover to global stages. Match her energy with high-impact reggaeton and reggaeton-pop instrumentals.',
    filter: (b) => b.genre === 'Reggaeton' && (b.subgenre === 'Reggaeton Pop' || b.subgenre === 'Modern Reggaeton' || /energetic|powerful|bouncy/i.test(b.mood || '')) },
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
  // ── Trap / Hip-Hop ──
  { artist: 'Future',          slug: 'future-type-beat',         intro: 'Future popularized dark, atmospheric trap with auto-tuned melodies over hard 808s. Dark trap with moody, atmospheric production matches.',
    filter: (b) => b.genre === 'Trap' && (b.subgenre === 'Dark Trap' || /dark|moody|atmospheric/i.test(b.mood || '')) },
  { artist: 'Lil Baby',        slug: 'lil-baby-type-beat',       intro: 'Lil Baby blends melodic trap delivery with street narratives. Melodic trap or smooth dark trap work for his sound.',
    filter: (b) => b.genre === 'Trap' || (b.subgenre || '').toLowerCase().includes('trap') },
  { artist: 'Metro Boomin',    slug: 'metro-boomin-type-beat',   intro: 'Metro Boomin defined modern trap production — cinematic 808s, melodic minor-key keys, dark atmosphere. Pick dark or atmospheric trap.',
    filter: (b) => b.genre === 'Trap' && (b.subgenre === 'Dark Trap' || /dark|cinematic|atmospheric/i.test(b.mood || '')) },
  { artist: 'Southside',       slug: 'southside-type-beat',      intro: 'Southside (808 Mafia) shaped the heavy 808-driven trap sound. Hard, dark trap with prominent low-end fits.',
    filter: (b) => b.genre === 'Trap' || (b.subgenre || '').toLowerCase().includes('dark trap') },
  { artist: 'J Cole',          slug: 'j-cole-type-beat',         intro: 'J Cole works in lyrical boom-bap and conscious hip-hop with jazzy chord progressions. Pick boom-bap or East Coast lyrical instrumentals.',
    filter: (b) => b.genre === 'Boom Bap' || b.subgenre === 'Lyrical' || b.subgenre === 'East Coast' || b.subgenre === 'Conscious' },
  { artist: 'Drake',           slug: 'drake-type-beat',          intro: 'Drake mixes melodic trap, R&B, and Caribbean-inflected dancehall. Modern Dancehall, Alternative R&B, or melodic trap all fit his range.',
    filter: (b) => b.subgenre === 'Modern Dancehall' || b.subgenre === 'Alternative R&B' || (b.genre === 'Trap' && /smooth|melodic/i.test(b.mood || '')) },
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
    filter: t.filter,
    artist: t.artist,
  }));
  return [...typeBeats, ...deriveLandingPages(beats)];
}

// Render a single landing page using the same index.html template as beat pages.
// Same SEO override pattern: rewrite head, inject schema, add sr-only block,
// add a small script that pre-filters the SPA's grid via the existing search/
// filter infrastructure.
function renderLandingPage(template, page, beats) {
  const matches = beats.filter(b => { try { return page.filter(b); } catch (e) { return false; } });
  const url = `${SITE_URL}/${page.slug}`;
  const titleTag = `${page.name} ${new Date().getFullYear()} | O'Neil Beats`;
  const desc = (page.intro.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()).slice(0, 280);
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

  // Crawler-visible content block — H1, intro, beat list, internal links
  const beatListHtml = matches.length
    ? `<ul>${matches.map(b => `<li><a href="${SITE_URL}/beat/${beatSlug(b)}">${esc(b.title)}</a> — ${esc(b.subgenre || b.genre || 'beat')}${b.bpm ? ', ' + esc(b.bpm) + ' BPM' : ''}${b.key ? ', ' + esc(b.key) : ''}</li>`).join('')}</ul>`
    : `<p>No exact matches in stock right now. <a href="mailto:produceroneil@gmail.com?subject=${encodeURIComponent('Custom ' + page.name + ' request')}">Email O'Neil</a> for a custom drop, or <a href="${SITE_URL}/">browse the full catalog</a>.</p>`;

  const crawlerBlock = `
<div class="sr-only" aria-hidden="false">
  <h1>${esc(page.h1)}</h1>
  <p>${esc(page.intro)}</p>
  <h2>Available ${esc(page.name)}</h2>
  ${beatListHtml}
  <p>Looking for a different sound? <a href="${SITE_URL}/">Browse all beats</a> or filter by genre: <a href="${SITE_URL}/reggaeton-beats">Reggaeton</a> · <a href="${SITE_URL}/trap-beats">Trap</a> · <a href="${SITE_URL}/perreo-beats">Perreo</a>.</p>
  <p>All beats from O'Neil come tagged with the producer voice tag. Buy any license to receive the untagged studio-clean version. Lease from $29.99, exclusive offers via the slider on each beat page.</p>
</div>`;
  html = html.replace(/<body([^>]*)>/i, `<body$1>${crawlerBlock}`);

  // Pre-filter the SPA grid: leverage the existing search input. After the SPA
  // hydrates, set the search input value to a query that matches this landing
  // page's beats. The simplest signal that always exists in tags is the genre
  // or subgenre name.
  const searchSeed = page.kind === 'genre' || page.kind === 'subgenre' || page.kind === 'mood-genre'
    ? page.name.replace(/\s+Beats$/i, '')
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
}

if (require.main === module) {
  main().catch(e => { console.error('[build-beat-pages] FATAL', e); process.exit(0); /* don't fail build */ });
}

module.exports = { slugify, shortId, beatSlug, renderBeatPage, beatJsonLd, renderLandingPage, getAllLandingPages, TYPE_BEAT_ARTISTS };
