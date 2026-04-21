// Title / description / tags / hashtags — all generated from beat metadata.
//
// YouTube's relevance signal for Music is strongest on TITLE + first 2 lines
// of description + tags, in that order. We put the store link as the very
// first description line so it's visible in the "Show more" collapsed view.

const cfg = require('./config');

// ── Mood banks per genre. Tags are the single biggest SEO lever we have,
// so we curate a bank per genre and blend in mood+bpm-derived tags. ───────
const GENRE_TAGS = {
  'reggaeton': [
    'reggaeton beat', 'reggaeton instrumental', 'reggaeton type beat',
    'perreo beat', 'latin trap beat', 'reggaeton 2026', 'bad bunny type beat',
    'feid type beat', 'rauw alejandro type beat', 'myke towers type beat',
    'dembow', 'reggaeton romantico', 'sensual reggaeton', 'reggaeton party',
    'reggaeton pista',
  ],
  'trap': [
    'trap beat', 'trap instrumental', 'trap type beat', 'dark trap beat',
    'hard trap beat', 'trap 2026', 'travis scott type beat', 'future type beat',
    'hip hop beat', '808 beat', 'trap rap beat', 'freestyle trap beat',
  ],
  'hip hop': [
    'hip hop beat', 'hip hop instrumental', 'rap beat', 'rap instrumental',
    'boom bap beat', 'hip hop type beat', 'old school hip hop', 'chill hip hop',
    'lofi hip hop', 'hip hop 2026', 'drake type beat', 'j cole type beat',
  ],
  'drill': [
    'drill beat', 'drill instrumental', 'drill type beat', 'uk drill beat',
    'ny drill beat', 'dark drill', 'hard drill beat', 'pop smoke type beat',
    'central cee type beat', 'drill 2026', 'sample drill',
  ],
  'dancehall': [
    'dancehall beat', 'dancehall instrumental', 'dancehall riddim',
    'dancehall type beat', 'vybz kartel type beat', 'afro dancehall',
    'jamaican beat', 'dancehall 2026', 'dancehall party',
  ],
  'afrobeats': [
    'afrobeats instrumental', 'afrobeats type beat', 'afro beat',
    'wizkid type beat', 'burna boy type beat', 'afroswing', 'amapiano beat',
    'afrobeats 2026', 'rema type beat', 'african beat',
  ],
  'latin': [
    'latin beat', 'latin instrumental', 'latin pop beat', 'bachata beat',
    'salsa beat', 'cumbia beat', 'latin type beat', 'latin 2026',
  ],
};

// Always-on brand tags appended to every upload.
const BRAND_TAGS = ['oneil beats', 'type beat', 'free beat', 'beats for sale', 'instrumental'];

// Build exactly 15–20 tags from genre bank + mood + bpm + brand, deduped.
function buildTags(beat) {
  const g = String(beat.genre || '').toLowerCase();
  const bank = GENRE_TAGS[g] || GENRE_TAGS['hip hop'];
  const mood = beat.mood ? [String(beat.mood).toLowerCase() + ' beat', String(beat.mood).toLowerCase() + ' type beat'] : [];
  const bpm  = beat.bpm  ? [`${beat.bpm} bpm beat`, `${beat.bpm}bpm ${g}`] : [];
  const raw = [...bank, ...mood, ...bpm, ...BRAND_TAGS];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const k = t.toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(k);
    if (out.length >= 20) break;
  }
  // YouTube allows 500 chars total across tags. Trim if any single tag is huge.
  return out.filter(t => t.length <= 30).slice(0, 20);
}

// Hashtags for IG / TikTok — top 8 from tags reformatted as #hashtag.
function buildHashtags(beat) {
  return buildTags(beat).slice(0, 8)
    .map(t => '#' + t.replace(/[^a-z0-9]+/g, ''))
    .filter(h => h.length > 1)
    .join(' ');
}

// ── Title — MUST include genre + BPM + key + mood ────────────────────────
// Pattern is optimized for YouTube Music search ("{genre} type beat" is the
// single highest-volume query in beat-sales SEO).
function buildYouTubeTitle(beat) {
  const genre = titleCase(beat.genre || 'Beat');
  const mood  = titleCase(beat.mood  || '');
  const bpm   = beat.bpm  ? `${beat.bpm} BPM` : '';
  const key   = beat.key  ? beat.key : '';
  const title = beat.title || 'Untitled';

  // Example: "[FREE] Smooth Reggaeton Type Beat 2026 "Luna" | 97 BPM C# Minor"
  const parts = [
    '[FREE]',
    mood ? mood : '',
    `${genre} Type Beat 2026`,
    `"${title}"`,
    '|',
    [bpm, key].filter(Boolean).join(' '),
  ].filter(Boolean);

  // YouTube hard-caps at 100 chars. Trim title segment if needed.
  let out = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (out.length > 100) out = out.slice(0, 97) + '...';
  return out;
}

// ── IG + TikTok caption ──────────────────────────────────────────────────
// Shorter, hashtag-heavy. Line 1 is still the store link.
function buildSocialCaption(beat) {
  const line1 = `🔥 Download this beat: ${cfg.STORE_URL}/${beat.beat_slug || ''}`;
  const line2 = `${titleCase(beat.beat_genre || beat.genre)} · ${beat.beat_bpm || beat.bpm || ''} BPM · ${beat.beat_key || beat.key || ''}`;
  const line3 = buildHashtags({
    genre: beat.beat_genre || beat.genre,
    mood:  beat.beat_mood  || beat.mood,
    bpm:   beat.beat_bpm   || beat.bpm,
  });
  return [line1, line2, line3].filter(Boolean).join('\n\n').slice(0, 2200); // IG cap
}

// ── YouTube description ──────────────────────────────────────────────────
// REQUIRED line 1: 🔥 Download this beat: oneilbeats.store/{slug}
function buildYouTubeDescription(beat) {
  const slug  = beat.beat_slug || '';
  const genre = titleCase(beat.beat_genre || beat.genre);
  const bpm   = beat.beat_bpm  || beat.bpm || '';
  const key   = beat.beat_key  || beat.key || '';
  const mood  = titleCase(beat.beat_mood || beat.mood || '');
  const title = beat.beat_title || beat.title || 'Untitled';

  const lines = [
    `🔥 Download this beat: ${cfg.STORE_URL}/${slug}`,  // MUST be line 1
    ``,
    `🎧 "${title}" — ${genre} · ${bpm} BPM · ${key}${mood ? ` · ${mood}` : ''}`,
    ``,
    `💎 License instantly at ${cfg.STORE_URL}`,
    `📧 Exclusive rights: produceroneil@gmail.com`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    `📲 Follow O'Neil Beats`,
    `IG: @oneilbeats`,
    `TikTok: @oneilbeats`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Tags:`,
    buildTags(beat).map(t => '#' + t.replace(/[^a-z0-9]+/g, '')).join(' '),
    ``,
    `(c) O'Neil Beats. This beat is FREE for non-profit use only. Any commercial`,
    `release — streaming, sales, sync — requires a license purchased at`,
    `${cfg.STORE_URL}. Unauthorized use may result in your release being taken`,
    `down and monetization claimed.`,
  ];
  return lines.join('\n');
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();
}

module.exports = {
  buildTags,
  buildHashtags,
  buildYouTubeTitle,
  buildYouTubeDescription,
  buildSocialCaption,
};
