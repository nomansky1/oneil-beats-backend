#!/usr/bin/env node
// Test harness for build-beat-pages renderers — validates SEO output without
// needing Supabase. Use to verify the H1-demotion + meta-description-trim +
// hreflang fixes generate correct HTML.

const fs = require('fs');
const path = require('path');
const {
  renderBeatPage, renderLandingPage, renderSpanishLandingPage,
  renderBlogPost, renderBlogIndex, BLOG_POSTS, SPANISH_LANDING_PAGES,
  FEATURED_PAGES,
} = require('./build-beat-pages.js');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const COLOR = { red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

function check(label, value, predicate, expected) {
  const ok = predicate(value);
  const mark = ok ? COLOR.green('✓') : COLOR.red('✗');
  const detail = ok ? COLOR.dim(String(value).slice(0, 80)) : `${COLOR.red('expected ' + expected)} — got: ${String(value).slice(0, 80)}`;
  console.log(`  ${mark} ${label}: ${detail}`);
  return ok;
}

function audit(name, html) {
  console.log(`\n${COLOR.yellow('▶')} ${name}`);
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const descMatch  = html.match(/<meta\s+name="description"\s+content="([^"]*)">/i);
  const h1s        = (html.match(/<h1[\s>]/gi) || []);
  const heroH1     = html.match(/<h1\s+class="hero-h1-seo"\s+id="page-h1">/i);
  const heroH2     = html.match(/<h2\s+class="hero-h1-seo"\s+id="page-h1">/i);
  const hreflangs  = (html.match(/<link\s+rel="alternate"\s+hreflang="[^"]*"[^>]*>/gi) || []);
  const canonical  = html.match(/<link\s+rel="canonical"\s+href="([^"]*)">/i);
  const ogType     = html.match(/<meta\s+property="og:type"\s+content="([^"]*)">/i);
  const jsonLdBlocks = (html.match(/<script\s+type="application\/ld\+json"[^>]*>/gi) || []).length;

  let allOk = true;
  allOk &= check('Title present',                 titleMatch?.[1] || '',          v => v.length > 0,  'non-empty');
  allOk &= check('Title ≤ 70 chars (SERP-safe)',  titleMatch?.[1] || '',          v => v.length <= 70, '≤70');
  allOk &= check('Meta desc ≤ 160 chars',         descMatch?.[1] || '',           v => v.length > 0 && v.length <= 160, '1-160');
  allOk &= check('Exactly 1 H1',                  h1s.length,                     v => v === 1,        '1');
  allOk &= check('Hero is H2 not H1',             { heroH1: !!heroH1, heroH2: !!heroH2 }, v => !v.heroH1 && v.heroH2, 'h2 only');
  allOk &= check('Canonical present',             canonical?.[1] || '',           v => v.length > 0,   'non-empty');
  allOk &= check('JSON-LD blocks ≥ 5',            jsonLdBlocks,                   v => v >= 5,         '≥5');
  return { allOk, titleLen: titleMatch?.[1].length, descLen: descMatch?.[1].length, h1Count: h1s.length, hreflangCount: hreflangs.length, hreflangs, ogType: ogType?.[1] };
}

const mockBeat = {
  id: 'test-uuid-1234-5678-90ab-cdef12345678',
  title: 'Luna',
  genre: 'Reggaeton',
  subgenre: 'Modern Reggaeton',
  bpm: 97,
  key: 'C# Minor',
  mood: 'Smooth',
  description: 'Silky reggaeton groove at 97 BPM that glides through C# minor. Built for melodic toplines.',
  cover_url: 'https://example.com/cover.png',
  audio_url: 'https://example.com/preview.mp3',
  lease_price: 29.99,
  premium_price: 79.99,
  stems_price: 199.99,
  exclusive_price: 999.99,
  reviews: [],
  tags: ['reggaeton', 'smooth'],
};

// Sibling beats so findRelatedBeats has candidates to score.
const mockCatalog = [
  mockBeat,
  { id: 'test-uuid-related-1', title: 'Te Veo', genre: 'Reggaeton', subgenre: 'Modern Reggaeton', bpm: 94, key: 'C Major', mood: 'Smooth', tags: [] },
  { id: 'test-uuid-related-2', title: 'Perreo Dark', genre: 'Reggaeton', subgenre: 'Perreo', bpm: 100, key: 'A Minor', mood: 'Dark', tags: [] },
  { id: 'test-uuid-related-3', title: 'Joker', genre: 'Trap', subgenre: 'Dark Trap', bpm: 140, key: 'C# Minor', mood: 'Dark', tags: [] },
  { id: 'test-uuid-related-4', title: 'Mar Azul', genre: 'Reggaeton', subgenre: 'Modern Reggaeton', bpm: 95, key: 'D Minor', mood: 'Smooth', tags: [] },
  { id: 'test-uuid-related-5', title: 'Cielo', genre: 'Reggaeton', subgenre: 'Reggaeton Pop', bpm: 98, key: 'C# Minor', mood: 'Smooth', tags: [] },
];

const mockEnPage = {
  slug: 'reggaeton-beats',
  name: 'Reggaeton Beats',
  h1: 'Buy Reggaeton Beats Online',
  intro: 'Modern reggaeton instrumentals — perreo, dembow, melódico. Lease or own. Instant MP3/WAV delivery.',
  filter: b => b.genre === 'Reggaeton',
  kind: 'genre',
};

const beatHtml         = renderBeatPage(TEMPLATE, mockBeat, 'luna-1234', mockCatalog);
const enLandingHtml    = renderLandingPage(TEMPLATE, mockEnPage, mockCatalog);
const esLandingHtml    = renderSpanishLandingPage(TEMPLATE, SPANISH_LANDING_PAGES[0], mockCatalog);
const blogPostHtml     = renderBlogPost(TEMPLATE, BLOG_POSTS[0]);
const blogIndexHtml    = renderBlogIndex(TEMPLATE);
const freeBeatsHtml    = renderLandingPage(TEMPLATE, FEATURED_PAGES.find(p => p.slug === 'free-beats'), mockCatalog);
const allBeatsHtml     = renderLandingPage(TEMPLATE, FEATURED_PAGES.find(p => p.slug === 'browse-beats'), mockCatalog);

const r1 = audit('Beat page (Luna)',                       beatHtml);
const r2 = audit('English landing (reggaeton-beats)',      enLandingHtml);
const r3 = audit(`Spanish landing (${SPANISH_LANDING_PAGES[0].slug})`, esLandingHtml);
const r4 = audit(`Blog post (${BLOG_POSTS[0].slug})`,       blogPostHtml);
const r5 = audit('Blog index',                              blogIndexHtml);
const r6 = audit('Featured page (/free-beats)',            freeBeatsHtml);
const r7 = audit('Featured page (/browse-beats)',          allBeatsHtml);

// Related Beats — verify the beat page links to its same-genre siblings.
console.log('\n' + COLOR.yellow('Related Beats sanity check'));
const relatedLinkMatches = (beatHtml.match(/<a href="https:\/\/oneilbeats\.store\/beat\/(?!luna-1234)[^"]+"/g) || []);
console.log(`  ${relatedLinkMatches.length >= 3 ? COLOR.green('✓') : COLOR.red('✗')} Beat page contains ≥3 internal links to other beats — got ${relatedLinkMatches.length}`);

console.log('\n' + COLOR.yellow('Hreflang report'));
console.log(`  Beat page:    ${r1.hreflangCount} (expected 0)  → ${r1.hreflangs.join(' ') || 'none'}`);
console.log(`  EN landing:   ${r2.hreflangCount} (expected 0)  → ${r2.hreflangs.join(' ') || 'none'}`);
console.log(`  ES landing:   ${r3.hreflangCount} (expected 3)  → ${r3.hreflangs.length ? r3.hreflangs.join('\n                ') : 'none'}`);
console.log(`  Blog post:    ${r4.hreflangCount} (expected 0)  → ${r4.hreflangs.join(' ') || 'none'}`);
console.log(`  Blog index:   ${r5.hreflangCount} (expected 0)  → ${r5.hreflangs.join(' ') || 'none'}`);
console.log(`  /free-beats:  ${r6.hreflangCount} (expected 0)  → ${r6.hreflangs.join(' ') || 'none'}`);
console.log(`  /browse-beats: ${r7.hreflangCount} (expected 0)  → ${r7.hreflangs.join(' ') || 'none'}`);

console.log('\n' + COLOR.yellow('Summary'));
const all = [r1, r2, r3, r4, r5, r6, r7];
const passed = all.filter(r => r.allOk).length;
console.log(`  ${passed}/${all.length} renderers pass all SEO checks`);
process.exit(passed === all.length ? 0 : 1);
