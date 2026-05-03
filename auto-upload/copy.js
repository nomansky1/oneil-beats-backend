// Title / description / tags / hashtags — all generated from beat metadata.
//
// YouTube's relevance signal for Music is strongest on TITLE + first 2 lines
// of description + tags, in that order. We put the store link as the very
// first description line so it's visible in the "Show more" collapsed view.
//
// This file is tuned hard for beat-sales SEO:
//   - "type beat" phrase in title (highest-volume query in the space)
//   - Genre + BPM + Key + Mood all surfaced in title AND first line of desc
//   - 15 artist-compare tags per genre (e.g. "bad bunny type beat"), plus
//     BPM-band variants, plus year tags, plus brand tags
//   - 500-char YouTube tag budget used aggressively
//   - Pinned-comment suggestion returned separately so the uploader can post
//     it as the first comment (YouTube boosts engagement from pinned comments)

const cfg = require('./config');

// Slug helper — must match scripts/build-beat-pages.js so YT descriptions
// link to the same per-beat SEO URL the store generates statically.
function _slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['"`’]/g, '').replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'beat';
}
function _shortId(uuid) { return String(uuid || '').replace(/-/g, '').slice(0, 4) || 'na00'; }
function beatStoreUrl(beat) {
  const id = beat.beat_id || beat.id || '';
  const title = beat.beat_title || beat.title || '';
  if (!id || !title) return cfg.STORE_URL || 'https://oneilbeats.store';
  return `${cfg.STORE_URL || 'https://oneilbeats.store'}/beat/${_slugify(title)}-${_shortId(id)}`;
}

// ── Mood banks per genre ──────────────────────────────────────────────────
// Each bank: 18-22 tags mixing genre-core, artist-compare, sub-style, and
// year. Dedup + brand appended at buildTags() time.
const GENRE_TAGS = {
  'reggaeton': [
    'reggaeton beat', 'reggaeton instrumental', 'reggaeton type beat',
    'perreo beat', 'latin trap beat', 'reggaeton 2026', 'reggaeton 2025',
    'bad bunny type beat', 'feid type beat', 'rauw alejandro type beat',
    'myke towers type beat', 'quevedo type beat', 'peso pluma type beat',
    'dembow', 'reggaeton romantico', 'sensual reggaeton', 'reggaeton party',
    'reggaeton pista', 'free reggaeton beat', 'reggaeton 2026 type beat',
  ],
  'trap': [
    'trap beat', 'trap instrumental', 'trap type beat', 'dark trap beat',
    'hard trap beat', 'trap 2026', 'trap 2025', 'travis scott type beat',
    'future type beat', 'lil baby type beat', '21 savage type beat',
    'playboi carti type beat', 'hip hop beat', '808 beat',
    'trap rap beat', 'freestyle trap beat', 'free trap beat', 'melodic trap',
  ],
  'hip hop': [
    'hip hop beat', 'hip hop instrumental', 'rap beat', 'rap instrumental',
    'boom bap beat', 'hip hop type beat', 'old school hip hop', 'chill hip hop',
    'lofi hip hop', 'hip hop 2026', 'drake type beat', 'j cole type beat',
    'kendrick lamar type beat', 'kanye west type beat',
    'free rap beat', 'storytelling beat', 'conscious hip hop', 'east coast beat',
  ],
  'drill': [
    'drill beat', 'drill instrumental', 'drill type beat', 'uk drill beat',
    'ny drill beat', 'dark drill', 'hard drill beat', 'pop smoke type beat',
    'central cee type beat', 'headie one type beat', 'sheff g type beat',
    'drill 2026', 'drill 2025', 'sample drill', 'sliding drill beat', 'free drill beat',
  ],
  'dancehall': [
    'dancehall beat', 'dancehall instrumental', 'dancehall riddim',
    'dancehall type beat', 'vybz kartel type beat', 'skeng type beat',
    'afro dancehall', 'jamaican beat', 'dancehall 2026', 'dancehall 2025',
    'dancehall party', 'free dancehall beat', 'riddim 2026',
  ],
  'afrobeats': [
    'afrobeats instrumental', 'afrobeats type beat', 'afro beat',
    'wizkid type beat', 'burna boy type beat', 'davido type beat',
    'rema type beat', 'asake type beat', 'afroswing', 'amapiano beat',
    'afrobeats 2026', 'afrobeats 2025', 'african beat', 'free afrobeats',
  ],
  'latin': [
    'latin beat', 'latin instrumental', 'latin pop beat', 'bachata beat',
    'salsa beat', 'cumbia beat', 'latin type beat', 'latin 2026', 'latin 2025',
    'urbano beat', 'free latin beat', 'bachata 2026',
  ],
};

// Always-on brand tags appended to every upload.
const BRAND_TAGS = [
  'oneil beats', 'o neil beats', 'type beat', 'free beat', 'free type beat',
  'beats for sale', 'instrumental', 'free for profit', 'free for non profit',
];

// BPM-band vocabulary — groups common tempo ranges to the phrasing buyers search.
function bpmBand(bpm) {
  const n = Number(bpm) || 0;
  if (!n) return [];
  if (n <= 70)   return ['slow beat', 'chill beat'];
  if (n <= 90)   return ['90 bpm beat', 'mid tempo beat'];
  if (n <= 100)  return ['100 bpm beat', 'reggaeton tempo'];
  if (n <= 110)  return ['110 bpm beat'];
  if (n <= 130)  return ['120 bpm beat', 'hip hop tempo'];
  if (n <= 150)  return ['140 bpm beat', 'trap tempo'];
  if (n <= 170)  return ['drill tempo'];
  return ['fast beat'];
}

// Build up to 25 tags from genre bank + mood + bpm-band + brand, deduped.
// YouTube hard-caps at 500 total characters across ALL tags — we budget
// greedily instead of just slicing to 20.
function buildTags(beat) {
  const g = String(beat.genre || beat.beat_genre || '').toLowerCase();
  const bank = GENRE_TAGS[g] || GENRE_TAGS['hip hop'];
  const mood = (beat.mood || beat.beat_mood) ? [
    String(beat.mood || beat.beat_mood).toLowerCase() + ' beat',
    String(beat.mood || beat.beat_mood).toLowerCase() + ' type beat',
    String(beat.mood || beat.beat_mood).toLowerCase() + ' ' + g + ' beat',
  ] : [];
  const bpm = (beat.bpm || beat.beat_bpm) ? [
    `${beat.bpm || beat.beat_bpm} bpm beat`,
    `${beat.bpm || beat.beat_bpm}bpm ${g}`,
  ].concat(bpmBand(beat.bpm || beat.beat_bpm)) : [];
  const key = (beat.key || beat.beat_key) ? [
    `${String(beat.key || beat.beat_key).toLowerCase()} beat`,
  ] : [];

  const raw = [...bank, ...mood, ...bpm, ...key, ...BRAND_TAGS];
  const seen = new Set();
  const out = [];
  let charsUsed = 0;
  // YouTube counts tags as comma-separated; each tag + 1 comma.
  const BUDGET = 495;
  for (const t of raw) {
    const k = String(t).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!k || k.length > 30 || seen.has(k)) continue;
    const cost = k.length + 1;
    if (charsUsed + cost > BUDGET) continue;
    seen.add(k); out.push(k); charsUsed += cost;
    if (out.length >= 25) break;
  }
  return out;
}

// Hashtags for IG / TikTok / YouTube description — top 10 from tags reformatted.
function buildHashtags(beat, limit = 10) {
  return buildTags(beat).slice(0, limit)
    .map(t => '#' + t.replace(/[^a-z0-9]+/g, ''))
    .filter(h => h.length > 1)
    .join(' ');
}

// ── Title — MUST include genre + "Type Beat" + BPM + key ─────────────────
// Pattern optimized for YouTube Music search. "Type beat" is the single
// highest-volume query in beat-sales SEO, followed by artist-compare ("X
// type beat").
//
// Shape: "[FREE] {mood} {Genre} Type Beat 2026 \"{title}\" | {bpm} BPM {key}"
// Cap 100 chars. If the full line blows the budget, we drop [FREE], then
// mood, then key, in that order — never the genre+"type beat" clause.
function buildYouTubeTitle(beat) {
  const genre = titleCase(beat.genre || beat.beat_genre || 'Beat');
  const mood  = titleCase(beat.mood  || beat.beat_mood  || '');
  const bpm   = (beat.bpm || beat.beat_bpm) ? `${beat.bpm || beat.beat_bpm} BPM` : '';
  const key   = (beat.key || beat.beat_key) || '';
  const title = beat.title || beat.beat_title || 'Untitled';

  const full = ['[FREE]', mood, `${genre} Type Beat 2026`, `"${title}"`, '|', [bpm, key].filter(Boolean).join(' ')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (full.length <= 100) return full;

  const noFree = [mood, `${genre} Type Beat 2026`, `"${title}"`, '|', [bpm, key].filter(Boolean).join(' ')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (noFree.length <= 100) return noFree;

  const noMood = [`${genre} Type Beat 2026`, `"${title}"`, '|', [bpm, key].filter(Boolean).join(' ')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (noMood.length <= 100) return noMood;

  const noKey = [`${genre} Type Beat 2026`, `"${title}"`, '|', bpm]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return noKey.length <= 100 ? noKey : noKey.slice(0, 97) + '...';
}

// Short-form YouTube title (for Shorts). Shorts titles truncate hard in
// the feed — front-load the keywords.
function buildYouTubeShortTitle(beat) {
  const genre = titleCase(beat.genre || beat.beat_genre || 'Beat');
  const bpm   = (beat.bpm || beat.beat_bpm) ? `${beat.bpm || beat.beat_bpm} BPM` : '';
  const title = beat.title || beat.beat_title || 'Untitled';
  const base = `${genre} Type Beat "${title}" ${bpm} #Shorts`.replace(/\s+/g, ' ').trim();
  return base.length <= 100 ? base : base.slice(0, 97) + '...';
}

// ── IG + TikTok caption ──────────────────────────────────────────────────
function buildSocialCaption(beat) {
  const beatId = beat.beat_id || beat.id || '';
  const line1 = `🔥 Download this beat: ${beatStoreUrl(beat)}`;
  const line2 = `${titleCase(beat.beat_genre || beat.genre)} · ${beat.beat_bpm || beat.bpm || ''} BPM · ${beat.beat_key || beat.key || ''}`;
  const line3 = buildHashtags(beat, 12);
  return [line1, line2, line3].filter(Boolean).join('\n\n').slice(0, 2200);
}

// ── YouTube description ──────────────────────────────────────────────────
// Structure (in priority order for SEO):
//   Line 1: store link (visible in collapsed "Show more")
//   Line 2: blank
//   Line 3: narrative hook (LLM-generated, or formulaic fallback)
//   License summary block
//   Producer contact
//   Social links
//   Tag block (hashtags for YouTube's own hashtag rails)
//   Related searches block (pure keyword real estate)
//   Legal / copyright notice
//
// Accepts optional `narrative` string — if present, used as the hook line
// instead of the formulaic fallback. Pass an LLM-generated blurb for
// maximum uniqueness.
function buildYouTubeDescription(beat, narrative) {
  const beatId = beat.beat_id || beat.id || '';
  const genre = titleCase(beat.beat_genre || beat.genre || '');
  const bpm   = beat.beat_bpm  || beat.bpm || '';
  const key   = beat.beat_key  || beat.key || '';
  const mood  = titleCase(beat.beat_mood || beat.mood || '');
  const title = beat.beat_title || beat.title || 'Untitled';

  const hook = narrative && String(narrative).trim()
    ? String(narrative).trim()
    : `"${title}" is a ${mood ? mood.toLowerCase() + ' ' : ''}${genre.toLowerCase()} type beat at ${bpm} BPM${key ? ' in ' + key : ''} — ready to record on and release.`;

  // Artist-compare "related searches" block. This is mostly keyword real
  // estate for YouTube's own recommendation algorithm.
  const related = (GENRE_TAGS[String(beat.beat_genre || beat.genre || '').toLowerCase()] || [])
    .filter(t => /type beat/i.test(t))
    .slice(0, 6)
    .map(t => '• ' + titleCase(t))
    .join('\n');

  const tagLine = buildTags(beat)
    .map(t => '#' + t.replace(/[^a-z0-9]+/g, ''))
    .join(' ');

  // "Explore more" deep-links to other site sections — pushes YouTube viewers
  // into the genre catalog, free-beats landing, and the license-guide blog.
  // YouTube's algorithm reads description URLs to associate the video with the
  // domain's other content; this strengthens topical clustering. Each link
  // also doubles as a domain-authority backlink earned per upload.
  const genreSlug = _slugify(beat.beat_genre || beat.genre || 'reggaeton');
  const exploreLines = [
    `🎼 MORE FROM O'NEIL BEATS`,
    `▸ Free tagged beats: ${cfg.STORE_URL}/free-beats`,
    `▸ ${genre || 'Reggaeton'} catalog: ${cfg.STORE_URL}/${genreSlug}-beats`,
    `▸ Browse all beats: ${cfg.STORE_URL}/beats`,
    `▸ Lease vs Exclusive guide: ${cfg.STORE_URL}/blog/lease-vs-exclusive-beat-license-guide`,
    `▸ Free Beat Friday email: ${cfg.STORE_URL}/#free-signup`,
  ].join('\n');

  const lines = [
    `🔥 Download this beat: ${beatStoreUrl(beat)}`,
    ``,
    hook,
    ``,
    `🎧 "${title}" — ${[genre, bpm ? bpm + ' BPM' : '', key, mood].filter(Boolean).join(' · ')}`,
    ``,
    `💎 LICENSING`,
    `▸ Lease: instant download at ${cfg.STORE_URL}`,
    `▸ Exclusive rights: produceroneil@gmail.com`,
    `▸ Free to use tagged version for non-profit / profile / demo only.`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    `📲 Follow O'Neil Beats`,
    `▸ Store: ${cfg.STORE_URL}`,
    `▸ Instagram: @oneilbeats`,
    `▸ TikTok: @oneilbeats`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    exploreLines,
    ``,
    related ? `🔎 Related searches:\n${related}\n` : '',
    `Tags:`,
    tagLine,
    ``,
    `© O'Neil Beats. Tagged MP3 is FREE for non-profit / demo use only. Any`,
    `commercial release (streaming, sales, sync, paid shows) requires a`,
    `license purchased at ${cfg.STORE_URL}. Unauthorized commercial use may`,
    `result in takedown + monetization claim.`,
  ].filter(l => l !== undefined && l !== null);
  return lines.join('\n');
}

// ── YouTube Shorts description ───────────────────────────────────────────
// Shorts descriptions are truncated aggressively in the feed. Front-load
// the store link and a hashtag set.
function buildYouTubeShortDescription(beat, narrative) {
  const beatId = beat.beat_id || beat.id || '';
  const title = beat.beat_title || beat.title || 'Untitled';
  const genre = titleCase(beat.beat_genre || beat.genre || '');
  const hash  = buildHashtags(beat, 12) + ' #Shorts #TypeBeat #FreeBeats';

  const hook = narrative && String(narrative).trim()
    ? String(narrative).trim().split('.')[0]
    : `${genre} type beat "${title}" — full version on the channel.`;

  return [
    `🔥 Full beat: ${beatStoreUrl(beat)}`,
    ``,
    hook,
    ``,
    hash,
  ].join('\n');
}

// ── Pinned comment ───────────────────────────────────────────────────────
// YouTube weighs channel engagement heavily. A pinned comment with the
// store link + CTA drives click-through. The uploader posts this as the
// first comment right after the video goes live.
function buildPinnedComment(beat) {
  const beatId = beat.beat_id || beat.id || '';
  return `🔥 Download + license: ${beatStoreUrl(beat)}\n💎 Free for non-profit • Exclusive: produceroneil@gmail.com\n📩 Drop your track with this beat in the replies — I'll check them all.`;
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();
}

module.exports = {
  buildTags,
  buildHashtags,
  buildYouTubeTitle,
  buildYouTubeShortTitle,
  buildYouTubeDescription,
  buildYouTubeShortDescription,
  buildSocialCaption,
  buildPinnedComment,
};
