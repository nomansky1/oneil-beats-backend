// ─── O'Neil Beats Backend Server v3 ──────────────────────────────────────────
// Express API: Supabase DB/Storage + Stripe checkout + license delivery
// Migrated from Google Drive/Sheets to Supabase for reliable file uploads

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const path = require('path');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');

// Anthropic client — lazy, so server still boots if key is missing
let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const ANTON_FONT_PATH = path.join(__dirname, 'assets', 'fonts', 'Anton-Regular.ttf');

const {
  fetchBeatsFromDB,
  addBeatToDB,
  updateBeatInDB,
  deleteBeatInDB,
  incrementPlayCount,
  uploadFileToStorage,
  uploadAudioToStorage,
  uploadCoverToStorage,
  uploadBase64ToStorage,
  createOrder,
  fulfillOrder,
  getOrderById,
  getOrdersByEmail,
  getSupabaseClient,
  SUPABASE_URL,
  registerPushToken,
  getPushTokens,
  removePushToken,
  pgQuery,
} = require('./supabaseApi');
const { generateLicensePDF, generateSplitSheetPDF, LICENSE_TERMS } = require('./licenseGenerator');

// Auto-upload pipeline (YouTube first; IG/TikTok gated by env flags).
// Non-fatal on load — a misconfig here must NOT block the core backend boot.
let autoUpload = null;
try {
  autoUpload = require('./auto-upload');
} catch (e) {
  console.warn('[auto-upload] module failed to load:', e.message);
}

// ── AI Cover Art — mood-to-prompt mapping ─────────────────────────────────────
const COVER_THEMES = {
  'Aggressive': {
    prompts: [
      'dark recording studio with red neon lights and smoke, urban gritty atmosphere, music culture',
      'burning microphone in dark studio, fire and embers, intense red and black tones',
      'underground hip hop studio with graffiti walls, red lighting, raw energy',
    ],
  },
  'Energetic': {
    prompts: [
      'vibrant music studio with gold and neon lights, dynamic energy, city skyline through window',
      'DJ turntable with golden sparks flying, electric energy, concert atmosphere',
      'recording booth with colorful LED strips, headphones floating, burst of energy',
    ],
  },
  'Dark': {
    prompts: [
      'moody purple-lit recording booth, vintage vinyl records, mysterious shadows, noir style',
      'foggy dark alley with music notes floating, purple haze, cinematic atmosphere',
      'silhouette of producer at mixing console, deep purple and blue tones, atmospheric',
    ],
  },
  'Uplifting': {
    prompts: [
      'golden hour light streaming through studio windows, warm tones, inspirational vibes',
      'sunrise over city with music waves in the sky, warm orange and gold palette',
      'open air recording session at sunset, acoustic guitar, peaceful and warm',
    ],
  },
  'Melancholic': {
    prompts: [
      'rainy window with reflections of city lights, vintage microphone, blue tones, emotional',
      'lone piano in dimly lit room, rain drops on window, melancholy atmosphere',
      'empty recording studio at night, single blue light, abandoned headphones on console',
    ],
  },
  'Smooth': {
    prompts: [
      'jazz club atmosphere, warm amber lighting, saxophone silhouette, velvet curtains',
      'smooth R&B studio lounge with leather chair, warm wood tones, soft golden light',
      'intimate concert venue with candles, acoustic instruments, cozy warm atmosphere',
    ],
  },
  'Chill': {
    prompts: [
      'cozy lo-fi bedroom studio with plants, sunset through window, headphones on desk, aesthetic',
      'rooftop music session at dusk, city skyline, string lights, relaxed vibes',
      'vinyl record player in cozy room, warm lamp light, books and plants, peaceful',
    ],
  },
  'Dreamy': {
    prompts: [
      'ethereal clouds with floating music notes, pastel pink and purple, surreal dreamscape',
      'underwater recording studio, bioluminescent lights, floating instruments, magical',
      'starry night sky with constellation forming a treble clef, cosmic purple palette',
    ],
  },
};

// ── Email Setup ────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

// ── Push Notification Helper ──────────────────────────────────────
async function sendPushNotification(expoPushTokens, title, body, data = {}) {
  const notificationPayloads = expoPushTokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
  }));

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notificationPayloads),
    });
    const result = await response.json();
    return result;
  } catch (err) {
    console.error('Push notification error:', err);
    throw err;
  }
}

// ── Express Setup ────────────────────────────────────────────────────────────
const app = express();
// Vercel terminates TLS at the edge and forwards via HTTP, so without
// `trust proxy` Express reads `req.protocol === 'http'` for all requests
// even though the public URL is HTTPS. That broke canonical / og:audio /
// schema URLs in the share-link page (rendered as http://oneilbeats.store/...).
// Trusting the proxy header makes req.protocol + req.ip + req.ips correct.
app.set('trust proxy', true);
app.use(cors({
  origin: ['https://oneilbeats.store', 'https://www.oneilbeats.store', /localhost/, /\.vercel\.app$/],
  credentials: true,
}));

// Baseline security headers — applied to every response. Vercel doesn't
// inject these by default, so the storefront is otherwise embeddable in any
// iframe (clickjacking risk) and lacks MIME-sniffing/referrer protections.
// Kept conservative so the SPA + analytics + Stripe + GA4 keep working:
//   - X-Frame-Options DENY blocks iframe embedding
//   - X-Content-Type-Options nosniff blocks MIME-confusion attacks
//   - Referrer-Policy strict-origin-when-cross-origin protects user privacy
//     while still letting GA4/Stripe see same-origin paths
//   - Permissions-Policy disables geolocation/camera/mic the SPA never asks
//     for, so a future XSS can't request them either.
// Intentionally NOT enabling CSP yet — the SPA loads from Vercel + Supabase
// + Stripe + Google + Cloudflare; a too-strict CSP would break checkout.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(self "https://js.stripe.com")');
  next();
});
// ── SEO: shared URL-list builder ───────────────────────────────────────────
// Single source of truth for "every public URL on the site." Used by both the
// /sitemap.xml route and the IndexNow ping so they never drift. Returns a flat
// array of absolute URLs.
async function buildAllSiteUrls() {
  const { beatSlug, getAllLandingPages, BLOG_POSTS, SPANISH_LANDING_PAGES } = require('./scripts/build-beat-pages');
  const beats = await fetchBeatsFromDB().catch(() => []);
  const SITE = 'https://oneilbeats.store';
  const landingPages = getAllLandingPages(beats || []);
  const urls = [
    `${SITE}/`,
    `${SITE}/blog`,
    ...(BLOG_POSTS || []).map(p => `${SITE}/blog/${p.slug}`),
    ...(SPANISH_LANDING_PAGES || []).map(p => `${SITE}/${p.slug}`),
    ...landingPages.map(p => `${SITE}/${p.slug}`),
    ...(beats || []).filter(b => b && b.id && b.title).map(b => `${SITE}/beat/${beatSlug(b)}`),
  ];
  // De-dupe + drop anchor-only URLs (IndexNow rejects fragments)
  return [...new Set(urls)].filter(u => !u.includes('#'));
}

// ── IndexNow — instant crawl notification for Bing, Yandex, Seznam, Naver ───
// IndexNow lets us push "these URLs changed, crawl them now" instead of waiting
// for organic discovery. Google does NOT participate (use Search Console for
// Google), but Bing + Yandex cover meaningful Spanish-language reggaeton search
// traffic in LatAm + Spain. Key is served at /{key}.txt to prove ownership.
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'd5d53a46de9e073808d4c70539f043fc';

// Serve the ownership-proof key file at /{key}.txt
app.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
  res.type('text/plain').send(INDEXNOW_KEY);
});

// Push all site URLs to IndexNow. Returns { submitted, status }.
async function pingIndexNow() {
  const urls = await buildAllSiteUrls();
  const body = {
    host: 'oneilbeats.store',
    key: INDEXNOW_KEY,
    keyLocation: `https://oneilbeats.store/${INDEXNOW_KEY}.txt`,
    urlList: urls,
  };
  const r = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return { submitted: urls.length, status: r.status };
}

// Manual trigger (admin-gated). Call after adding new beats/pages for an
// instant re-crawl request. Vercel deploys can also hit this.
app.post('/admin/indexnow-ping', requireAdminKey, async (req, res) => {
  try {
    const result = await pingIndexNow();
    console.log(`[indexnow] submitted ${result.submitted} URLs → status ${result.status}`);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[indexnow] ping error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Dynamic /sitemap.xml — must be registered BEFORE express.static so it
// overrides any stale public/sitemap.xml file. Lists every active beat as a
// per-URL <url> entry, plus the homepage and primary section anchors.
app.get('/sitemap.xml', async (req, res) => {
  try {
    const { beatSlug, getAllLandingPages, BLOG_POSTS, SPANISH_LANDING_PAGES } = require('./scripts/build-beat-pages');
    const beats = await fetchBeatsFromDB().catch(() => []);
    const SITE = 'https://oneilbeats.store';
    const today = new Date().toISOString().slice(0, 10);
    const landingPages = getAllLandingPages(beats || []);
    const urls = [
      `<url><loc>${SITE}/</loc><changefreq>daily</changefreq><priority>1.0</priority><lastmod>${today}</lastmod></url>`,
      `<url><loc>${SITE}/#catalog</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
      `<url><loc>${SITE}/#licenses</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>`,
      `<url><loc>${SITE}/#faq</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`,
      // Blog index + per-post URLs
      `<url><loc>${SITE}/blog</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>${today}</lastmod></url>`,
      ...(BLOG_POSTS || []).map(p => `<url><loc>${SITE}/blog/${p.slug}</loc><changefreq>monthly</changefreq><priority>0.75</priority><lastmod>${p.publishedDate}</lastmod></url>`),
      // Spanish landing pages — bilingual SEO with reciprocal hreflang
      ...(SPANISH_LANDING_PAGES || []).map(p => {
        const enUrl = `${SITE}${p.enAlt}`;
        return `<url><loc>${SITE}/${p.slug}</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>${today}</lastmod><xhtml:link rel="alternate" hreflang="es" href="${SITE}/${p.slug}"/><xhtml:link rel="alternate" hreflang="en" href="${enUrl}"/></url>`;
      }),
      // Landing pages — type-beat (highest commercial intent), then genre/subgenre/mood combos
      ...landingPages.map(p => {
        const priority = p.kind === 'type-beat' ? '0.85' : p.kind === 'genre' ? '0.8' : '0.7';
        return `<url><loc>${SITE}/${p.slug}</loc><changefreq>weekly</changefreq><priority>${priority}</priority><lastmod>${today}</lastmod></url>`;
      }),
      // Per-beat pages
      ...(beats || []).filter(b => b && b.id && b.title).map(b => {
        const slug = beatSlug(b);
        // fetchBeatsFromDB returns `createdAt` as a Date object (pg auto-
        // deserializes timestamptz). Old code called `.slice(0, 10)` directly,
        // which throws on Date instances and made the whole sitemap route
        // 500 with an empty <urlset/>. `new Date(...).toISOString()` handles
        // Date objects, ISO strings, and epoch numbers — bulletproof.
        const lastmod = new Date(b.createdAt || b.created_at || today).toISOString().slice(0, 10);
        return `<url><loc>${SITE}/beat/${slug}</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>${lastmod}</lastmod></url>`;
      }),
    ].join('\n  ');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n  ${urls}\n</urlset>\n`;
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.send(xml);
  } catch (e) {
    console.error('sitemap error:', e.message);
    res.status(500).send('<?xml version="1.0"?><urlset/>');
  }
});

// `extensions: ['html']` makes /bad-bunny-type-beat resolve to public/bad-bunny-type-beat.html
// (without this, all the SEO landing pages 404 — they live as bare slugs without trailing .html).
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ── /download/android-apk — stable redirect to the current APK ──────────────
// Direct-sideload alternative to Play Store while we wait out Google's 14-day
// closed-test policy. Reads ANDROID_APK_URL env var (Vercel-configurable) so
// future APK builds can swap the download target without redeploying. Falls
// back to a hardcoded GCS URL of the v1.8.20 build so the route works out of
// the box on first deploy.
// 2026-05-21 — added when Google's new-account 14d/12-tester gate blocked us
// from a fast public Android launch.
const _APK_FALLBACK = 'https://storage.googleapis.com/oneilbeats-media/auto-upload/1779345463239_downloads_oneil-beats-android-v1.8.20.apk';
app.get('/download/android-apk', (req, res) => {
  const url = process.env.ANDROID_APK_URL || _APK_FALLBACK;
  // 302 (not 301) — keeps the redirect non-cacheable so APK swaps are
  // instant once we update the env var.
  res.redirect(302, url);
});

// ── /beat/:slug fallback — fires only when no static public/beat/{slug}.html
// file matched (i.e., a beat uploaded after the last build). Builds the page
// on the fly using the same template + renderBeatPage helper from the build
// script, then serves it with a short cache so the next request is fast.
//
// 2026-05-06 — IMPORTANT: this route is registered before GET /beat/:id (the
// share-link handler at the bottom of the file). The in-app share sheet
// produces /beat/{uuid} URLs (UUIDs pass the [a-z0-9-] filter), and prior to
// today this handler caught them, didn't find a slug match, then 302→/.
// WhatsApp/iMessage scrapers followed the redirect and saw the homepage (no
// beat-specific OG tags), so unfurls showed only the bare URL with no beat
// title or cover art. UUID guard now falls through to the UUID handler.
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── /og/{slug}.png — per-beat 1200×630 OG banner, generated on demand ───────
// Square cover art looks bad in FB/Threads/X/WhatsApp feeds; this route
// produces a landscape banner with cover + title + tech + brand. First hit
// per beat takes ~200-400 ms (sharp + cover fetch); Vercel's CDN caches the
// response, so subsequent hits are instant. Small in-process Map cache so a
// warm lambda doesn't regenerate within its own lifetime either.
const _ogCache = new Map(); // slug -> Buffer (capped at 50 entries)
app.get('/og/:slug.png', async (req, res) => {
  const slug = req.params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(404).end();
  try {
    const cached = _ogCache.get(slug);
    if (cached) {
      res.set('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
      res.set('Content-Type', 'image/png');
      return res.send(cached);
    }
    const { beatSlug, buildOgPngBuffer } = require('./scripts/build-beat-pages');
    const beats = await fetchBeatsFromDB().catch(() => []);
    const beat = (beats || []).find(b => b && b.title && beatSlug(b) === slug);
    if (!beat) return res.status(404).end();
    const buf = await buildOgPngBuffer(beat);
    if (!buf) return res.status(500).end();
    // LRU-ish eviction — oldest first so hot beats stay warm.
    if (_ogCache.size >= 50) _ogCache.delete(_ogCache.keys().next().value);
    _ogCache.set(slug, buf);
    res.set('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    res.set('Content-Type', 'image/png');
    return res.send(buf);
  } catch (e) {
    console.error('/og/:slug error:', e.message);
    return res.status(500).end();
  }
});

app.get('/beat/:slug', async (req, res, next) => {
  const slug = req.params.slug;
  if (!slug || /[^a-z0-9-]/i.test(slug)) return next();
  // UUID-style share URLs belong to the GET /beat/:id handler below (richer
  // OG/JSON-LD render keyed off DB id directly). Fall through.
  if (_UUID_RE.test(slug)) return next();
  try {
    const fs = require('fs');
    const { beatSlug, renderBeatPage } = require('./scripts/build-beat-pages');
    // Static file on disk?
    const diskPath = path.join(__dirname, 'public', 'beat', slug + '.html');
    if (fs.existsSync(diskPath)) {
      res.set('Cache-Control', 'public, max-age=300, s-maxage=86400');
      return res.sendFile(diskPath);
    }
    // Live-build fallback
    const beats = await fetchBeatsFromDB().catch(() => []);
    const beat = (beats || []).find(b => b && b.title && beatSlug(b) === slug);
    if (!beat) return res.status(404).redirect('/');
    const template = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    // Pass beats so renderBeatPage can compute the Related Beats section.
    const html = renderBeatPage(template, beat, slug, beats || []);
    res.set('Cache-Control', 'public, max-age=120, s-maxage=600, stale-while-revalidate=86400');
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (e) {
    console.error('/beat/:slug error:', e.message);
    return res.status(302).redirect('/');
  }
});
// Skip JSON body parsing for raw-body routes (webhook + chunked upload)
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/upload/drive-proxy-chunk') return next();
  express.json({ limit: '50mb' })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/upload/drive-proxy-chunk') return next();
  express.urlencoded({ limit: '50mb', extended: true })(req, res, next);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── Auth (Apple + Google) — bypasses Supabase Auth ──────────────────────────
// Customer app's signInWithIdToken / signInWithOAuth flows hit Supabase, which
// is currently quota-restricted. These endpoints accept the same Apple/Google
// tokens, verify them locally, and mint our own HMAC-signed session token.
require('./auth').register(app);

// ── Admin Key Middleware ─────────────────────────────────────────────────────
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Admin Session: exchange Supabase access_token for admin key ──────────────
// Lets the Uploader app sign in with Google and auto-receive the admin key if
// the authenticated email is on the allowlist. No password/admin-key typing.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'produceroneil@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

app.post('/admin/session', async (req, res) => {
  try {
    const { access_token } = req.body || {};
    if (!access_token) return res.status(400).json({ error: 'Missing access_token' });
    const supabaseApiKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!process.env.SUPABASE_URL || !supabaseApiKey) {
      return res.status(500).json({ error: 'Supabase not configured on server (missing SUPABASE_URL or SUPABASE_ANON_KEY/SERVICE_KEY)' });
    }
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'apikey': supabaseApiKey,
      },
    });
    if (!r.ok) return res.status(401).json({ error: 'Invalid or expired token' });
    const user = await r.json();
    const email = (user?.email || '').toLowerCase();
    if (!email) return res.status(401).json({ error: 'Email not present on user' });
    if (!ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'Not an authorized admin email' });
    }
    if (!process.env.ADMIN_KEY) {
      return res.status(500).json({ error: 'ADMIN_KEY not set on server' });
    }
    return res.json({ adminKey: process.env.ADMIN_KEY, email });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// HEALTH / STATUS
// ──────────────────────────────────────────────────────────────────────────────

// GET /health — quick sanity check on environment config & Stripe live/test mode.
// Does NOT leak secrets; only reports booleans and non-sensitive prefixes.
app.get('/health', async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  const stripeMode = stripeKey.startsWith('sk_live_') ? 'live'
                   : stripeKey.startsWith('sk_test_') ? 'test'
                   : 'missing';
  const webhookConfigured = !!process.env.STRIPE_WEBHOOK_SECRET;
  const emailConfigured = !!(process.env.EMAIL_FROM && process.env.EMAIL_PASS);
  const supabaseConfigured = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY));

  let stripeConnected = false;
  let stripeAccountId = null;
  try {
    if (stripeMode !== 'missing') {
      const acct = await stripe.accounts.retrieve();
      stripeConnected = true;
      stripeAccountId = acct.id;
    }
  } catch (e) {
    // Stripe call failed — still return but mark not connected
  }

  res.json({
    ok: true,
    stripeMode,
    stripeConnected,
    stripeAccountId,
    webhookConfigured,
    emailConfigured,
    supabaseConfigured,
    appUrl: process.env.APP_URL || null,
    serverTime: new Date().toISOString(),
  });
});

// GET /upload/status — OB Uploader uses this to authenticate admin sessions
// ──────────────────────────────────────────────────────────────────────────────
// CLOUD RENDER — fires the GitHub Actions render-video workflow.
//
// Why: long-audio renders OOM on the producer's local PC. GitHub's free Ubuntu
// runners have 7GB RAM — plenty of headroom for full bg FX + showfreqs.
//
// Flow:
//   1. Desktop app uploads audio.mp3, cover.jpg, settings.json (and optionally
//      bg.jpg) to Supabase bucket `cloud-render` under prefix `inputs/{jobId}/`.
//   2. Desktop calls POST /admin/cloud-render with { jobId, inputPrefix, outputKey }.
//   3. We fire a repository_dispatch event to GitHub. The workflow downloads
//      the inputs, runs ffmpeg, uploads result to `outputs/{jobId}.mp4`.
//   4. Desktop polls Supabase HEAD on the output object and downloads when ready.
//
// Auth: requires GH_DISPATCH_PAT env var (a GitHub PAT with `repo` scope on
//       this repo). Set in Vercel project env settings.
// Rate: GitHub Actions repository_dispatch is unlimited; minute budget is the
//       2000-min/month free tier on private repos (~30 hours total).
// /admin/backfill-yt-thumbnails — backfills custom thumbnails on existing
// YouTube uploads. The auto-upload pipeline marks thumbnail-generation as
// non-fatal so videos sometimes publish with YouTube's auto-picked frame
// instead of the templated thumbnail. This endpoint lists recent videos
// missing the maxres (custom) thumbnail, matches each back to a beat in
// the catalog, regenerates via media.makeThumbnail, and uploads via
// yt.thumbnails.set.
//
// Local dev's GOOGLE_OAUTH_REFRESH_TOKEN is often stale — running this on
// production (Vercel) is the reliable path since the live pipeline already
// uses these credentials successfully.
//
// Query params:
//   apply=1            — actually upload (default is dry-run preview)
//   lookbackDays=N     — how far back to scan (default 60)
//
// Returns: { fixed, skipped, errored, items: [...] }
app.post('/admin/backfill-yt-thumbnails', requireAdminKey, async (req, res) => {
  try {
    const apply = req.query.apply === '1' || req.body?.apply === true;
    const lookbackDays = parseInt(req.query.lookbackDays || req.body?.lookbackDays || '60', 10);
    const { runBackfill } = require('./scripts/backfill-yt-thumbnails');
    const lines = [];
    const log = (line) => { lines.push(line); console.log(line); };
    const result = await runBackfill({ apply, lookbackDays, log });
    res.json({ ok: true, ...result, log: lines });
  } catch (err) {
    console.error('[admin/backfill-yt-thumbnails]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/cloud-render', requireAdminKey, async (req, res) => {
  try {
    const { jobId, inputPrefix, outputKey } = req.body || {};
    if (!jobId || !inputPrefix || !outputKey) {
      return res.status(400).json({ error: 'jobId, inputPrefix, outputKey all required' });
    }
    // Sanity: paths must stay inside the cloud-render bucket prefixes.
    if (!/^inputs\/[a-zA-Z0-9\-_]+\/?$/.test(inputPrefix.replace(/\/$/, ''))) {
      return res.status(400).json({ error: 'inputPrefix must match inputs/<jobId>' });
    }
    if (!/^outputs\/[a-zA-Z0-9\-_]+\.mp4$/.test(outputKey)) {
      return res.status(400).json({ error: 'outputKey must match outputs/<jobId>.mp4' });
    }
    const pat = process.env.GH_DISPATCH_PAT;
    if (!pat) return res.status(500).json({ error: 'GH_DISPATCH_PAT not configured on backend' });
    const owner = process.env.GH_REPO_OWNER || 'nomansky1';
    const repo  = process.env.GH_REPO_NAME  || 'oneil-beats-backend';

    const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'oneil-beats-backend',
      },
      body: JSON.stringify({
        event_type: 'render-video',
        client_payload: { jobId, inputPrefix: inputPrefix.replace(/\/$/, ''), outputKey },
      }),
    });
    if (ghRes.status !== 204) {
      const detail = await ghRes.text().catch(() => '(no body)');
      return res.status(502).json({ error: `GitHub dispatch failed (${ghRes.status})`, detail: detail.slice(0, 400) });
    }
    res.json({
      success: true,
      jobId,
      dispatched: true,
      runsUrl: `https://github.com/${owner}/${repo}/actions/workflows/render-video.yml`,
      outputUrl: `${process.env.SUPABASE_URL}/storage/v1/object/cloud-render/${outputKey}`,
      errorUrl: `${process.env.SUPABASE_URL}/storage/v1/object/cloud-render/${outputKey.replace(/\.mp4$/, '.error.txt')}`,
    });
  } catch (e) {
    console.error('POST /admin/cloud-render error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/upload/status', requireAdminKey, (req, res) => {
  res.json({ success: true, message: 'Authenticated', serverTime: new Date().toISOString() });
});

// POST /beat-request — custom beat request from customer app
app.post('/beat-request', async (req, res) => {
  try {
    const { email, name, genre, bpm, key, mood, description } = req.body;
    if (!email || !description) {
      return res.status(400).json({ error: 'Email and description are required' });
    }

    // Store in Supabase
    const supabase = getSupabaseClient();
    const { error: dbError } = await supabase
      .from('beat_requests')
      .insert([{ email, name: name || 'Anonymous', genre, bpm, key_signature: key, mood, description, status: 'pending', created_at: new Date().toISOString() }]);

    if (dbError) console.error('beat_requests insert error (table may not exist, falling back to email):', dbError.message);

    // Always send email notification to producer
    if (process.env.EMAIL_FROM && process.env.EMAIL_PASS) {
      try {
        await mailer.sendMail({
          from: process.env.EMAIL_FROM,
          to: process.env.EMAIL_FROM, // send to yourself
          replyTo: email,
          subject: '🎹 Beat Request from ' + (name || email),
          html: buildColoredEmail({
            type: 'request',
            title: 'Custom Beat Request',
            bodyHtml: `
              <p style="color:#ccc;margin:0 0 8px;"><b style="color:#fff;">From:</b> ${name || 'Anonymous'} (${email})</p>
              <p style="color:#ccc;margin:0 0 4px;"><b style="color:#fff;">Genre:</b> ${genre || 'Not specified'}</p>
              <p style="color:#ccc;margin:0 0 4px;"><b style="color:#fff;">BPM:</b> ${bpm || 'Any'}</p>
              <p style="color:#ccc;margin:0 0 4px;"><b style="color:#fff;">Key:</b> ${key || 'Any'}</p>
              <p style="color:#ccc;margin:0 0 8px;"><b style="color:#fff;">Mood:</b> ${mood || 'Not specified'}</p>
              <p style="color:#fff;margin:12px 0 4px;font-weight:700;">Description:</p>
              <p style="background:#111;color:#fff;padding:12px;border-radius:8px;">${description}</p>
              <p style="color:#888;margin:12px 0 0;font-size:12px;">Reply directly to this email to respond to the customer.</p>`,
          }),
        });
      } catch (emailErr) {
        console.error('Beat request email failed:', emailErr.message);
      }
    }

    res.json({ success: true, message: 'Your beat request has been submitted! We\'ll get back to you soon.' });
  } catch (err) {
    console.error('Beat request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// EXCLUSIVE OFFER SUBMISSION
// ──────────────────────────────────────────────────────────────────────────────

// Email color coding by type
const EMAIL_COLORS = {
  offer:    { bg: '#dc2626', label: 'EXCLUSIVE OFFER',   badge: '#dc2626', accent: '#fca5a5' },
  purchase: { bg: '#16a34a', label: 'PURCHASE',          badge: '#16a34a', accent: '#86efac' },
  request:  { bg: '#f59e0b', label: 'BEAT REQUEST',      badge: '#f59e0b', accent: '#fde68a' },
  system:   { bg: '#6366f1', label: 'SYSTEM',            badge: '#6366f1', accent: '#a5b4fc' },
};

function buildColoredEmail({ type, title, bodyHtml }) {
  const c = EMAIL_COLORS[type] || EMAIL_COLORS.system;
  return `<!DOCTYPE html><html><body style="background:#06060a;margin:0;padding:0;">
<div style="max-width:600px;margin:0 auto;padding:32px 20px;">
  <div style="background:${c.bg};color:#fff;display:inline-block;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:800;letter-spacing:1.5px;margin-bottom:16px;">${c.label}</div>
  <h1 style="color:#fff;margin:0 0 6px;">${title}</h1>
  <div style="border-left:4px solid ${c.bg};padding-left:16px;margin:16px 0;">
    ${bodyHtml}
  </div>
  <p style="color:#444;font-size:11px;margin-top:24px;">O'Neil Beats App Notification</p>
</div></body></html>`;
}

// POST /offer — customer submits an offer on an exclusive beat
app.post('/offer', async (req, res) => {
  try {
    const { email, name, beatId, beatTitle, offerAmount, message } = req.body;
    if (!email || !beatId || !offerAmount) {
      return res.status(400).json({ error: 'Email, beatId, and offerAmount are required' });
    }

    const amount = parseFloat(offerAmount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Offer amount must be a positive number' });
    }

    // Store offer in Supabase (table may not exist yet — graceful fallback)
    const supabase = getSupabaseClient();
    const { error: dbError } = await supabase
      .from('exclusive_offers')
      .insert([{
        email,
        name: name || 'Anonymous',
        beat_id: beatId,
        beat_title: beatTitle || '',
        offer_amount: amount,
        message: message || '',
        status: 'pending',
        created_at: new Date().toISOString(),
      }]);
    if (dbError) console.error('exclusive_offers insert error (table may not exist):', dbError.message);

    // Email to producer — red color-coded EXCLUSIVE OFFER
    if (process.env.EMAIL_FROM && process.env.EMAIL_PASS) {
      try {
        const bodyHtml = `
          <p style="color:#ccc;margin:0 0 8px;"><b style="color:#fff;">From:</b> ${name || 'Anonymous'} (${email})</p>
          <p style="color:#ccc;margin:0 0 8px;"><b style="color:#fff;">Beat:</b> ${beatTitle || beatId}</p>
          <p style="color:#fff;margin:0 0 8px;font-size:28px;font-weight:900;">$${amount.toFixed(2)}</p>
          ${message ? `<p style="color:#ccc;margin:12px 0 0;"><b style="color:#fff;">Message:</b></p><p style="background:#111;color:#fff;padding:12px;border-radius:8px;">${message}</p>` : ''}
          <p style="color:#888;margin:12px 0 0;font-size:12px;">Reply directly to this email to respond to the buyer.</p>`;

        await mailer.sendMail({
          from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
          to: process.env.EMAIL_FROM,
          replyTo: email,
          subject: `🔥 Exclusive Offer: $${amount.toFixed(2)} for "${beatTitle || 'Beat'}"`,
          html: buildColoredEmail({ type: 'offer', title: `Exclusive Offer — $${amount.toFixed(2)}`, bodyHtml }),
        });
      } catch (emailErr) {
        console.error('Offer email failed:', emailErr.message);
      }
    }

    res.json({ success: true, message: 'Your offer has been submitted! The producer will review and respond via email.' });
  } catch (err) {
    console.error('Offer submission error:', err);
    res.status(500).json({ error: 'Failed to submit offer' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// BEATS API
// ──────────────────────────────────────────────────────────────────────────────

// GET /beats — JSON API. Returns all active beats. Used by the SPA, mobile
// app, admin dashboard, and test scripts. Vercel serves any matching public/
// *.html as a static file BEFORE Express routes run, so we deliberately do
// NOT generate public/beats.html — the SEO landing for "browse all beats"
// lives at /browse-beats instead (see FEATURED_PAGES in build-beat-pages.js).
app.get('/beats', async (req, res) => {
  try {
    const beats = await fetchBeatsFromDB();
    res.json({ success: true, beats });
  } catch (err) {
    console.error('Fetch beats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// REVIEWS — per-beat customer reviews. Powers AggregateRating + Review schema
// in beat-page JSON-LD (⭐ stars in Google search results once ≥3 approved).
// Migration: backend/migrations/reviews.sql must be run in Supabase first.
// ──────────────────────────────────────────────────────────────────────────────

// POST /reviews — submit a new review (status='pending', awaits owner approval)
app.post('/reviews', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { beatId, email, name, rating, title, body } = req.body || {};
    if (!beatId || !email || !rating) return res.status(400).json({ error: 'beatId, email, rating required' });
    const r = parseInt(rating, 10);
    if (!Number.isFinite(r) || r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });

    // Check verified_purchase by looking up an order from this email for this beat
    let verified = false;
    try {
      const { data: orders } = await supabase.from('orders')
        .select('id')
        .eq('customer_email', String(email).toLowerCase())
        .ilike('beat_id', beatId)
        .limit(1);
      verified = (orders || []).length > 0;
    } catch (_) { /* swallow — verified stays false */ }

    const { data, error } = await supabase.from('reviews').insert({
      beat_id: beatId,
      customer_email: String(email).toLowerCase().trim(),
      customer_name: name ? String(name).slice(0, 80) : null,
      rating: r,
      title: title ? String(title).slice(0, 120) : null,
      body: body ? String(body).slice(0, 2000) : null,
      status: 'pending',
      verified_purchase: verified,
    }).select().single();

    if (error) {
      // Unique violation = already submitted a review for this beat
      if (error.code === '23505') return res.status(409).json({ error: 'You already submitted a review for this beat. Email O\'Neil to update it.' });
      throw error;
    }
    res.json({ success: true, review: { id: data.id, status: data.status, message: 'Review submitted! It will appear after the producer approves it.' } });
  } catch (err) {
    console.error('POST /reviews error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /reviews?beatId=X — fetch approved reviews for a beat
app.get('/reviews', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const beatId = req.query.beatId;
    if (!beatId) return res.status(400).json({ error: 'beatId query param required' });
    const { data, error } = await supabase.from('reviews')
      .select('id, customer_name, rating, title, body, verified_purchase, created_at')
      .eq('beat_id', beatId)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const reviews = data || [];
    const aggregate = reviews.length
      ? { count: reviews.length, average: Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10 }
      : { count: 0, average: null };
    res.json({ success: true, reviews, aggregate });
  } catch (err) {
    console.error('GET /reviews error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/reviews?status=pending — moderation queue (owner only)
app.get('/admin/reviews', async (req, res) => {
  try {
    if (!checkAdminAuth(req)) return res.status(401).json({ error: 'unauthorized' });
    const supabase = getSupabaseClient();
    const status = req.query.status || 'pending';
    const { data, error } = await supabase.from('reviews')
      .select('id, beat_id, customer_email, customer_name, rating, title, body, status, verified_purchase, created_at, approved_at')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ success: true, reviews: data || [] });
  } catch (err) {
    console.error('GET /admin/reviews error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/reviews/:id/:action  (action = approve | reject)
app.post('/admin/reviews/:id/:action', async (req, res) => {
  try {
    if (!checkAdminAuth(req)) return res.status(401).json({ error: 'unauthorized' });
    const supabase = getSupabaseClient();
    const { id, action } = req.params;
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });
    const update = { status: action === 'approve' ? 'approved' : 'rejected' };
    if (action === 'approve') update.approved_at = new Date().toISOString();
    const { data, error } = await supabase.from('reviews').update(update).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, review: data });
  } catch (err) {
    console.error('POST /admin/reviews/:id/:action error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: simple admin auth check. Reuses ADMIN_TOKEN if set, else header check.
function checkAdminAuth(req) {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  const expected = process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD;
  return expected && token === expected;
}

// GET /analytics/trending?days=7&limit=10 — public trending beats by play count
// Returns: { success, trending: [{ beatId, plays, favorites }] }
app.get('/analytics/trending', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    let trending = [];
    try {
      const supabase = getSupabaseClient();
      const [eventsRes, favsRes] = await Promise.all([
        supabase.from('customer_events').select('event_data, action, created_at').eq('action', 'play').gte('created_at', since).limit(20000),
        supabase.from('favorites').select('beat_id').gte('created_at', since).limit(20000),
      ]);
      const playsByBeat = {};
      (eventsRes.data || []).forEach(e => {
        const id = e.event_data && e.event_data.beatId;
        if (id) playsByBeat[id] = (playsByBeat[id] || 0) + 1;
      });
      const favsByBeat = {};
      (favsRes.data || []).forEach(r => {
        if (r.beat_id) favsByBeat[r.beat_id] = (favsByBeat[r.beat_id] || 0) + 1;
      });
      trending = Object.entries(playsByBeat)
        .map(([beatId, plays]) => ({ beatId, plays, favorites: favsByBeat[beatId] || 0 }))
        .sort((a, b) => (b.plays + b.favorites * 2) - (a.plays + a.favorites * 2))
        .slice(0, limit);
    } catch (dbErr) {
      console.warn('trending query skipped:', dbErr.message);
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, days, trending });
  } catch (err) {
    res.json({ success: true, trending: [], error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CUSTOMER ANALYTICS / REGISTRATION / FAVORITES / PROMO
// ──────────────────────────────────────────────────────────────────────────────

// POST /customer/track — customer behavior event logging
// Body: { userId?, action, data? }
// Always returns 200 so analytics failures never break the customer app flow.
// POST /beats/:id/download — track free tagged-MP3 downloads
// Body (optional): { userId }
// Logs a 'download' action to customer_events so analytics + dashboards
// can surface which beats are being pulled via the free-tagged download flow.
app.post('/beats/:id/download', async (req, res) => {
  try {
    const beatId = req.params.id;
    const { userId } = req.body || {};
    if (!beatId) return res.json({ success: true, skipped: 'no beatId' });
    try {
      const supabase = getSupabaseClient();
      await supabase.from('customer_events').insert([{
        user_id: userId || null,
        action: 'download',
        event_data: { beatId, tagged: true },
        created_at: new Date().toISOString(),
      }]);
    } catch (dbErr) {
      console.warn('download tracking insert skipped:', dbErr.message);
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true, error: err.message });
  }
});

app.post('/customer/track', async (req, res) => {
  try {
    const { userId, clientId, action, data } = req.body || {};
    if (!action) return res.json({ success: true, skipped: 'no action' });
    try {
      const supabase = getSupabaseClient();
      await supabase.from('customer_events').insert([{
        user_id: userId || null,
        action,
        event_data: data || {},
        created_at: new Date().toISOString(),
      }]);
    } catch (dbErr) {
      console.warn('customer_events insert skipped:', dbErr.message);
    }

    // GA4 Measurement Protocol forward — fire-and-forget so app event flow
    // isn't blocked by the round trip to Google. Gated on env so the app
    // stays functional if the secret hasn't been set yet. The clientId
    // (anon UUID, persistent per device) is used as GA4's client_id so
    // returning-user metrics work; userId, when present, becomes user_id.
    // Param names normalized to GA4-friendly snake_case where possible.
    const measId = process.env.GA4_MEASUREMENT_ID;
    const apiSecret = process.env.GA4_API_SECRET;
    if (measId && apiSecret && clientId) {
      const cleanParams = {};
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          // GA4 param values must be string/number/bool. Skip arrays/objects
          // (they'd be silently dropped) — the Supabase row keeps the full data.
          if (v == null) continue;
          if (typeof v === 'object') continue;
          cleanParams[k.slice(0, 40)] = typeof v === 'string' ? v.slice(0, 100) : v;
        }
      }
      const body = JSON.stringify({
        client_id: String(clientId),
        ...(userId ? { user_id: String(userId) } : {}),
        events: [{ name: String(action).slice(0, 40).replace(/[^a-zA-Z0-9_]/g, '_'), params: cleanParams }],
      });
      const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measId)}&api_secret=${encodeURIComponent(apiSecret)}`;
      // Don't await — fire-and-forget. Log the rejection so a misconfigured
      // secret surfaces in Vercel logs instead of failing silently forever.
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        .then(r => { if (!r.ok) r.text().then(t => console.warn('GA4 MP non-OK:', r.status, t.slice(0, 120))); })
        .catch(err => console.warn('GA4 MP forward failed:', err.message));
    }

    res.json({ success: true });
  } catch (err) {
    res.json({ success: true, error: err.message });
  }
});

// POST /customer/register — upsert customer profile row
// Body: { id, email?, name?, phone?, expoPushToken? }
app.post('/customer/register', async (req, res) => {
  try {
    const { id, email, name, phone, expoPushToken } = req.body || {};
    if (!id && !email) return res.status(400).json({ error: 'id or email required' });
    const supabase = getSupabaseClient();
    const row = {
      id: id || undefined,
      email: email || null,
      name: name || null,
      phone: phone || null,
      last_seen: new Date().toISOString(),
    };
    Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);
    try {
      await supabase.from('customers').upsert(row, { onConflict: id ? 'id' : 'email' });
    } catch (dbErr) {
      console.warn('customers upsert skipped:', dbErr.message);
    }
    if (expoPushToken && id) {
      try { await registerPushToken(id, expoPushToken, 'mobile'); } catch (_) {}
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Customer register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /favorites?userId=... — list favorited beat IDs
app.get('/favorites', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.json({ success: true, favorites: [] });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('favorites').select('beat_id').eq('user_id', userId);
    if (error) {
      console.warn('favorites fetch skipped:', error.message);
      return res.json({ success: true, favorites: [] });
    }
    res.json({ success: true, favorites: (data || []).map(r => r.beat_id) });
  } catch (err) {
    res.json({ success: true, favorites: [], error: err.message });
  }
});

// POST /favorites — toggle favorite: { userId, beatId, favorited }
app.post('/favorites', async (req, res) => {
  try {
    const { userId, beatId, favorited } = req.body || {};
    if (!userId || !beatId) return res.status(400).json({ error: 'userId and beatId required' });
    const supabase = getSupabaseClient();
    try {
      if (favorited === false) {
        await supabase.from('favorites').delete().eq('user_id', userId).eq('beat_id', beatId);
      } else {
        await supabase.from('favorites').upsert({
          user_id: userId,
          beat_id: beatId,
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id,beat_id' });
      }
    } catch (dbErr) {
      console.warn('favorites write skipped:', dbErr.message);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET/POST /promo/check-first-purchase — email via query or body
// Returns { eligible, firstTime, paidOrders, promoCode }
async function checkFirstPurchaseHandler(req, res) {
  try {
    const email = (req.body && req.body.email) || req.query.email;
    if (!email) return res.json({ eligible: true, firstTime: true, promoCode: 'FIRST10' });
    const orders = await getOrdersByEmail(email);
    const count = (orders || []).length;
    const firstTime = count === 0;
    res.json({ eligible: firstTime, firstTime, paidOrders: count, promoCode: 'FIRST10' });
  } catch (err) {
    res.json({ eligible: true, firstTime: true, promoCode: 'FIRST10', error: err.message });
  }
}
app.get('/promo/check-first-purchase', checkFirstPurchaseHandler);
app.post('/promo/check-first-purchase', checkFirstPurchaseHandler);

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN COUPONS — Stripe-backed coupon + promotion-code management.
// Added 2026-04-30 — UI was calling these endpoints but they didn't exist
// (404 returning HTML page, parsed as JSON, "Unexpected token '<'" error).
//
// Coupon = the discount itself (e.g. 10% off). Lives on stripe.coupons.
// PromotionCode = the human-friendly code (e.g. "FIRST10") that applies the
// coupon at checkout. Lives on stripe.promotionCodes (one coupon → many codes).
// ──────────────────────────────────────────────────────────────────────────────

// GET /admin/coupons — list all coupons + their promotion codes for the UI.
app.get('/admin/coupons', requireAdminKey, async (req, res) => {
  try {
    // Stripe pagination: default 10, we want up to 100 active.
    const couponList = await stripe.coupons.list({ limit: 100 });
    const promoList  = await stripe.promotionCodes.list({ limit: 100 });

    // Index promo codes by coupon id for O(1) attach.
    const promosByCoupon = {};
    for (const p of promoList.data || []) {
      const cid = p.coupon && p.coupon.id;
      if (!cid) continue;
      (promosByCoupon[cid] = promosByCoupon[cid] || []).push({
        id: p.id,
        code: p.code,
        active: p.active,
        times_redeemed: p.times_redeemed,
        max_redemptions: p.max_redemptions,
        expires_at: p.expires_at,
      });
    }

    const coupons = (couponList.data || []).map(c => ({
      id: c.id,
      name: c.name || c.id,
      percent_off: c.percent_off,
      amount_off: c.amount_off,           // cents
      currency: c.currency,
      duration: c.duration,                // 'once' | 'repeating' | 'forever'
      duration_in_months: c.duration_in_months,
      max_redemptions: c.max_redemptions,
      times_redeemed: c.times_redeemed,
      valid: c.valid,
      created: c.created,
      promotion_codes: promosByCoupon[c.id] || [],
    }));
    res.json({ success: true, coupons });
  } catch (err) {
    console.error('[admin/coupons] list error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/coupons — create a coupon (+ optional promotion code).
// Body: { name, percent_off?, amount_off?, duration?, duration_in_months?,
//         max_redemptions?, promo_code? }
// Either percent_off OR amount_off is required (not both).
app.post('/admin/coupons', requireAdminKey, async (req, res) => {
  try {
    const { name, percent_off, amount_off, duration, duration_in_months,
            max_redemptions, promo_code } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    if (percent_off == null && amount_off == null) {
      return res.status(400).json({ success: false, error: 'percent_off or amount_off required' });
    }
    if (percent_off != null && amount_off != null) {
      return res.status(400).json({ success: false, error: 'cannot set both percent_off and amount_off' });
    }

    const couponPayload = {
      name,
      duration: duration || 'once',
    };
    if (percent_off != null) {
      const pct = Math.max(0, Math.min(100, parseFloat(percent_off)));
      couponPayload.percent_off = pct;
    } else {
      // amount_off is in dollars in our UI; Stripe expects cents
      const cents = Math.max(1, Math.round(parseFloat(amount_off) * 100));
      couponPayload.amount_off = cents;
      couponPayload.currency = 'usd';
    }
    if (duration === 'repeating' && duration_in_months) {
      couponPayload.duration_in_months = parseInt(duration_in_months, 10);
    }
    if (max_redemptions) couponPayload.max_redemptions = parseInt(max_redemptions, 10);

    const coupon = await stripe.coupons.create(couponPayload);

    // If a promo code was specified, create the human-friendly code now.
    let promotionCode = null;
    if (promo_code && String(promo_code).trim()) {
      promotionCode = await stripe.promotionCodes.create({
        coupon: coupon.id,
        code: String(promo_code).trim().toUpperCase(),
        active: true,
      });
    }

    res.json({
      success: true,
      coupon: { id: coupon.id, name: coupon.name, percent_off: coupon.percent_off, amount_off: coupon.amount_off, duration: coupon.duration },
      promotion_code: promotionCode ? { id: promotionCode.id, code: promotionCode.code } : null,
    });
  } catch (err) {
    console.error('[admin/coupons] create error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /admin/coupons/:id — delete a coupon. Stripe automatically deactivates
// any promotion codes attached to the coupon.
app.delete('/admin/coupons/:id', requireAdminKey, async (req, res) => {
  try {
    await stripe.coupons.del(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/coupons] delete error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /admin/coupons/:promoId/toggle — activate/deactivate a promotion code.
// Body: { active: true | false }
app.put('/admin/coupons/:promoId/toggle', requireAdminKey, async (req, res) => {
  try {
    const { active } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'active boolean required' });
    }
    const updated = await stripe.promotionCodes.update(req.params.promoId, { active });
    res.json({ success: true, promotion_code: { id: updated.id, code: updated.code, active: updated.active } });
  } catch (err) {
    console.error('[admin/coupons] toggle error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/coupons/init-first10 — idempotent: create the FIRST10 coupon
// (10% off first beat, 'once' duration) + matching promotion code. If they
// already exist, returns success without re-creating.
app.post('/admin/coupons/init-first10', requireAdminKey, async (req, res) => {
  try {
    const PROMO_CODE = 'FIRST10';
    // Check if the FIRST10 promo code already exists.
    const existingPromos = await stripe.promotionCodes.list({ code: PROMO_CODE, limit: 5 });
    if (existingPromos.data && existingPromos.data.length > 0) {
      const p = existingPromos.data[0];
      return res.json({ success: true, alreadyExists: true, coupon_id: p.coupon.id, promo_id: p.id, code: p.code });
    }

    // Create the coupon + the FIRST10 promotion code.
    const coupon = await stripe.coupons.create({
      name: 'First Purchase Discount (FIRST10)',
      percent_off: 10,
      duration: 'once',
    });
    const promo = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code: PROMO_CODE,
      active: true,
    });
    res.json({ success: true, alreadyExists: false, coupon_id: coupon.id, promo_id: promo.id, code: promo.code });
  } catch (err) {
    console.error('[admin/coupons/init-first10] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN BEAT CRUD + LICENSE TERMS
// ──────────────────────────────────────────────────────────────────────────────

// PUT /admin/beat/:id — update beat metadata
app.put('/admin/beat/:id', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Beat ID required' });
    await updateBeatInDB(id, req.body || {});
    res.json({ success: true });
  } catch (err) {
    console.error('Admin beat update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/beat/:id — soft-delete beat (sets active=false)
app.delete('/admin/beat/:id', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Beat ID required' });
    await deleteBeatInDB(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin beat delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Scheduled uploads ────────────────────────────────────────────────────
// Beats whose `scheduled_for` is in the future and `active=false`. The cron
// /cron/publish-scheduled flips them live once the timestamp passes.

// GET /admin/scheduled-beats — list pending scheduled uploads, soonest first.
app.get('/admin/scheduled-beats', requireAdminKey, async (req, res) => {
  try {
    const { rows } = await pgQuery(
      `SELECT id, title, genre, subgenre, bpm, key, mood,
              cover_url, audio_url, audio_original_url,
              scheduled_for, created_at
       FROM beats
       WHERE active = false AND scheduled_for IS NOT NULL AND scheduled_for > now()
       ORDER BY scheduled_for ASC`
    );
    res.json({ success: true, count: rows.length, beats: rows });
  } catch (err) {
    console.error('Admin scheduled-beats list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/beat/:id/schedule — reschedule a pending beat to a new timestamp.
// Body: { scheduled_for: ISO 8601 string }
// Same 30-day validation as /upload/beat-metadata. Setting to a past time is
// effectively "publish now" — flips active=true immediately.
app.put('/admin/beat/:id/schedule', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Beat ID required' });
    const { scheduled_for } = req.body || {};
    if (!scheduled_for) return res.status(400).json({ error: 'scheduled_for required (ISO 8601)' });

    const d = new Date(scheduled_for);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'scheduled_for must be a valid ISO 8601 timestamp' });
    const ms = d.getTime() - Date.now();
    if (ms > 30 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'scheduled_for cannot be more than 30 days in the future' });
    }

    if (ms <= 0) {
      // Past timestamp → "publish now". Flip active=true, clear scheduled_for.
      const { rows } = await pgQuery(
        `UPDATE beats SET active = true, scheduled_for = NULL
         WHERE id = $1 RETURNING id, title, active, scheduled_for`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Beat not found' });
      return res.json({ success: true, published_now: true, beat: rows[0] });
    }

    // Future timestamp → keep active=false, update scheduled_for.
    const { rows } = await pgQuery(
      `UPDATE beats SET scheduled_for = $2
       WHERE id = $1 RETURNING id, title, active, scheduled_for`,
      [id, d.toISOString()]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Beat not found' });
    res.json({ success: true, beat: rows[0] });
  } catch (err) {
    console.error('Admin reschedule error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/beat/:id/schedule — cancel a pending scheduled upload.
// Hard-deletes the beat row. (The beat was never publicly visible, and the
// audio/cover files on GCS are orphaned but cost ~nothing.)
// WARNING: If auto-upload already pushed this beat to YT/IG/TT, those posts
// are now linking to a deleted beat ID. The desktop EXE's confirmation
// dialog warns about this.
app.delete('/admin/beat/:id/schedule', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Beat ID required' });
    // Only allow cancelling scheduled (active=false + future scheduled_for) beats
    // to avoid accidentally hard-deleting live catalog rows via this endpoint.
    const { rows } = await pgQuery(
      `DELETE FROM beats
       WHERE id = $1 AND active = false AND scheduled_for IS NOT NULL AND scheduled_for > now()
       RETURNING id, title, scheduled_for`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Beat not found or not in scheduled state — use DELETE /admin/beat/:id for live beats' });
    }
    res.json({ success: true, cancelled: rows[0] });
  } catch (err) {
    console.error('Admin cancel-schedule error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /cron/publish-scheduled — Vercel cron entry point. Flips scheduled
// beats to active=true once their scheduled_for has passed, then fires the
// push + email broadcasts for each.
//
// Auth: Vercel cron sends `Authorization: Bearer ${CRON_SECRET}`. If the env
// var isn't set, the route falls back to requireAdminKey so manual triggers
// via the admin tools still work.
app.get('/cron/publish-scheduled', async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    const isCronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`;
    const isAdminAuth = adminKey && adminKey === process.env.ADMIN_KEY;
    if (!isCronAuth && !isAdminAuth) {
      return res.status(401).json({ error: 'unauthorized — needs Bearer CRON_SECRET or admin key' });
    }

    // Atomically flip all ready-to-publish beats. Returning the affected rows
    // gives us everything we need to fire push + email per beat.
    const { rows: published } = await pgQuery(
      `UPDATE beats
       SET active = true
       WHERE active = false
         AND scheduled_for IS NOT NULL
         AND scheduled_for <= now()
       RETURNING id, title, genre, bpm, key, mood, audio_url, cover_url`
    );

    if (published.length === 0) {
      return res.json({ success: true, published: 0, message: 'no beats ready' });
    }

    // Best-effort push + email per beat. Failures log-and-continue; the beats
    // are already live in the catalog regardless.
    let pushSent = 0, emailQueued = 0;
    for (const b of published) {
      try {
        const tokens = await getPushTokens();
        if (tokens.length > 0) {
          await sendPushNotification(
            tokens,
            '🎵 New Beat Released!',
            `Check out "${b.title}" — ${b.genre || 'New'} · ${b.bpm || '?'} BPM`,
            { beatId: b.id, beatTitle: b.title, genre: b.genre, bpm: b.bpm }
          );
          pushSent++;
        }
      } catch (e) {
        console.warn('[cron/publish-scheduled] push failed for', b.id, e.message);
      }
      // Email blast — fire-and-forget per beat. Reuses the same mailer as
      // /upload/beat-metadata. Failures here are logged but don't fail the
      // overall cron tick.
      (async () => {
        try {
          const supabase = getSupabaseClient();
          const { data: subs } = await supabase.from('email_subscribers')
            .select('email, token').is('unsubscribed_at', null);
          const recipients = (subs || []).filter(s => s.email);
          if (recipients.length === 0) return;
          const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://oneilbeats.store';
          const subject = `🔥 New Drop: ${b.title} — ${b.genre || "O'Neil Beats"}${b.bpm ? ' · ' + b.bpm + ' BPM' : ''}`;
          const beatLandingUrl = `${PUBLIC_BASE}/beat/${b.id}`;
          for (const sub of recipients) {
            const unsubUrl = `${PUBLIC_BASE}/unsubscribe?email=${encodeURIComponent(sub.email)}&token=${sub.token}`;
            const html = `<div style="font-family:system-ui;max-width:560px;margin:0 auto;background:#06060a;color:#e2e8f0;padding:32px;border-radius:12px"><h2 style="color:#fff">${b.title}</h2><p style="color:#aaa">${b.genre || ''}${b.bpm ? ' · ' + b.bpm + ' BPM' : ''}</p>${b.cover_url ? `<img src="${b.cover_url}" style="width:100%;max-width:400px;border-radius:12px;display:block;margin:16px auto">` : ''}<p style="text-align:center;margin:24px 0"><a href="${beatLandingUrl}" style="background:linear-gradient(135deg,#d4af37,#e63946);color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:900">🎧 LISTEN + LICENSE</a></p><p style="color:#555;font-size:11px;text-align:center;margin-top:24px"><a href="${unsubUrl}" style="color:#888">Unsubscribe</a></p></div>`;
            try {
              await mailer.sendMail({
                from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
                to: sub.email,
                subject,
                html,
                headers: {
                  'X-OB-Email-Type': 'new-beat-drop-scheduled',
                  'X-OB-Beat-Id': String(b.id),
                  'X-OB-Beat-Title': b.title || '',
                },
              });
              emailQueued++;
            } catch (_) { /* logged below */ }
          }
        } catch (e) {
          console.warn('[cron/publish-scheduled] email blast failed for', b.id, e.message);
        }
      })();
    }

    res.json({
      success: true,
      published: published.length,
      push_sent: pushSent,
      email_queued: emailQueued,
      beats: published.map(b => ({ id: b.id, title: b.title })),
    });
  } catch (err) {
    console.error('cron/publish-scheduled error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/audit-dirty-urls — scan the catalog for whitespace-corrupted URLs.
// Belt-and-suspenders for the GCS_BUCKET trailing-newline bug (PR #23). Run
// this nightly (or on demand) and alert on any beat whose audio_url,
// audio_original_url, cover_url, stem_url, or wav_url contains whitespace,
// a literal "\n", or a doubled-slash that isn't `https://`.
//
// 2026-05-06 (post-PR #24): column list corrected to match actual schema —
// previous list referenced mp3_url / stems_url / cover_art_url / artwork_url /
// midi_url / youtube_url / thumbnail_url, none of which exist on the beats
// table. Verified against information_schema; the only URL-bearing columns
// are: audio_url, audio_original_url, cover_url, stem_url, wav_url.
//
// Returns: { success, scanned, dirty: [{ id, title, fields: [{name, url, reason}] }] }
// Use ?fix=1 to also REPAIR rows in-place (trims all matched URLs). Without
// ?fix=1 the endpoint is read-only — safe to wire to a cron + Slack ping.
app.get('/admin/audit-dirty-urls', requireAdminKey, async (req, res) => {
  try {
    const beats = await fetchBeatsFromDB();
    const URL_FIELDS = ['audio_url', 'audio_original_url', 'cover_url', 'stem_url', 'wav_url'];
    const isDirty = (u) => {
      if (typeof u !== 'string' || !u) return null;
      if (/[\s\r\n\t]/.test(u))             return 'whitespace';
      if (u.includes('\\n') || u.includes('\\r')) return 'literal-escape';
      // doubled slashes that aren't part of the protocol
      const afterProto = u.replace(/^https?:\/\//, '');
      if (afterProto.includes('//'))         return 'doubled-slash';
      return null;
    };
    const dirty = [];
    for (const b of beats) {
      const fields = [];
      for (const f of URL_FIELDS) {
        const reason = isDirty(b[f]);
        if (reason) fields.push({ name: f, url: b[f], reason });
      }
      if (fields.length) dirty.push({ id: b.id, title: b.title, fields });
    }

    // Optional in-place repair (?fix=1). Trims the offending URLs and persists
    // to Supabase. Only repairs the EXACT fields flagged above — never touches
    // anything else on the row. Logs every write.
    let fixed = 0;
    if (req.query.fix === '1' && dirty.length) {
      const supabase = getSupabaseClient();
      for (const d of dirty) {
        const patch = {};
        for (const f of d.fields) {
          patch[f.name] = String(f.url || '').replace(/[\s\r\n\t]+/g, '').trim() || null;
        }
        const { error } = await supabase.from('beats').update(patch).eq('id', d.id);
        if (!error) fixed++;
        else console.warn('[audit-dirty-urls] fix failed for', d.id, error.message);
      }
    }

    res.json({
      success: true,
      scanned: beats.length,
      dirtyCount: dirty.length,
      fixed,
      dirty,
    });
  } catch (err) {
    console.error('Admin audit-dirty-urls error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/licenses — returns { licenses: {lease, premium, stems, exclusive} }
// Reads a single-row JSON blob from license_terms table; falls back to defaults.
app.get('/admin/licenses', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('license_terms').select('terms').eq('id', 1).maybeSingle();
    const licenses = (data && data.terms) ? data.terms : LICENSE_TERMS;
    res.json({ success: true, licenses });
  } catch (err) {
    res.json({ success: true, licenses: LICENSE_TERMS, warning: err.message });
  }
});

// GET /admin/offers?status=pending — list exclusive-rights offers
app.get('/admin/offers', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    let query = supabase.from('exclusive_offers').select('*').order('created_at', { ascending: false }).limit(200);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) {
      console.warn('exclusive_offers list warning:', error.message);
      return res.json({ success: true, offers: [] });
    }
    res.json({ success: true, offers: data || [] });
  } catch (err) {
    res.json({ success: true, offers: [], error: err.message });
  }
});

// PATCH /admin/offers/:id — update status (accepted | declined | archived)
app.patch('/admin/offers/:id', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!status) return res.status(400).json({ error: 'status required' });
    if (!['pending', 'accepted', 'declined', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const supabase = getSupabaseClient();
    const patch = { status, updated_at: new Date().toISOString() };
    if (note) patch.admin_note = note;
    const { error } = await supabase.from('exclusive_offers').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin offer update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/analytics?days=30 — real analytics from customer_events + favorites + orders
app.get('/admin/analytics', requireAdminKey, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const supabase = getSupabaseClient();
    const [evtsRes, favsRes, ordersRes] = await Promise.all([
      supabase.from('customer_events').select('user_id, action, event_data, created_at').gte('created_at', since).limit(50000),
      supabase.from('favorites').select('beat_id, user_id, created_at').gte('created_at', since).limit(20000),
      supabase.from('orders').select('id, customer_email, total_amount, created_at').gte('created_at', since).limit(10000),
    ]);
    const evts = evtsRes.data || [];
    const favs = favsRes.data || [];
    const orders = ordersRes.data || [];

    const playsByBeat = {};
    const actionCounts = {};
    const uniqueUsers = new Set();
    const dailyPlays = {};
    evts.forEach(e => {
      actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
      if (e.user_id) uniqueUsers.add(e.user_id);
      if (e.action === 'play') {
        const bid = e.event_data?.beatId || e.event_data?.beat_id;
        if (bid) playsByBeat[bid] = (playsByBeat[bid] || 0) + 1;
        const d = (e.created_at || '').slice(0, 10);
        if (d) dailyPlays[d] = (dailyPlays[d] || 0) + 1;
      }
    });

    const favsByBeat = {};
    favs.forEach(f => { favsByBeat[f.beat_id] = (favsByBeat[f.beat_id] || 0) + 1; });

    const revenue = orders.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0);

    const topBeats = Object.entries(playsByBeat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([beatId, plays]) => ({ beatId, plays, favorites: favsByBeat[beatId] || 0 }));

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      series.push({ date: d, plays: dailyPlays[d] || 0 });
    }

    res.json({
      success: true,
      windowDays: days,
      totals: {
        events: evts.length,
        plays: actionCounts.play || 0,
        favorites: favs.length,
        orders: orders.length,
        revenue: +revenue.toFixed(2),
        uniqueUsers: uniqueUsers.size,
      },
      actionCounts,
      topBeats,
      series,
    });
  } catch (err) {
    res.json({ success: true, totals: {}, topBeats: [], series: [], error: err.message });
  }
});

// Reusable fulfillment email (webhook + admin resend).
async function sendFulfillmentEmail(order, orderId, items) {
  const baseUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';
  const beatCards = items.map(item => {
    const dlBase = `${baseUrl}/download/${orderId}/${item.beat_id}`;
    const licBase = `${baseUrl}/license/${orderId}/${item.beat_id}`;
    let buttons = `<a href="${dlBase}?format=mp3" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#e63946;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">MP3</a>`;
    if (item.license_type === 'premium' || item.license_type === 'stems') {
      buttons += `<a href="${dlBase}?format=wav" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#8b5cf6;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">WAV</a>`;
    }
    if (item.license_type === 'stems') {
      buttons += `<a href="${dlBase}?format=stems" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#10b981;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">Stems</a>`;
    }
    buttons += `<a href="${licBase}" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#f59e0b;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">License PDF</a>`;
    return `<div style="background:#0f0f14;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:14px;"><h3 style="color:#fff;margin:0;font-size:17px;">${item.beat_title}</h3><div style="margin-top:12px;">${buttons}</div></div>`;
  }).join('');

  const textLinks = items.map(item => {
    const dlBase = `${baseUrl}/download/${orderId}/${item.beat_id}`;
    const licBase = `${baseUrl}/license/${orderId}/${item.beat_id}`;
    return `• ${item.beat_title}\n  MP3: ${dlBase}?format=mp3\n  License: ${licBase}`;
  }).join('\n\n');

  const htmlEmail = buildColoredEmail({
    type: 'purchase',
    title: '🎵 Your O\'Neil Beats Are Ready!',
    bodyHtml: `<p style="color:#888;margin:0 0 12px;">Order #${orderId.slice(0,8)}</p>${beatCards}<p style="color:#666;font-size:12px;margin-top:20px;">Thank you for your purchase!</p>`,
  });

  const attachments = [];
  for (const item of items) {
    try {
      const pdfBuffer = await generateLicensePDF({
        beatTitle: item.beat_title,
        licenseType: item.license_type,
        customerName: order.customer_name || 'Customer',
        customerEmail: order.customer_email,
        orderDate: new Date().toLocaleDateString(),
        licenseTerms: LICENSE_TERMS[item.license_type] || LICENSE_TERMS.lease,
      });
      attachments.push({
        filename: `${item.beat_title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_license.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      });
      const splitBuffer = await generateSplitSheetPDF({
        beat: { title: item.beat_title, genre: item.genre || '', bpm: item.bpm || '', key: item.key || '' },
        buyer: { name: order.customer_name || 'Artist', email: order.customer_email },
        orderId,
        licenseType: item.license_type,
      });
      attachments.push({
        filename: `${item.beat_title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_split_sheet.pdf`,
        content: splitBuffer,
        contentType: 'application/pdf',
      });
    } catch (pdfErr) {
      console.error(`Error generating PDF for beat ${item.beat_title}:`, pdfErr);
    }
  }

  await mailer.sendMail({
    from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
    to: order.customer_email,
    subject: `🎵 Your O'Neil Beats Order Ready!`,
    text: `Thanks for your purchase!\n\n${textLinks}\n\nEnjoy!`,
    html: htmlEmail,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

// Deliver a purchased drum kit — a single ZIP download link. Kit purchases are
// isolated from beat orders (no order_items, no license PDFs); the license
// terms ship inside the zip's README.
async function sendKitEmail(email, kit) {
  const html = buildColoredEmail({
    type: 'purchase',
    title: '🥁 Your O\'Neil Drum Kit is Ready!',
    bodyHtml: `<div style="background:#0f0f14;border:1px solid #222;border-radius:12px;padding:20px;">
        <h3 style="color:#fff;margin:0 0 10px;font-size:17px;">${kit.title}</h3>
        <p style="color:#aaa;margin:0 0 16px;font-size:13px;">${kit.sample_count} one-shots${kit.has_midi ? ' + MIDI pattern' : ''}${kit.genre ? ' · ' + kit.genre : ''}${kit.bpm ? ' · ' + kit.bpm + ' BPM' : ''}</p>
        <a href="${kit.kit_url}" style="display:inline-block;padding:12px 22px;background:#e63946;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px;">⬇ Download Kit (.zip)</a>
      </div>
      <p style="color:#666;font-size:12px;margin-top:20px;">Royalty-free for your own productions. Full license terms are in the README inside the zip. Thank you!</p>`,
  });
  await mailer.sendMail({
    from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
    to: email,
    subject: `🥁 Your O'Neil Drum Kit: ${kit.title}`,
    text: `Thanks for your purchase!\n\n${kit.title}\n${kit.sample_count} one-shots${kit.has_midi ? ' + MIDI' : ''}\n\nDownload: ${kit.kit_url}\n\nRoyalty-free for your productions. License terms in the README. Enjoy!`,
    html,
  });
}

// GET /admin/orders — list recent orders (for Orders inbox)
app.get('/admin/orders', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('orders')
      .select('id, customer_email, customer_name, total_amount, status, created_at, order_items(beat_id, beat_title, license_type)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    res.json({ success: true, orders: data || [] });
  } catch (err) {
    res.json({ success: true, orders: [], error: err.message });
  }
});

// POST /admin/order/:id/resend — re-send the fulfillment email
app.post('/admin/order/:id/resend', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await getOrderById(id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.customer_email) return res.status(400).json({ error: 'Order has no customer_email' });
    const items = order.order_items || [];
    if (items.length === 0) return res.status(400).json({ error: 'Order has no items' });
    await sendFulfillmentEmail(order, id, items);
    res.json({ success: true, email: order.customer_email, items: items.length });
  } catch (err) {
    console.error('Order resend error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/customers — real customer list with play/favorite/order aggregates
app.get('/admin/customers', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: customers, error: cErr } = await supabase
      .from('customers')
      .select('*')
      .order('last_seen', { ascending: false })
      .limit(500);
    if (cErr) {
      console.warn('customers fetch skipped:', cErr.message);
      return res.json({ success: true, customers: [] });
    }
    const rows = customers || [];
    const ids = rows.map(c => c.id).filter(Boolean);
    const playMap = {};
    const favMap = {};
    if (ids.length) {
      try {
        const { data: evts } = await supabase
          .from('customer_events')
          .select('user_id, action')
          .in('user_id', ids)
          .limit(20000);
        (evts || []).forEach(e => {
          if (e.action === 'play') playMap[e.user_id] = (playMap[e.user_id] || 0) + 1;
        });
      } catch (_) {}
      try {
        const { data: favs } = await supabase
          .from('favorites')
          .select('user_id')
          .in('user_id', ids);
        (favs || []).forEach(f => { favMap[f.user_id] = (favMap[f.user_id] || 0) + 1; });
      } catch (_) {}
    }
    const out = rows.map(c => ({
      id: c.id,
      email: c.email || '',
      name: c.name || '',
      phone: c.phone || '',
      joined: c.created_at || null,
      lastActive: c.last_seen || null,
      plays: playMap[c.id] || 0,
      favorites: favMap[c.id] || 0,
    }));
    res.json({ success: true, customers: out });
  } catch (err) {
    res.json({ success: true, customers: [], error: err.message });
  }
});

// PUT /admin/licenses — body: { licenses: {lease, premium, stems, exclusive} }
app.put('/admin/licenses', requireAdminKey, async (req, res) => {
  try {
    const { licenses } = req.body || {};
    if (!licenses || typeof licenses !== 'object') {
      return res.status(400).json({ error: 'licenses object required' });
    }
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('license_terms').upsert({
      id: 1,
      terms: licenses,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin licenses update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/beat — multipart upload (audio + optional cover)
app.post('/upload/beat',
  requireAdminKey,
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { title, genre, bpm, key, mood, tags, description, lease_price, premium_price, stems_price } = req.body;

      if (!req.files?.audio?.[0]) {
        return res.status(400).json({ error: 'Audio file required' });
      }

      const audioFile = req.files.audio[0];
      const coverFile = req.files.cover?.[0];

      const audioUrl = await uploadAudioToStorage(
        audioFile.buffer,
        `${title || 'beat'}_${Date.now()}.mp3`,
        audioFile.mimetype
      );

      let coverUrl = '';
      if (coverFile) {
        coverUrl = await uploadCoverToStorage(
          coverFile.buffer,
          `${title || 'beat'}_cover_${Date.now()}.jpg`,
          coverFile.mimetype
        );
      }

      const beatId = await addBeatToDB({
        title, genre, bpm, key, mood,
        tags: tags ? tags.split(',') : [],
        description: description || '',
        lease_price, premium_price, stems_price,
        audio_url: audioUrl,
        cover_url: coverUrl,
      });

      // Send push notification to all customers about the new beat
      try {
        const tokens = await getPushTokens();
        if (tokens.length > 0) {
          sendPushNotification(
            tokens,
            '🎵 New Beat Released!',
            `Check out "${title}" — ${genre} · ${bpm} BPM`,
            { beatId, beatTitle: title, genre, bpm }
          ).catch(err => console.error('Push notification send error:', err));
        }
      } catch (notifErr) {
        console.error('Error sending push notifications:', notifErr);
      }

      res.json({ success: true, beatId, audioUrl, coverUrl, message: `Beat "${title}" uploaded!` });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// FILE UPLOAD PROXY (for OB Uploader mobile app)
// Routes: drive-proxy-small, drive-proxy-init, drive-proxy-chunk, drive-finalize, beat-metadata
// ──────────────────────────────────────────────────────────────────────────────

// Map file type to Supabase bucket + path prefix
function _bucketForType(type) {
  if (type === 'cover') return { bucket: 'cover-art', prefix: 'covers' };
  if (type === 'wav')   return { bucket: 'beats', prefix: 'wav' };
  if (type === 'stems') return { bucket: 'beats', prefix: 'stems' };
  return { bucket: 'beats', prefix: 'mp3' };
}

// POST /upload/drive-proxy-small — single-shot file upload via FormData
app.post('/upload/drive-proxy-small', requireAdminKey, upload.single('file'), async (req, res) => {
  try {
    const fileType = req.body.type || 'mp3';
    const { bucket, prefix } = _bucketForType(fileType);
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const safeName = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2,6)}_${(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).upload(safeName, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: true,
    });
    if (error) throw new Error(`Storage upload error: ${error.message}`);
    const publicUrl = supabase.storage.from(bucket).getPublicUrl(safeName).data.publicUrl;
    res.json({ success: true, publicUrl, path: safeName });
  } catch (err) {
    console.error('drive-proxy-small error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/drive-proxy-init — init direct-to-Supabase upload
// Returns a Supabase signed upload URL; client PUTs the WHOLE file in one request
// (Supabase signed upload URLs are one-shot — do NOT send chunks, you'll get 409 Duplicate)
app.post('/upload/drive-proxy-init', requireAdminKey, async (req, res) => {
  try {
    const { filename, mimeType, fileSize, type } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const fileType = type || 'mp3';
    const { bucket, prefix } = _bucketForType(fileType);
    const cleanName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectName = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2,6)}_${cleanName}`;

    // Prefer GCS resumable upload session — Supabase Storage is currently
    // quota-blocked. Falls back to Supabase only when GCS_BUCKET isn't set.
    let gcs = null;
    try { gcs = require('./gcsApi'); } catch (_) {}
    if (gcs && gcs.isGCSEnabled()) {
      // GCS resumable sessions need their OWN object name (the prefix
      // belongs to the GCS bucket layout, not Supabase). The helper
      // re-applies the SUPABASE_TO_GCS_PREFIX mapping.
      const out = await gcs.getResumableUploadSession(
        objectName.replace(new RegExp(`^${prefix}/`), ''),  // strip duplicate prefix
        bucket,
        mimeType || 'application/octet-stream'
      );
      return res.json({ success: true, uploadUrl: out.uploadUrl, path: out.path, bucket, publicUrl: out.publicUrl });
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(objectName);
    if (error) throw new Error(`Signed URL error: ${error.message}`);
    const publicUrl = supabase.storage.from(bucket).getPublicUrl(objectName).data.publicUrl;
    res.json({ success: true, uploadUrl: data.signedUrl, path: objectName, bucket, publicUrl, token: data.token });
  } catch (err) {
    console.error('drive-proxy-init error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /upload/drive-proxy-chunk — proxy a chunk to whatever storage the
// init endpoint returned (GCS resumable session OR Supabase signed URL).
// On serverless (Vercel), each chunk goes directly through to the
// upstream storage with Content-Range preserved.
app.put('/upload/drive-proxy-chunk', requireAdminKey, express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const uploadUrl = req.headers['x-upload-url'];
    const contentRange = req.headers['x-content-range'] || '';
    const contentType = req.headers['x-content-type'] || 'application/octet-stream';
    const chunkBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);

    if (uploadUrl && uploadUrl.startsWith('http')) {
      const isGcs = /storage\.googleapis\.com\/upload\//.test(uploadUrl);

      // GCS resumable PUT semantics differ slightly from Supabase TUS-like:
      //  - Don't send 'x-upsert'
      //  - GCS returns 200/201 on the FINAL chunk with full object metadata
      //  - GCS returns 308 on intermediate chunks (with Range: bytes=0-N header)
      const headers = {
        'Content-Type': contentType,
        'Content-Range': contentRange,
      };
      if (!isGcs) headers['x-upsert'] = 'true';

      const proxyRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        body: chunkBuf,
      });
      if (proxyRes.ok) {
        const data = await proxyRes.json().catch(() => ({}));
        // GCS returns {kind, id, selfLink, name, bucket, ...}; Supabase
        // returns {Key}. Encode provenance in fileId so finalize knows
        // which URL pattern to construct.
        let fileId;
        if (isGcs && data.name) {
          fileId = `gcs:${data.name}`;
        } else if (data.Key) {
          fileId = data.Key;
        } else {
          fileId = uploadUrl;
        }
        return res.json({ success: true, fileId, status: 200, done: true });
      }
      if (proxyRes.status === 308) {
        return res.json({ success: true, status: 308, done: false });
      }
      const errText = await proxyRes.text().catch(() => '');
      throw new Error(`Chunk upload failed (${proxyRes.status}): ${errText.substring(0, 200)}`);
    }

    // Fallback: upload the chunk as a complete file to Supabase
    const safeName = `uploads/chunk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const supabase = getSupabaseClient();
    const { error } = await supabase.storage.from('beats').upload(safeName, chunkBuf, {
      contentType, upsert: true,
    });
    if (error) throw new Error(`Chunk upload error: ${error.message}`);
    const publicUrl = supabase.storage.from('beats').getPublicUrl(safeName).data.publicUrl;
    return res.json({ success: true, fileId: safeName, publicUrl, done: true });
  } catch (err) {
    console.error('drive-proxy-chunk error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/drive-finalize — finalize upload, return public URL.
// Detects GCS uploads via the "gcs:" prefix the chunk endpoint stamps on
// fileId, and constructs a GCS public URL. Otherwise falls back to the
// Supabase URL pattern for legacy paths.
app.post('/upload/drive-finalize', requireAdminKey, async (req, res) => {
  try {
    const { fileId, path, bucket: bucketParam, type } = req.body;
    const storagePath = path || fileId;
    if (!storagePath) return res.status(400).json({ error: 'path or fileId required' });

    // GCS path provenance from /upload/drive-proxy-chunk.
    if (typeof storagePath === 'string' && storagePath.startsWith('gcs:')) {
      const objectPath = storagePath.slice(4); // strip "gcs:"
      let gcs = null;
      try { gcs = require('./gcsApi'); } catch (_) {}
      if (gcs && gcs.isGCSEnabled()) {
        return res.json({ success: true, publicUrl: gcs.publicUrl(objectPath) });
      }
      // GCS prefix but module unreachable — fall through to error
      return res.status(500).json({ error: 'GCS module not available for finalize' });
    }

    const bucket = bucketParam || _bucketForType(type).bucket;
    const supabase = getSupabaseClient();
    const cleanPath = String(storagePath).includes('/object/')
      ? String(storagePath).split('/object/')[1] || storagePath
      : storagePath;
    const publicUrl = supabase.storage.from(bucket).getPublicUrl(cleanPath).data.publicUrl;
    res.json({ success: true, publicUrl });
  } catch (err) {
    console.error('drive-finalize error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/get-signed-url — generate a signed upload URL for direct
// client → storage upload. Routes to GCS when GCS_BUCKET is set (default
// for prod), falls back to Supabase Storage only when GCS isn't
// configured. Supabase Storage is currently quota-blocked, so this is the
// primary path that retag / new-upload flows depend on.
//
// The desktop EXE PUTs the file with the file's own Content-Type. GCS v4
// signed URLs sign the Content-Type into the signature, so we derive it
// from the filename extension here and the client must PUT with the same
// header value (xhrPutWithProgress already does this).
function _mimeFromFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.mp3'))  return 'audio/mpeg';
  if (lower.endsWith('.wav'))  return 'audio/wav';
  if (lower.endsWith('.m4a'))  return 'audio/mp4';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.zip'))  return 'application/zip';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png'))  return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4'))  return 'video/mp4';
  return 'application/octet-stream';
}

app.post('/upload/get-signed-url', requireAdminKey, async (req, res) => {
  try {
    const { filename, bucket, mimeType } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const targetBucket = bucket || 'beats';
    const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const ct = mimeType || _mimeFromFilename(filename);

    // Prefer GCS when configured. This is the primary path now that
    // Supabase Storage is quota-restricted.
    let gcs = null;
    try { gcs = require('./gcsApi'); } catch (_) {}
    if (gcs && gcs.isGCSEnabled()) {
      const out = await gcs.getSignedUploadUrl(safeName, targetBucket, ct);
      return res.json({ success: true, signedUrl: out.signedUrl, publicUrl: out.publicUrl, path: out.path, contentType: out.contentType });
    }

    // Legacy Supabase fallback (will 503 under quota; only useful in dev).
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from(targetBucket).createSignedUploadUrl(safeName);
    if (error) throw new Error(`Signed URL error: ${error.message}`);
    const publicUrl = supabase.storage.from(targetBucket).getPublicUrl(safeName).data.publicUrl;
    res.json({ success: true, signedUrl: data.signedUrl, publicUrl, path: safeName });
  } catch (err) {
    console.error('get-signed-url error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Filename-based BPM/key fallback for when spectral analysis isn't available (MP3 on serverless).
function _filenameDetect(filename) {
  const name = String(filename || '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  let bpm = null, key = null;
  const bpmMatch = name.match(/(\d{2,3})\s*bpm/i);
  if (bpmMatch) {
    const v = parseInt(bpmMatch[1], 10);
    if (v >= 50 && v <= 250) bpm = v;
  }
  const keyPatterns = [
    { re: /\b([A-G])\s*sharp\s*(minor|major|min|maj)\b/i, fn: m => `${m[1]}# ${m[2].toLowerCase().startsWith('min') ? 'Minor' : 'Major'}` },
    { re: /\b([A-G])\s*flat\s*(minor|major|min|maj)\b/i, fn: m => `${m[1]}b ${m[2].toLowerCase().startsWith('min') ? 'Minor' : 'Major'}` },
    { re: /\b([A-G][b#]?)\s*(minor|major|min|maj)\b/i, fn: m => `${m[1]} ${m[2].toLowerCase().startsWith('min') ? 'Minor' : 'Major'}` },
    { re: /\b([A-G][b#]?)m\b/, fn: m => `${m[1]} Minor` },
    { re: /\b([A-G][b#])\b/, fn: m => `${m[1]} Major` },
  ];
  for (const { re, fn } of keyPatterns) {
    const m = name.match(re);
    if (m) { key = fn(m); break; }
  }
  return { bpm, key };
}

function _moodFrom(bpm, key) {
  if (!bpm || !key) return null;
  const isMinor = key.includes('Minor');
  if (bpm >= 140 && isMinor) return 'Aggressive';
  if (bpm >= 140) return 'Energetic';
  if (bpm >= 110 && isMinor) return 'Dark';
  if (bpm >= 110) return 'Uplifting';
  if (bpm >= 85 && isMinor) return 'Melancholic';
  if (bpm >= 85) return 'Smooth';
  return isMinor ? 'Chill' : 'Dreamy';
}

// POST /upload/analyze-audio — BPM + key detection from uploaded audio file
// Strategy: spectral analysis on WAVs, filename parsing as fallback/complement for MP3
app.post('/upload/analyze-audio', requireAdminKey, upload.single('audio'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No audio file provided' });

    const fromName = _filenameDetect(file.originalname || '');

    const MusicTempo = require('music-tempo');
    const fftJs = require('fft-js');
    const fft = fftJs.fft;
    const fftMag = fftJs.util.fftMag;

    let pcmData = null, sampleRate = null;
    const nameLc = (file.originalname || '').toLowerCase();
    const mimeLc = (file.mimetype || '').toLowerCase();
    const isWav = nameLc.endsWith('.wav') || mimeLc.includes('wav');
    const isMp3 = nameLc.endsWith('.mp3') || mimeLc.includes('mpeg') || mimeLc.includes('mp3');

    if (isWav) {
      try {
        const wavDecoder = require('wav-decoder');
        const decoded = await wavDecoder.decode(file.buffer);
        pcmData = decoded.channelData[0];
        sampleRate = decoded.sampleRate;
      } catch (_) { /* fall through */ }
    }

    if (!pcmData) {
      try {
        const { MPEGDecoder } = await import('mpg123-decoder');
        const decoder = new MPEGDecoder();
        await decoder.ready;
        const decoded = decoder.decode(new Uint8Array(file.buffer));
        if (decoded && decoded.channelData && decoded.channelData[0]) {
          pcmData = decoded.channelData[0];
          sampleRate = decoded.sampleRate;
        }
        decoder.free();
      } catch (e) {
        console.warn('MP3 decode failed:', e.message);
      }
    }

    if (!pcmData) {
      const key = fromName.key;
      const bpm = fromName.bpm;
      return res.json({
        success: true, bpm, key, mood: _moodFrom(bpm, key),
        source: 'filename',
        note: isMp3 ? 'MP3 decode unavailable — using filename' : 'Upload WAV/MP3 for spectral analysis',
      });
    }

    // Limit analysis to first 30 seconds for speed
    const maxSamples = sampleRate * 30;
    const samples = pcmData.length > maxSamples ? pcmData.slice(0, maxSamples) : pcmData;

    // ── BPM Detection ──
    let bpm = null;
    try {
      const mt = new MusicTempo(Array.from(samples));
      bpm = Math.round(mt.tempo);
    } catch (e) {
      console.warn('BPM detection failed:', e.message);
    }

    // ── Key Detection via Chromagram + Krumhansl-Kessler profiles ──
    let key = null;
    try {
      const N = 4096;
      const hop = 2048;
      const chroma = new Float64Array(12);
      const numFrames = Math.floor((samples.length - N) / hop);
      const limit = Math.min(numFrames, 300);

      for (let frame = 0; frame < limit; frame++) {
        const start = frame * hop;
        const windowed = [];
        for (let i = 0; i < N; i++) {
          const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
          windowed.push([(samples[start + i] || 0) * w, 0]);
        }
        const spectrum = fft(windowed);
        const mags = fftMag(spectrum);

        const minBin = Math.floor(50 * N / sampleRate);
        const maxBin = Math.floor(2000 * N / sampleRate);
        for (let k = minBin; k <= maxBin; k++) {
          const freq = k * sampleRate / N;
          const midiNote = 12 * Math.log2(freq / 440) + 69;
          const pitchClass = ((Math.round(midiNote) % 12) + 12) % 12;
          chroma[pitchClass] += mags[k] * mags[k];
        }
      }

      const maxC = Math.max(...chroma);
      if (maxC > 0) for (let i = 0; i < 12; i++) chroma[i] /= maxC;

      const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
      const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
      const noteNames = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

      let bestCorr = -Infinity;
      let bestKey = 'C Major';
      for (let shift = 0; shift < 12; shift++) {
        let corrMaj = 0, corrMin = 0;
        for (let i = 0; i < 12; i++) {
          const idx = (i + shift) % 12;
          corrMaj += chroma[idx] * majorProfile[i];
          corrMin += chroma[idx] * minorProfile[i];
        }
        if (corrMaj > bestCorr) { bestCorr = corrMaj; bestKey = noteNames[shift] + ' Major'; }
        if (corrMin > bestCorr) { bestCorr = corrMin; bestKey = noteNames[shift] + ' Minor'; }
      }
      key = bestKey;
    } catch (e) {
      console.warn('Key detection failed:', e.message);
    }

    // Merge spectral results with filename hints (filename fills gaps only)
    const finalBpm = bpm || fromName.bpm;
    const finalKey = key || fromName.key;
    res.json({
      success: true,
      bpm: finalBpm,
      key: finalKey,
      mood: _moodFrom(finalBpm, finalKey),
      source: bpm || key ? 'spectral' : 'filename',
    });
  } catch (err) {
    console.error('analyze-audio error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/convert-wav-to-mp3 — convert uploaded WAV to MP3 (320kbps), returns MP3 binary
app.post('/upload/convert-wav-to-mp3', requireAdminKey, upload.single('audio'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No audio file provided' });

    const wavDecoder = require('wav-decoder');
    const lamejs = await import('@breezystack/lamejs');

    const decoded = await wavDecoder.decode(file.buffer);
    const sampleRate = decoded.sampleRate;
    const channels = decoded.channelData.length;
    const numChannels = channels >= 2 ? 2 : 1;

    const toInt16 = (floatArr) => {
      const out = new Int16Array(floatArr.length);
      for (let i = 0; i < floatArr.length; i++) {
        const s = Math.max(-1, Math.min(1, floatArr[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    };

    const left = toInt16(decoded.channelData[0]);
    const right = numChannels === 2 ? toInt16(decoded.channelData[1]) : null;

    const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, 320);
    const blockSize = 1152;
    const chunks = [];
    for (let i = 0; i < left.length; i += blockSize) {
      const lChunk = left.subarray(i, i + blockSize);
      const rChunk = right ? right.subarray(i, i + blockSize) : null;
      const mp3buf = rChunk ? encoder.encodeBuffer(lChunk, rChunk) : encoder.encodeBuffer(lChunk);
      if (mp3buf.length > 0) chunks.push(Buffer.from(mp3buf));
    }
    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(Buffer.from(tail));

    const mp3Buffer = Buffer.concat(chunks);
    const baseName = (file.originalname || 'converted').replace(/\.wav$/i, '') || 'converted';
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Disposition', `attachment; filename="${baseName}.mp3"`);
    res.send(mp3Buffer);
  } catch (err) {
    console.error('convert-wav-to-mp3 error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/tag-beat — bake producer tag into MP3 at BPM-aligned bar intervals
// Fields: audio (MP3 file), tag (MP3 file), bpm, bars (4/8/16/32), firstBar (0/4/8/16),
//         volume (0-1.2), duck (bool), offsetMs (int, can be negative)
app.post('/upload/tag-beat', requireAdminKey,
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'tag', maxCount: 1 }]),
  async (req, res) => {
    try {
      const audioFile = req.files?.audio?.[0];
      const tagFile = req.files?.tag?.[0];
      if (!audioFile) return res.status(400).json({ error: 'audio file required' });
      if (!tagFile) return res.status(400).json({ error: 'tag file required' });

      const bpm = Number(req.body.bpm) || 120;
      const bars = Number(req.body.bars) || 8;
      const firstBar = Number(req.body.firstBar) || 0;
      const volume = Math.max(0, Math.min(1.5, Number(req.body.volume) || 0.85));
      const duck = String(req.body.duck) === 'true' || req.body.duck === true;
      const offsetMs = Number(req.body.offsetMs) || 0;

      const { MPEGDecoder } = await import('mpg123-decoder');
      const lamejs = await import('@breezystack/lamejs');

      const decodeMp3 = async (buf) => {
        const d = new MPEGDecoder();
        await d.ready;
        const out = d.decode(new Uint8Array(buf));
        d.free();
        return out; // { channelData: [L, R?], sampleRate, samplesDecoded }
      };

      const beat = await decodeMp3(audioFile.buffer);
      const tag = await decodeMp3(tagFile.buffer);
      if (!beat?.channelData?.[0]) throw new Error('Beat MP3 decode failed');
      if (!tag?.channelData?.[0]) throw new Error('Tag MP3 decode failed');

      const sampleRate = beat.sampleRate;
      const beatL = beat.channelData[0];
      const beatR = beat.channelData[1] || beat.channelData[0];

      // Resample tag if sample rates differ (linear resample)
      const resample = (src, srcRate, dstRate) => {
        if (srcRate === dstRate) return src;
        const ratio = srcRate / dstRate;
        const dstLen = Math.floor(src.length / ratio);
        const out = new Float32Array(dstLen);
        for (let i = 0; i < dstLen; i++) {
          const srcPos = i * ratio;
          const i0 = Math.floor(srcPos);
          const i1 = Math.min(i0 + 1, src.length - 1);
          const frac = srcPos - i0;
          out[i] = src[i0] * (1 - frac) + src[i1] * frac;
        }
        return out;
      };
      const tagL = resample(tag.channelData[0], tag.sampleRate, sampleRate);
      const tagR = resample(tag.channelData[1] || tag.channelData[0], tag.sampleRate, sampleRate);

      // Copy beat into output buffers
      const outL = new Float32Array(beatL);
      const outR = new Float32Array(beatR);

      // Compute tag positions
      const secondsPerBar = (60 / bpm) * 4;
      const samplesPerBar = Math.round(secondsPerBar * sampleRate);
      const offsetSamples = Math.round((offsetMs / 1000) * sampleRate);
      const firstSample = firstBar * samplesPerBar + offsetSamples;
      const stepSamples = bars * samplesPerBar;
      const tagLen = tagL.length;
      const duckFactor = duck ? 0.5 : 1.0;

      let pos = firstSample;
      while (pos < outL.length) {
        if (pos >= 0) {
          const fadeLen = Math.min(Math.round(0.01 * sampleRate), Math.floor(tagLen / 4));
          for (let i = 0; i < tagLen && pos + i < outL.length; i++) {
            if (pos + i < 0) continue;
            let env = 1;
            if (i < fadeLen) env = i / fadeLen;
            else if (i > tagLen - fadeLen) env = (tagLen - i) / fadeLen;
            const sL = tagL[i] * volume * env;
            const sR = tagR[i] * volume * env;
            outL[pos + i] = outL[pos + i] * duckFactor + sL;
            outR[pos + i] = outR[pos + i] * duckFactor + sR;
          }
        }
        pos += stepSamples;
      }

      // Encode back to MP3
      const toInt16 = (f32) => {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]));
          out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
      };
      const i16L = toInt16(outL);
      const i16R = toInt16(outR);

      const encoder = new lamejs.Mp3Encoder(2, sampleRate, 192);
      const blockSize = 1152;
      const chunks = [];
      for (let i = 0; i < i16L.length; i += blockSize) {
        const lChunk = i16L.subarray(i, i + blockSize);
        const rChunk = i16R.subarray(i, i + blockSize);
        const mp3buf = encoder.encodeBuffer(lChunk, rChunk);
        if (mp3buf.length > 0) chunks.push(Buffer.from(mp3buf));
      }
      const tail = encoder.flush();
      if (tail.length > 0) chunks.push(Buffer.from(tail));

      const mp3Buffer = Buffer.concat(chunks);
      const baseName = (audioFile.originalname || 'tagged').replace(/\.mp3$/i, '') || 'tagged';
      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Disposition', `attachment; filename="${baseName}_tagged.mp3"`);
      res.send(mp3Buffer);
    } catch (err) {
      console.error('tag-beat error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /upload/proxy-image — fetch an image URL and return it (for CORS-blocked images)
app.post('/upload/proxy-image', requireAdminKey, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
        const imgRes = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!imgRes.ok) throw new Error(`Image fetch failed (${imgRes.status})`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (err) {
    console.error('proxy-image error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/cover-from-url — fetch image from URL and upload to Supabase Storage
app.post('/upload/cover-from-url', requireAdminKey, async (req, res) => {
  try {
    const { imageUrl, filename } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
        const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!imgRes.ok) throw new Error(`Image fetch failed (${imgRes.status})`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const safeName = `covers/${filename || `cover_${Date.now()}.jpg`}`;
    const supabase = getSupabaseClient();
    const { error } = await supabase.storage.from('cover-art').upload(safeName, buffer, {
      contentType, upsert: false,
    });
    if (error) throw new Error(`Cover upload error: ${error.message}`);
    const publicUrl = supabase.storage.from('cover-art').getPublicUrl(safeName).data.publicUrl;
    res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('cover-from-url error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/beat-metadata — register beat in DB (no file upload, just metadata + URLs)
app.post('/upload/beat-metadata', requireAdminKey, async (req, res) => {
  try {
    const { title, genre, subgenre, bpm, key, mood, tags, description, lease_price, premium_price, stems_price, exclusive_price, audio_url, audio_original_url, wav_url, stem_url, cover_url, announce, announce_title, announce_body, scheduled_for } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    // Scheduled upload validation:
    //   • Must be a parseable date
    //   • Must be in the future (else it's just "now", same as no scheduling)
    //   • Max 30 days ahead — protects against typo-fat-finger drops in 2099
    let scheduledForIso = null;
    let isScheduledFuture = false;
    if (scheduled_for) {
      const d = new Date(scheduled_for);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'scheduled_for must be a valid ISO 8601 timestamp' });
      }
      const ms = d.getTime() - Date.now();
      if (ms > 30 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'scheduled_for cannot be more than 30 days in the future' });
      }
      if (ms > 0) {
        scheduledForIso = d.toISOString();
        isScheduledFuture = true;
      }
      // ms <= 0 → treat as immediate publish, ignore the field silently
    }

    const beatId = await addBeatToDB({
      title, genre: genre || '', subgenre: subgenre || '',
      bpm: bpm || '120', key: key || '', mood: mood || '',
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',')) : [],
      description: description || '',
      lease_price: lease_price || 29.99,
      premium_price: premium_price || 99.99,
      stems_price: stems_price || 199.99,
      exclusive_price: exclusive_price || null,
      audio_url: audio_url || '', audio_original_url: audio_original_url || '',
      wav_url: wav_url || '', stem_url: stem_url || '',
      cover_url: cover_url || '',
      scheduled_for: scheduledForIso,
    });

    // Enqueue auto-upload (YouTube/IG/TikTok). Non-blocking — if this throws
    // we still want the beat itself to be "live" for the customer app, so
    // failures here log-and-move-on. The cron worker retries pending jobs.
    //
    // Gated on the `auto_publish` field in the request body. The desktop EXE
    // sends this explicitly via its "Auto-publish to YouTube / Meta / IG"
    // toggle — when OFF the producer drives publishing from the Beat → Video
    // modal instead. When the field is undefined (older clients, mobile
    // uploader), we default to TRUE to preserve previous behavior.
    const shouldAutoPublish = (req.body.auto_publish === undefined) ? true : !!req.body.auto_publish;
    if (autoUpload && audio_url && shouldAutoPublish) {
      autoUpload.enqueueBeat({
        id: beatId,
        title,
        slug: (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80),
        genre: genre || 'Hip Hop',
        bpm: bpm || null,
        key: key || null,
        mood: mood || null,
        audioUrl: audio_url,
        coverUrl: cover_url || null,
      }).catch(err => console.warn('[auto-upload] enqueue failed:', err.message));
    } else if (autoUpload && audio_url && !shouldAutoPublish) {
      console.log(`[auto-upload] skipped for "${title}" — auto_publish=false (producer will publish manually)`);
    }

    // Push broadcast on new beat — opt-in. Uploader sends announce:false to skip
    // (e.g. reuploads / test uploads). Custom title/body optional.
    //
    // SKIPPED for scheduled uploads — push tells customers about a beat they
    // can't see yet (active=false). The cron /cron/publish-scheduled fires
    // push when it flips the beat live.
    if (announce !== false && !isScheduledFuture) {
      try {
        const tokens = await getPushTokens();
        if (tokens.length > 0) {
          const pTitle = (typeof announce_title === 'string' && announce_title.trim()) || '🎵 New Beat Released!';
          const pBody = (typeof announce_body === 'string' && announce_body.trim()) ||
            `Check out "${title}" — ${genre || 'New'} · ${bpm || '?'} BPM`;
          sendPushNotification(
            tokens,
            pTitle,
            pBody,
            { beatId, beatTitle: title, genre, bpm }
          ).catch(err => console.error('Push notification send error:', err));
        }
      } catch (notifErr) {
        console.error('Error sending push notifications:', notifErr);
      }
    }

    // 2026-05-07 — auto-email broadcast on new-beat publish. Same mailer as
    // /admin/send-free-beat, but fires for EVERY beat upload (subject framed
    // as "new drop" instead of "free beat of the week"). Uses the tagged
    // preview URL — clean untagged audio stays paid-only. Fully best-effort:
    // mailer/SMTP failures must never block the upload route. Honors
    // announce:false (uploader can opt out for re-uploads / test runs) AND
    // the broadcast_email flag (uploader can disable email-only without
    // disabling push, e.g. when shipping a quick fix).
    // Email broadcast also waits for active=true on scheduled uploads — same
    // logic as push (don't email customers about a hidden beat).
    if (announce !== false && req.body.broadcast_email !== false && !isScheduledFuture) {
      // Fire and forget — never block the response.
      (async () => {
        try {
          const supabase = getSupabaseClient();
          const { data: subs } = await supabase.from('email_subscribers')
            .select('email, token').is('unsubscribed_at', null);
          const recipients = (subs || []).filter(s => s.email);
          // 2026-05-07 — DON'T early-return on zero subscribers. We still
          // want to email the producer a summary so they have a Gmail-side
          // record of every publish (and can build their filter rule even
          // before the first real subscriber exists). The `recipients.length
          // === 0` branch lower in this block handles the summary email.
          const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://oneilbeats.store';
          const beatLandingUrl = `${PUBLIC_BASE}/beat/${beatId}`;
          const taggedUrl = audio_url;
          const cover = cover_url || `${PUBLIC_BASE}/og-image.jpg`;
          const subject = `🔥 New Drop: ${title} — ${genre || "O'Neil Beats"}${bpm ? ' · ' + bpm + ' BPM' : ''}`;
          let sent = 0, failed = 0;
          for (const sub of recipients) {
            const unsubUrl = `${process.env.PUBLIC_BASE_URL || 'https://oneil-beats-backend.vercel.app'}/unsubscribe?email=${encodeURIComponent(sub.email)}&token=${sub.token}`;
            const html = `
              <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;background:#06060a;color:#e2e8f0;padding:32px;border-radius:12px">
                <div style="text-align:center;margin-bottom:24px">
                  <div style="color:#e63946;font-size:11px;font-weight:900;letter-spacing:2px">🔥 NEW BEAT JUST DROPPED</div>
                  <h1 style="color:#fff;margin:8px 0 0;font-size:26px">${title}</h1>
                  <p style="color:#aaa;font-size:13px;margin-top:6px">${genre || ''}${bpm ? ' · ' + bpm + ' BPM' : ''}${key ? ' · ' + key : ''}${mood ? ' · ' + mood : ''}</p>
                </div>
                ${cover ? `<img src="${cover}" alt="cover" style="width:100%;max-width:400px;border-radius:12px;display:block;margin:0 auto 24px">` : ''}
                <div style="text-align:center;margin:24px 0">
                  <a href="${beatLandingUrl}" style="display:inline-block;background:linear-gradient(135deg,#d4af37 0%,#e63946 100%);color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:900;font-size:14px;letter-spacing:0.5px;margin:0 6px 8px 0">🎧 LISTEN + LICENSE</a>
                  <a href="${taggedUrl}" style="display:inline-block;background:#1a1a26;color:#e2e8f0;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;border:1px solid #333;margin:0 6px 8px 0">⬇ Free Tagged Preview</a>
                </div>
                <p style="color:#aaa;font-size:13px;line-height:1.6;text-align:center;margin-top:16px">
                  Lease from $29.99 · Premium $99.99 · Stems $199.99 · Exclusive available<br>
                  Use code <strong style="color:#fbbf24">FIRST10</strong> for 10% off your first beat.
                </p>
                <hr style="border:none;border-top:1px solid #222;margin:28px 0 20px">
                <p style="color:#555;font-size:11px;text-align:center">
                  You're receiving this because you subscribed to O'Neil Beats updates.<br>
                  <a href="${unsubUrl}" style="color:#888">Unsubscribe</a> · <a href="${PUBLIC_BASE}" style="color:#888">oneilbeats.store</a>
                </p>
              </div>`;
            try {
              await mailer.sendMail({
                from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
                to: sub.email,
                // 2026-05-07 — BCC the producer (configurable via env) so they
                // have a permanent Gmail-side record of every blast that went
                // out. Combined with a one-time Gmail filter that auto-labels
                // any incoming message with subject "🔥 New Drop:" → label
                // "OB Beats - New Drops", every send lands in a clean folder
                // for retro analysis. Falls back silently if env unset.
                ...(process.env.NEW_BEAT_EMAIL_ARCHIVE_BCC ? { bcc: process.env.NEW_BEAT_EMAIL_ARCHIVE_BCC } : {}),
                subject,
                html,
                // X-headers are picked up by Gmail's "matches:" filter syntax
                // so the user can also filter by header instead of subject if
                // they ever change the subject pattern.
                headers: {
                  'X-OB-Email-Type': 'new-beat-drop',
                  'X-OB-Beat-Id': String(beatId),
                  'X-OB-Beat-Title': title || '',
                },
              });
              sent++;
            } catch (e) {
              failed++;
              console.warn('[new-beat-email] failed for', sub.email, ':', e.message);
            }
          }
          // 2026-05-07 — additionally email the producer a single SUMMARY
          // message even if no subscribers exist yet (so they can verify the
          // blast pipeline is working without needing real subscribers, and
          // can build the Gmail filter rule against the summary message
          // immediately on first publish). Subject deliberately matches the
          // same "🔥 New Drop:" pattern so the same Gmail filter labels both.
          const archiveTo = process.env.NEW_BEAT_EMAIL_ARCHIVE_BCC || process.env.EMAIL_FROM;
          if (archiveTo && recipients.length === 0) {
            try {
              await mailer.sendMail({
                from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
                to: archiveTo,
                subject: `🔥 New Drop: ${title} — (no subscribers yet, summary only)`,
                html: `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:24px;background:#06060a;color:#e2e8f0;border-radius:12px"><h2 style="color:#d4af37">📊 Blast pipeline test fire</h2><p>Beat <strong style="color:#fff">${title}</strong> was published, but the email_subscribers table is empty so no fans received the drop email yet.</p><p>Beat ID: <code>${beatId}</code> · Genre: ${genre || '—'} · BPM: ${bpm || '—'}</p><p style="color:#aaa;font-size:13px">Once you have subscribers, this same template (without this notice) goes out to all of them automatically.</p></div>`,
                headers: {
                  'X-OB-Email-Type': 'new-beat-drop-archive',
                  'X-OB-Beat-Id': String(beatId),
                  'X-OB-Beat-Title': title || '',
                },
              });
              console.log(`[new-beat-email] archive-summary sent to ${archiveTo} (no subscribers yet)`);
            } catch (e) {
              console.warn('[new-beat-email] archive-summary failed:', e.message);
            }
          }
          console.log(`[new-beat-email] sent ${sent}/${recipients.length} for "${title}" (${failed} failed)`);
        } catch (err) {
          console.error('[new-beat-email] broadcast error:', err.message);
        }
      })();
    }

    res.json({ success: true, beatId, message: `Beat "${title}" is live!` });
  } catch (err) {
    console.error('beat-metadata error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI COVER ART GENERATION
// ──────────────────────────────────────────────────────────────────────────────

// Composite a branded title strip onto a cover image.
// meta: { title, genre, bpm, key, accentHex? }
// Returns a PNG buffer. Never throws — falls back to the raw buffer on error.
async function compositeTitleOnCover(imageBuffer, meta = {}) {
  try {
    const { title = '', genre = '', bpm = '', key = '', accentHex = '#fbbf24' } = meta;
    const SIZE = 1024;
    const STRIP = 260;
    const PAD_X = 56;

    const titleText = String(title || '').toUpperCase().trim();
    const metaParts = [];
    if (genre) metaParts.push(String(genre).toUpperCase());
    if (bpm) metaParts.push(`${bpm} BPM`);
    if (key) metaParts.push(String(key).toUpperCase());
    const metaText = metaParts.join('  ·  ');

    // Normalize input to 1024x1024
    const base = await sharp(imageBuffer)
      .resize(SIZE, SIZE, { fit: 'cover', position: 'centre' })
      .toBuffer();

    const layers = [];

    // Bottom gradient strip as SVG
    const gradientSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${STRIP}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="30%" stop-color="#000" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.95"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${STRIP}" fill="url(#g)"/>
</svg>`.trim());
    layers.push({ input: gradientSvg, top: SIZE - STRIP, left: 0 });

    // Title — Anton, white, large, two-line auto-wrap
    if (titleText) {
      const titleBuf = await sharp({
        text: {
          text: `<span foreground="white">${escapeXmlMinimal(titleText)}</span>`,
          fontfile: ANTON_FONT_PATH,
          font: 'Anton 96',
          rgba: true,
          width: SIZE - PAD_X * 2,
          height: 180,
          align: 'low',
          wrap: 'word',
        },
      }).png().toBuffer();
      const titleMeta = await sharp(titleBuf).metadata();
      const titleH = titleMeta.height || 100;
      layers.push({ input: titleBuf, top: SIZE - PAD_X - titleH - 46, left: PAD_X });
    }

    // Meta line — Anton, accent color, smaller, single line
    if (metaText) {
      const metaBuf = await sharp({
        text: {
          text: `<span foreground="${accentHex}" letter_spacing="2000">${escapeXmlMinimal(metaText)}</span>`,
          fontfile: ANTON_FONT_PATH,
          font: 'Anton 36',
          rgba: true,
          width: SIZE - PAD_X * 2,
          height: 44,
          align: 'low',
        },
      }).png().toBuffer();
      layers.push({ input: metaBuf, top: SIZE - PAD_X - 44, left: PAD_X });
    }

    return await sharp(base).composite(layers).png({ quality: 92 }).toBuffer();
  } catch (err) {
    console.warn('compositeTitleOnCover failed, returning raw buffer:', err.message);
    return imageBuffer;
  }
}

function escapeXmlMinimal(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Build a creative cover prompt via Claude Haiku. Falls back to a templated prompt if Claude is unavailable.
async function buildCoverPromptSmart({ genre, mood, bpm, key: beatKey, title, tags }) {
  const anthropic = getAnthropic();
  const safeGenre = genre || 'hip hop';
  const safeMood = mood || 'Dark';

  // Fallback template (used if no ANTHROPIC_API_KEY or if call fails)
  const fallback = () => {
    const theme = COVER_THEMES[safeMood] || COVER_THEMES['Dark'];
    const p = theme.prompts[Math.floor(Math.random() * theme.prompts.length)];
    const toneContext = beatKey && String(beatKey).toLowerCase().includes('minor') ? ', moody dark tones' : beatKey ? ', bright warm tones' : '';
    const tagContext = tags ? `, ${tags} aesthetic` : '';
    return `${p}, ${safeGenre} music album cover${tagContext}${toneContext}, square format, cinematic, high quality, no text no words no letters`;
  };

  if (!anthropic) return fallback();

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write ONE vivid image-generation prompt (max 40 words) for an album cover for a ${safeGenre} beat titled "${title || 'untitled'}" with a ${safeMood} mood${beatKey ? `, in ${beatKey}` : ''}${bpm ? `, ${bpm} BPM` : ''}. Focus on cinematic mood, lighting, and a specific visual scene. Avoid people's faces. End with: "square format, no text no words no letters". Output ONLY the prompt, no preamble, no quotes.`,
      }],
    });
    const text = (msg.content?.[0]?.text || '').trim();
    if (text && text.length > 20 && text.length < 600) return text;
    return fallback();
  } catch (err) {
    console.warn('Claude cover-prompt failed, using template:', err.message);
    return fallback();
  }
}

// POST /upload/generate-cover — generate AI cover art via Pollinations.ai
app.post('/upload/generate-cover', requireAdminKey, async (req, res) => {
  try {
    const { mood, title, genre, tags, key: beatKey, bpm, seed: clientSeed, prompt: clientPrompt, skipComposite } = req.body;
    if (!mood) return res.status(400).json({ error: 'mood required' });

    // Use client-supplied prompt if given (picked from /generate-covers-smart); otherwise build one.
    let fullPrompt;
    if (clientPrompt && typeof clientPrompt === 'string' && clientPrompt.length < 1000) {
      fullPrompt = clientPrompt;
    } else {
      fullPrompt = await buildCoverPromptSmart({ genre, mood, bpm, key: beatKey, title, tags });
    }

    const seed = clientSeed || Date.now();
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;

    try {
      const imgRes = await fetch(pollinationsUrl, { signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) throw new Error(`Pollinations returned ${imgRes.status}`);
      const rawBuffer = Buffer.from(await imgRes.arrayBuffer());

      // Composite title + meta strip unless caller opted out (e.g. custom-uploaded cover)
      const finalBuffer = skipComposite
        ? rawBuffer
        : await compositeTitleOnCover(rawBuffer, { title, genre, bpm, key: beatKey });

      const filename = `ai_cover_${seed}${skipComposite ? '_raw' : '_branded'}.png`;
      const coverUrl = await uploadCoverToStorage(finalBuffer, filename, 'image/png');
      res.json({
        success: true,
        image_url: coverUrl,
        source: 'pollinations',
        branded: !skipComposite,
        mood,
        prompt: fullPrompt,
        seed,
      });
    } catch (pollErr) {
      console.warn('Pollinations fetch/upload failed, returning direct URL:', pollErr.message);
      res.json({
        success: true,
        image_url: pollinationsUrl,
        source: 'pollinations-direct',
        branded: false,
        mood,
        prompt: fullPrompt,
        seed,
      });
    }
  } catch (err) {
    console.error('Cover generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/compose-cover — composite a branded strip onto an existing image URL.
// Use this to "brand" a custom-uploaded cover without regenerating.
// Body: { image_url, title, genre?, bpm?, key? }
app.post('/upload/compose-cover', requireAdminKey, async (req, res) => {
  try {
    const { image_url, title, genre, bpm, key: beatKey } = req.body || {};
    if (!image_url) return res.status(400).json({ error: 'image_url required' });
    if (!title) return res.status(400).json({ error: 'title required' });
    const imgRes = await fetch(image_url, { signal: AbortSignal.timeout(30000) });
    if (!imgRes.ok) throw new Error(`Source image returned ${imgRes.status}`);
    const raw = Buffer.from(await imgRes.arrayBuffer());
    const composed = await compositeTitleOnCover(raw, { title, genre, bpm, key: beatKey });
    const filename = `branded_${Date.now()}.png`;
    const coverUrl = await uploadCoverToStorage(composed, filename, 'image/png');
    res.json({ success: true, image_url: coverUrl, branded: true });
  } catch (err) {
    console.error('compose-cover error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/generate-covers — return N varied previews (default 4).
// Body: { mood, title?, genre?, bpm?, tags?, key?, count? }
// Uses Claude Haiku to write a rich creative prompt, then generates N seeded Pollinations URLs.
// Previews are raw (un-branded) to save bandwidth; caller picks one and calls /upload/generate-cover
// with the chosen { prompt, seed, title, genre, bpm, key } to produce the branded final image.
app.post('/upload/generate-covers', requireAdminKey, async (req, res) => {
  try {
    const { mood, title, genre, bpm, tags, key: beatKey, count } = req.body || {};
    if (!mood) return res.status(400).json({ error: 'mood required' });

    const total = Math.min(Math.max(parseInt(count) || 4, 1), 10);
    // Build one rich prompt via Claude, reuse across variants (seed drives variation)
    const fullPrompt = await buildCoverPromptSmart({ genre, mood, bpm, key: beatKey, title, tags });

    const baseTime = Date.now();
    const previews = [];
    for (let i = 0; i < total; i++) {
      // Seeds spaced wide + salted so Pollinations returns genuinely different images
      const seed = baseTime + i * 104729 + Math.floor(Math.random() * 99991);
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
      previews.push({ id: `preview_${seed}`, url, seed, prompt: fullPrompt });
    }

    res.json({ success: true, previews, mood, count: total, prompt_source: getAnthropic() ? 'claude' : 'template' });
  } catch (err) {
    console.error('Covers generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /upload/cover-library — list saved AI covers from Supabase storage
app.get('/upload/cover-library', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from('cover-art').list('', {
      limit: 100,
      sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) throw error;
    const covers = (data || [])
      .filter(f => f.name.startsWith('ai_cover_'))
      .map(f => {
        const { data: urlData } = supabase.storage.from('cover-art').getPublicUrl(f.name);
        return { name: f.name, url: urlData.publicUrl, created: f.created_at };
      });
    res.json({ success: true, covers });
  } catch (err) {
    console.error('Cover library error:', err);
    res.status(500).json({ error: err.message });
  }
});

// (duplicate /upload/analyze-audio endpoint removed — see definition above)

// ──────────────────────────────────────────────────────────────────────────────
// AI TEXT — TITLE SUGGESTIONS + DESCRIPTION (Claude Haiku)
// ──────────────────────────────────────────────────────────────────────────────

// POST /upload/suggest-title — return 3 title suggestions for a beat.
// Body: { genre?, mood?, bpm?, key? }
// Requires ANTHROPIC_API_KEY env var. Falls back to generic suggestions if missing.
app.post('/upload/suggest-title', requireAdminKey, async (req, res) => {
  const { genre = '', mood = '', bpm = '', key: beatKey = '' } = req.body || {};
  const fallback = ['Untitled', 'Midnight Run', 'Golden Hour'];
  const anthropic = getAnthropic();
  if (!anthropic) return res.json({ success: true, source: 'fallback', titles: fallback });
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Give me 3 short (1-3 word) evocative titles for a ${genre || 'hip hop'} beat with a ${mood || 'moody'} vibe${beatKey ? ` in ${beatKey}` : ''}${bpm ? ` at ${bpm} BPM` : ''}. Producer brand: O'Neil Beats — urban, cinematic, Latin/hip-hop crossover. Output ONLY 3 titles, one per line, no numbering, no quotes, no explanation.`,
      }],
    });
    const text = (msg.content?.[0]?.text || '').trim();
    const titles = text
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*[-*\d.]+\s*/, '').replace(/^"|"$/g, '').trim())
      .filter(s => s.length > 0 && s.length < 50)
      .slice(0, 3);
    res.json({ success: true, source: 'claude', titles: titles.length ? titles : fallback });
  } catch (err) {
    console.warn('suggest-title failed:', err.message);
    res.json({ success: true, source: 'fallback', titles: fallback, error: err.message });
  }
});

// POST /upload/generate-description — return a 2-sentence marketing description.
// Body: { title?, genre?, mood?, bpm?, key?, subgenre? }
app.post('/upload/generate-description', requireAdminKey, async (req, res) => {
  const { title = '', genre = '', mood = '', bpm = '', key: beatKey = '', subgenre = '' } = req.body || {};
  const templateFallback = () => {
    const pieces = [];
    if (genre) pieces.push(`A ${mood ? mood.toLowerCase() + ' ' : ''}${genre.toLowerCase()} beat`);
    else pieces.push('A versatile beat');
    if (bpm) pieces.push(`locked at ${bpm} BPM`);
    if (beatKey) pieces.push(`in ${beatKey}`);
    return `${pieces.join(' ')}. Perfect for artists looking to ride a memorable groove with character.`;
  };
  const anthropic = getAnthropic();
  if (!anthropic) return res.json({ success: true, source: 'fallback', description: templateFallback() });
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 220,
      messages: [{
        role: 'user',
        content: `Write exactly 2 short sentences (max 30 words total) selling a beat:
- Title: ${title || 'untitled'}
- Genre: ${genre || 'hip hop'}${subgenre ? ` / ${subgenre}` : ''}
- Mood: ${mood || 'versatile'}
- BPM: ${bpm || 'unknown'}
- Key: ${beatKey || 'unknown'}
Tone: confident, evocative, concrete imagery. Avoid clichés ("fire", "hard-hitting"). Output ONLY the description — no preamble, no quotes.`,
      }],
    });
    const text = (msg.content?.[0]?.text || '').trim().replace(/^"|"$/g, '');
    if (text && text.length > 20 && text.length < 400) {
      return res.json({ success: true, source: 'claude', description: text });
    }
    res.json({ success: true, source: 'fallback', description: templateFallback() });
  } catch (err) {
    console.warn('generate-description failed:', err.message);
    res.json({ success: true, source: 'fallback', description: templateFallback(), error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// STRIPE CHECKOUT
// ──────────────────────────────────────────────────────────────────────────────

// POST /checkout — create a Stripe checkout session for the cart items.
// Body: { customerEmail, cartItems: [{ beatId, beatTitle, licenseType, price }] }
// Returns: { url } — Stripe hosted checkout URL to redirect the customer to.
app.post('/checkout', async (req, res) => {
  try {
    const { customerEmail, cartItems, bundleId } = req.body;

    if (!customerEmail || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: 'customerEmail and cartItems required' });
    }

    // Validate prices server-side by re-fetching from the DB (never trust client prices).
    const allBeats = await fetchBeatsFromDB();
    const beatById = new Map(allBeats.map(b => [b.id, b]));

    // ── Bundle resolution ──────────────────────────────────────────────────
    // When a bundleId is passed, the cart's items must all match the bundle's
    // license_type AND the count must equal bundle.qty. We then charge the
    // bundle price as a SINGLE Stripe line item ("OB Beats — 3-Lease Bundle:
    // Beat A, Beat B, Beat C") and store the per-beat resolution in the order
    // so the existing webhook fulfillment delivers each beat individually —
    // no fulfillment changes needed.
    let bundle = null;
    if (bundleId) {
      try {
        const supabase = getSupabaseClient();
        const { data: row, error: bErr } = await supabase
          .from('bundles').select('*').eq('id', bundleId).eq('active', true).maybeSingle();
        if (bErr) throw bErr;
        if (!row) return res.status(400).json({ error: 'Bundle not found or inactive' });
        if (cartItems.length !== row.qty) {
          return res.status(400).json({ error: `Bundle requires exactly ${row.qty} beats (got ${cartItems.length})` });
        }
        for (const it of cartItems) {
          if (it.licenseType !== row.license_type) {
            return res.status(400).json({ error: `Bundle requires all beats at ${row.license_type} tier` });
          }
        }
        bundle = row;
      } catch (e) {
        console.error('bundle lookup failed:', e.message);
        return res.status(400).json({ error: 'Bundle not available right now' });
      }
    }

    const validatedItems = [];
    for (const item of cartItems) {
      const beat = beatById.get(item.beatId);
      if (!beat) {
        return res.status(400).json({ error: `Beat ${item.beatId} not found or inactive` });
      }
      const priceKey =
        item.licenseType === 'exclusive' ? 'exclusive_price' :
        item.licenseType === 'premium' ? 'premium_price' :
        item.licenseType === 'stems'   ? 'stems_price'   :
                                         'lease_price';
      const serverPrice = parseFloat(beat[priceKey]);
      if (!serverPrice || isNaN(serverPrice) || serverPrice <= 0) {
        return res.status(400).json({ error: `Invalid price for ${beat.title} (${item.licenseType})` });
      }
      validatedItems.push({
        beatId: beat.id,
        beatTitle: beat.title,
        licenseType: item.licenseType,
        // Per-beat price keeps internal accounting honest even when the bundle
        // overrides the customer-facing total.
        price: serverPrice,
        coverUrl: beat.cover_url || beat.cover_art_url || '',
      });
    }

    const itemsTotal = validatedItems.reduce((sum, it) => sum + it.price, 0);
    const totalAmount = bundle ? Number(bundle.price) : itemsTotal;
    const orderId = uuidv4();

    // Create pending order in Supabase. cartItems retains per-beat data so
    // fulfillOrder can mark each download URL on the corresponding row.
    await createOrder({
      orderId,
      customerEmail,
      cartItems: validatedItems,
      totalAmount,
    });

    // Build Stripe line items — one custom item for bundles, otherwise one
    // line per cart entry.
    let line_items;
    if (bundle) {
      const titles = validatedItems.map(it => it.beatTitle).join(', ');
      line_items = [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `O'Neil Beats — ${bundle.label}`,
            description: `${bundle.qty} ${bundle.license_type} beats: ${titles}`,
            images: validatedItems[0].coverUrl ? [validatedItems[0].coverUrl] : undefined,
          },
          unit_amount: Math.round(Number(bundle.price) * 100),
        },
        quantity: 1,
      }];
    } else {
      line_items = validatedItems.map(item => {
        const tierLabel =
          item.licenseType === 'exclusive' ? 'Exclusive Rights (Full Buyout)' :
          item.licenseType === 'premium' ? 'Premium License (MP3 + WAV)' :
          item.licenseType === 'stems'   ? 'Stems License (MP3 + WAV + Track Stems)' :
                                           'Lease License (MP3)';
        return {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${item.beatTitle} — ${tierLabel}`,
              description: `Prod. O'Neil — ${tierLabel}`,
              images: item.coverUrl ? [item.coverUrl] : undefined,
            },
            unit_amount: Math.round(item.price * 100), // cents
          },
          quantity: 1,
        };
      });
    }

    const appUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      customer_email: customerEmail,
      client_reference_id: orderId,
      metadata: bundle ? { orderId, bundleId: bundle.id, bundleLabel: bundle.label } : { orderId },
      success_url: `${appUrl}/success?orderId=${orderId}&value=${totalAmount}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/cancel?orderId=${orderId}`,
      payment_intent_data: {
        metadata: bundle ? { orderId, bundleId: bundle.id } : { orderId },
        description: bundle
          ? `O'Neil Beats — ${bundle.label} (Order #${orderId.slice(0, 8)})`
          : `O'Neil Beats Order #${orderId.slice(0, 8)}`,
      },
      // Bundles already represent a discount; promo codes on top would
      // double-discount, so disable for bundle orders.
      allow_promotion_codes: !bundle,
    });

    return res.json({ url: session.url, sessionId: session.id, orderId });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: err.message || 'Checkout failed' });
  }
});

// GET /success — simple success landing page after Stripe redirects back.
// Fires the Meta Pixel Purchase event (for ROAS / conversion optimization)
// when META_PIXEL_ID env is set. The value comes from the success_url query
// param set at checkout. Dormant if the env var is unset.
app.get('/success', (req, res) => {
  const orderId = req.query.orderId || '';
  const value = parseFloat(req.query.value) || 0;
  // Defaults to the live dataset ID; override via META_PIXEL_ID env if it changes.
  const pixelId = process.env.META_PIXEL_ID || '1845591916107254';
  const pixelOk = /^\d{10,20}$/.test(pixelId);
  const pixelSnippet = pixelOk ? `<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(
window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', ${JSON.stringify(pixelId)});
fbq('track', 'PageView');
fbq('track', 'Purchase', { value: ${value}, currency: 'USD', content_type: 'product'${orderId ? `, content_ids: [${JSON.stringify(orderId)}]` : ''} });
</script>` : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Successful — O'Neil Beats</title>${pixelSnippet}</head>
<body style="background:#06060a;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:40px 20px;text-align:center;">
<div style="max-width:520px;margin:40px auto;background:#0f0f14;border:1px solid #222;border-radius:20px;padding:36px 24px;">
<div style="font-size:56px;margin-bottom:8px;">🎵</div>
<h1 style="color:#e63946;margin:0 0 8px;">Payment Successful!</h1>
<p style="color:#888;margin:8px 0 20px;font-size:14px;">Order #${orderId.slice(0,8)}</p>
<p style="line-height:1.5;">Thanks for your purchase! Your download links and PDF license have been emailed to you.</p>
<p style="color:#888;font-size:13px;margin-top:20px;">You can close this tab and return to the app.</p>
</div></body></html>`);
});

// GET /cancel — simple cancel landing page
app.get('/cancel', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Canceled</title></head>
<body style="background:#06060a;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:40px 20px;text-align:center;">
<div style="max-width:520px;margin:40px auto;background:#0f0f14;border:1px solid #222;border-radius:20px;padding:36px 24px;">
<h1 style="color:#f59e0b;margin:0 0 8px;">Payment Canceled</h1>
<p style="line-height:1.5;">Your cart is still saved. You can return to the app and try again.</p>
</div></body></html>`);
});

// ──────────────────────────────────────────────────────────────────────────────
// PURCHASES & ORDERS
// ──────────────────────────────────────────────────────────────────────────────

// GET /purchases?email=... — get all paid orders for a customer
app.get('/purchases', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email query param required' });

    const orders = await getOrdersByEmail(email);
    const baseUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

    const enriched = orders.map(order => ({
      orderId: order.id,
      status: order.status,
      customerEmail: order.customer_email,
      customerName: order.customer_name,
      totalAmount: order.total_amount,
      paidAt: order.paid_at,
      items: (order.order_items || []).map(item => {
        const downloads = {};
        downloads.mp3 = item.mp3_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=mp3` : null;
        if (item.license_type === 'premium' || item.license_type === 'stems') {
          downloads.wav = item.wav_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=wav` : null;
        }
        if (item.license_type === 'stems') {
          downloads.stems = item.stems_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=stems` : null;
        }
        return {
          beatId: item.beat_id,
          beatTitle: item.beat_title,
          licenseType: item.license_type,
          price: item.price,
          coverUrl: item.cover_url,
          downloads,
          licenseUrl: `${baseUrl}/license/${order.id}/${item.beat_id}`,
        };
      }),
    }));

    res.json({ success: true, purchases: enriched });
  } catch (err) {
    console.error('Fetch purchases error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /orders/lookup — public order history lookup by email (used by storefront)
app.get('/orders/lookup', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email query param required' });

    const orders = await getOrdersByEmail(email);
    const baseUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

    const result = orders.map(order => ({
      orderId: order.id,
      status: order.status,
      paidAt: order.paid_at,
      totalAmount: order.total_amount,
      items: (order.order_items || []).map(item => ({
        beatTitle: item.beat_title,
        licenseType: item.license_type,
        price: item.price,
        coverUrl: item.cover_url,
        downloadUrl: item.mp3_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=mp3` : null,
        licenseUrl: `${baseUrl}/license/${order.id}/${item.beat_id}`,
      })),
    }));

    res.json({ success: true, orders: result });
  } catch (err) {
    console.error('Order lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// FILE DOWNLOADS & LICENSE
// ──────────────────────────────────────────────────────────────────────────────

// GET /preview/:id — stream MP3 preview (proxies Drive/Supabase through backend
// so the <audio> tag gets a real audio/mpeg stream with proper CORS)
// GET /beat/:id — public share landing page with Open Graph + JSON-LD.
// Shared links from the app (iOS + Android share sheet → /beat/{uuid}) land
// here so WhatsApp / iMessage / Twitter / Discord / LinkedIn / Facebook all
// render rich previews with the beat cover, title, genre + BPM, and a $price.
//
// 2026-05-06 — Producer reported: "When I share a beat, it shows weblink but
// no name of the beat." Diagnosis: GET /beat/:slug above was matching UUID
// share URLs, failing to resolve them as slugs, then 302-redirecting to /.
// Scrapers followed the redirect and saw the homepage's <head>, so the unfurl
// rendered with no beat-specific tags. Fixed the slug handler with a UUID
// guard (line ~232). This route now ALSO ships:
//   • Sanitized cover_url (defensive trim — guards against the GCS_BUCKET
//     trailing-newline bug that produced URLs like ".../oneilbeats-media\n/...")
//   • JSON-LD MusicRecording + Product schema with offers (so Google can show
//     ⭐ + price in search results once we accumulate reviews)
//   • <link rel="canonical"> pointing at the slug URL when available (better
//     SEO consolidation; the slug page is the indexed canonical)
//   • og:audio so iMessage / Discord can show a play button
//   • Real prices in the visible price row (was hard-coded "FROM $30")
app.get('/beat/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const beats = await fetchBeatsFromDB();
    const b = beats.find(x => x.id === id);
    if (!b) {
      res.status(404).set('Content-Type', 'text/html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Beat not found</title></head><body style="background:#06060a;color:#fff;font-family:sans-serif;padding:40px;text-align:center"><h1>Beat not found</h1><p><a href="/" style="color:#d4af37">Browse all beats</a></p></body></html>`);
      return;
    }
    // Defensive URL sanitization. The GCS_BUCKET env-var bug (PR #23) wrote
    // some cover_urls with embedded \n. Trim every URL we serve so a single
    // dirty row can't break Open Graph image rendering.
    const _cleanUrl = (u) => {
      if (!u || typeof u !== 'string') return null;
      const c = u.replace(/[\s\r\n\t]+/g, '').trim();
      return c || null;
    };
    const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

    const titleRaw = b.title || 'Untitled Beat';
    const title = esc(titleRaw);
    const genreRaw = b.genre || '';
    const genre = esc(genreRaw);
    const subgenre = b.subgenre || '';
    const bpmStr = b.bpm ? `${b.bpm} BPM` : '';
    const keyStr = b.key || '';
    const moodRaw = b.mood || '';
    const mood = esc(moodRaw);
    const cover = _cleanUrl(b.cover_art_url || b.artwork_url || b.cover_url) || `${req.protocol}://${req.get('host')}/icon.png`;
    const audioUrl = _cleanUrl(b.audio_url || b.mp3_url);
    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}`;
    const desc = `${genreRaw}${bpmStr ? ' · ' + bpmStr : ''}${keyStr ? ' · ' + keyStr : ''}${moodRaw ? ' · ' + moodRaw : ''} — Stream, license & download on O'Neil Beats.`.trim();
    const pageUrl = `${req.protocol}://${req.get('host')}/beat/${id}`;

    // Try to compute the slug-based canonical URL so Google consolidates the
    // UUID share link with the indexed slug page. If the slug helper isn't
    // available (e.g. build script not present), fall back to the UUID URL.
    let canonicalUrl = pageUrl;
    try {
      const { beatSlug } = require('./scripts/build-beat-pages');
      if (typeof beatSlug === 'function' && b.title) {
        canonicalUrl = `${req.protocol}://${req.get('host')}/beat/${beatSlug(b)}`;
      }
    } catch (_) { /* no-op */ }

    // Pricing — surface real values, not hard-coded $30. Falls back gracefully.
    const lease = b.lease_price || b.mp3_price || 30;
    const premium = b.premium_price || null;
    const stems = b.stems_price || null;
    const exclusive = b.exclusive_price || null;
    const tiers = [
      lease ? { name: 'MP3 Lease', price: lease } : null,
      premium ? { name: 'Premium (MP3+WAV)', price: premium } : null,
      stems ? { name: 'Stems / Track Out', price: stems } : null,
      exclusive ? { name: 'Exclusive', price: exclusive } : null,
    ].filter(Boolean);

    // JSON-LD: MusicRecording + Product offers. Mirrors build-beat-pages.js
    // (the static SEO pages) so the rich-preview surface is identical no
    // matter which URL form a fan shares.
    const offers = tiers.map(t => ({
      '@type': 'Offer',
      name: t.name,
      price: String(t.price),
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: pageUrl,
    }));
    const ldNode = {
      '@context': 'https://schema.org',
      '@type': 'MusicRecording',
      name: titleRaw,
      url: canonicalUrl,
      image: cover,
      description: desc,
      sku: id,
      genre: genreRaw || undefined,
      inAlbum: subgenre ? { '@type': 'MusicAlbum', name: subgenre, byArtist: { '@type': 'MusicGroup', name: "O'Neil" } } : undefined,
      byArtist: { '@type': 'MusicGroup', name: "O'Neil", url: `${req.protocol}://${req.get('host')}/` },
      brand: { '@type': 'Brand', name: "O'Neil Beats" },
      offers: offers.length ? offers : undefined,
      audio: audioUrl ? { '@type': 'AudioObject', contentUrl: audioUrl, encodingFormat: 'audio/mpeg' } : undefined,
      keywords: Array.isArray(b.tags) ? b.tags.join(', ') : (b.tags || undefined),
    };
    const ldBreadcrumb = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${req.protocol}://${req.get('host')}/` },
        { '@type': 'ListItem', position: 2, name: 'Beats', item: `${req.protocol}://${req.get('host')}/#catalog` },
        { '@type': 'ListItem', position: 3, name: titleRaw, item: pageUrl },
      ],
    };
    const jsonLd = JSON.stringify(ldNode) + '\n' + JSON.stringify(ldBreadcrumb);

    // Cache: 60s public, 600s edge. Balances freshness (price/cover edits
    // propagate in 1 min) with scraper-friendly response times. WA / iMessage
    // re-scrape on demand and don't honor private cache anyway.
    res.set('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — ${genre || 'Type Beat'}${bpmStr ? ' ' + bpmStr : ''} | Prod. by O'Neil</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonicalUrl)}">

<!-- Open Graph (Facebook, WhatsApp, iMessage, LinkedIn, Discord) -->
<meta property="og:type" content="music.song">
<meta property="og:title" content="${title} — ${genre || 'Type Beat'}${bpmStr ? ' ' + bpmStr : ''}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(cover)}">
<meta property="og:image:secure_url" content="${esc(cover)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="1200">
<meta property="og:image:alt" content="${title} cover art">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:site_name" content="O'Neil Beats">
<meta property="og:locale" content="en_US">
${process.env.FB_APP_ID ? `<meta property="fb:app_id" content="${esc(process.env.FB_APP_ID)}">` : ''}
${audioUrl ? `<meta property="og:audio" content="${esc(previewUrl)}">
<meta property="og:audio:type" content="audio/mpeg">
<meta property="music:musician" content="${esc(req.protocol + '://' + req.get('host') + '/')}">
${b.bpm ? `<meta property="music:duration" content="${b.duration ? Math.round(Number(b.duration)) : ''}">` : ''}` : ''}

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@oneilbeats">
<meta name="twitter:title" content="${title} — ${genre || 'Type Beat'}${bpmStr ? ' ' + bpmStr : ''}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(cover)}">
<meta name="twitter:image:alt" content="${title} cover art">

<!-- App-link metadata (lets iMessage / Twitter offer "Open in app") -->
<meta property="al:ios:url" content="oneilbeats://beat/${id}">
<meta property="al:ios:app_store_id" content="6763227699">
<meta property="al:ios:app_name" content="OB Beats">
<meta property="al:android:url" content="oneilbeats://beat/${id}">
<meta property="al:android:package" content="com.oneilbeats.app">
<meta property="al:android:app_name" content="OB Beats">
<meta property="al:web:url" content="${esc(pageUrl)}">

<script type="application/ld+json">${jsonLd}</script>

<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #06060a; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; }
  .wrap { max-width: 600px; margin: 0 auto; padding: 32px 20px 80px; }
  .brand { color: #d4af37; font-size: 14px; letter-spacing: 6px; font-weight: 800; text-align: center; margin-bottom: 24px; }
  .cover { width: 100%; aspect-ratio: 1; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 60px rgba(212,175,55,.25); background: linear-gradient(135deg,#2a1a40,#6b1a3a); }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .title { font-size: 32px; font-weight: 900; margin-top: 24px; line-height: 1.1; }
  .meta { color: #c8c8d0; font-size: 16px; margin-top: 10px; }
  .audio { margin-top: 20px; width: 100%; }
  .audio audio { width: 100%; }
  .price-row { display: flex; align-items: center; justify-content: space-between; margin-top: 28px; padding: 18px 22px; background: linear-gradient(135deg, rgba(212,175,55,.12) 0%, rgba(230,57,70,.12) 100%); border: 1px solid rgba(212,175,55,.4); border-radius: 16px; }
  .price-row .label { color: #d4af37; font-size: 13px; letter-spacing: 2px; font-weight: 700; }
  .price-row .price { font-size: 28px; font-weight: 900; }
  .tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 12px; }
  .tier { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 10px 12px; text-align: center; }
  .tier .name { color: #c8c8d0; font-size: 11px; letter-spacing: 1px; font-weight: 700; }
  .tier .p { color: #fff; font-size: 18px; font-weight: 800; margin-top: 2px; }
  .cta { display: block; margin-top: 28px; padding: 18px; background: linear-gradient(135deg, #d4af37 0%, #e63946 100%); color: #000; text-align: center; font-weight: 900; font-size: 17px; letter-spacing: 1px; border-radius: 14px; text-decoration: none; }
  .cta:hover { opacity: .9; }
  .secondary { display: block; margin-top: 12px; padding: 14px; background: rgba(255,255,255,.05); color: #fff; text-align: center; font-weight: 600; border-radius: 14px; text-decoration: none; border: 1px solid rgba(255,255,255,.12); }
  .footer { text-align: center; margin-top: 40px; color: #888; font-size: 12px; }
  .footer a { color: #d4af37; text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">O'NEIL BEATS</div>
  <div class="cover"><img src="${esc(cover)}" alt="${title} cover art"></div>
  <h1 class="title">${title}</h1>
  <div class="meta">${esc(genreRaw)}${bpmStr ? ' &middot; ' + bpmStr : ''}${keyStr ? ' &middot; ' + esc(keyStr) : ''}${moodRaw ? ' &middot; ' + mood : ''}</div>
  ${audioUrl ? `<div class="audio"><audio controls preload="none" src="${esc(previewUrl)}"></audio></div>` : ''}
  <div class="price-row">
    <div><div class="label">FROM</div><div class="price">$${lease}</div></div>
    <div><div class="label">LICENSE</div><div class="price" style="font-size:16px;color:#c8c8d0">MP3 · WAV · Stems · Exclusive</div></div>
  </div>
  ${tiers.length > 1 ? `<div class="tiers">${tiers.map(t => `<div class="tier"><div class="name">${esc(t.name)}</div><div class="p">$${t.price}</div></div>`).join('')}</div>` : ''}
  <a class="cta" href="oneilbeats://beat/${id}">Open in OB Beats App</a>
  <a class="secondary" href="/">Browse all beats</a>
  <div class="footer">Prod. by O'Neil &middot; <a href="/">oneilbeats.store</a></div>
</div>
</body>
</html>`);
  } catch (err) {
    console.error('Beat share page error:', err);
    res.status(500).send('Error rendering beat page');
  }
});

app.get('/preview/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const beats = await fetchBeatsFromDB();
    const b = beats.find(x => x.id === id);
    if (!b) return res.status(404).json({ error: 'Beat not found' });
    let url = b.audio_url || b.mp3_url;
    if (!url) return res.status(404).json({ error: 'No preview available' });

    // Normalize Drive links to the direct-download variant
    const driveMatch = url.match(/drive\.google\.com\/(?:uc\?.*?id=|file\/d\/)([^&/?]+)/);
    if (driveMatch) url = `https://drive.google.com/uc?export=download&confirm=1&id=${driveMatch[1]}`;

    const upstream = await fetch(url, {
      headers: req.headers.range ? { Range: req.headers.range } : {},
      redirect: 'follow',
    });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: `Upstream ${upstream.status}` });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const len = upstream.headers.get('content-length');
    const range = upstream.headers.get('content-range');
    if (len) res.setHeader('Content-Length', len);
    if (range) res.setHeader('Content-Range', range);
    if (upstream.status === 206) res.status(206);

    const reader = upstream.body.getReader();
    res.on('close', () => { try { reader.cancel(); } catch {} });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('Preview stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// GET /download/:orderId/:beatId — download beat files (mp3, wav, stems)
app.get('/download/:orderId/:beatId', async (req, res) => {
  try {
    const { orderId, beatId } = req.params;
    const format = req.query.format || 'mp3';

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const item = order.order_items?.find(i => i.beat_id === beatId);
    if (!item) return res.status(404).json({ error: 'Beat not found in order' });

    let downloadUrl = null;
    if (format === 'mp3') downloadUrl = item.mp3_url;
    else if (format === 'wav' && (item.license_type === 'premium' || item.license_type === 'stems')) downloadUrl = item.wav_url;
    else if (format === 'stems' && item.license_type === 'stems') downloadUrl = item.stems_url;

    if (!downloadUrl) {
      return res.status(400).json({ error: `${format.toUpperCase()} not available for this license type` });
    }

    res.redirect(downloadUrl);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /license/:orderId/:beatId — generate and return license PDF
app.get('/license/:orderId/:beatId', async (req, res) => {
  try {
    const { orderId, beatId } = req.params;

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const item = order.order_items?.find(i => i.beat_id === beatId);
    if (!item) return res.status(404).json({ error: 'Beat not found in order' });

    const pdfBuffer = await generateLicensePDF({
      beatTitle: item.beat_title,
      licenseType: item.license_type,
      customerName: order.customer_name || 'Customer',
      customerEmail: order.customer_email,
      orderDate: new Date(order.paid_at).toLocaleDateString(),
      licenseTerms: LICENSE_TERMS[item.license_type] || LICENSE_TERMS.lease,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${item.beat_title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_license.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('License PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ──────────────────────────────────────────────────────────────────────────────

// POST /notification/register-token
app.post('/notification/register-token', async (req, res) => {
  try {
    const { userId, pushToken, platform } = req.body;
    if (!userId || !pushToken) {
      return res.status(400).json({ error: 'userId and pushToken required' });
    }

    const result = await registerPushToken(userId, pushToken, platform || 'mobile');
    res.json(result);
  } catch (err) {
    console.error('Register push token error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /notification/unregister-token
app.post('/notification/unregister-token', async (req, res) => {
  try {
    const { pushToken } = req.body;
    if (!pushToken) return res.status(400).json({ error: 'pushToken required' });

    const result = await removePushToken(pushToken);
    res.json(result);
  } catch (err) {
    console.error('Unregister push token error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /notification/send
app.post('/notification/send', requireAdminKey, async (req, res) => {
  try {
    const { title, body, data } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body required' });
    }

    const tokens = await getPushTokens();
    if (tokens.length === 0) {
      return res.json({ success: true, message: 'No active tokens to notify', sentCount: 0 });
    }

    const result = await sendPushNotification(tokens, title, body, data);
    res.json({ success: true, message: 'Notifications sent', sentCount: tokens.length, result });
  } catch (err) {
    console.error('Send notifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/blast-by-mood — targeted push notification.
// Body: { title, body, data?, mood?, genre?, subgenre?, dryRun? }
// OR-semantics across the three filters; users get included if ANY filter
// matches their past purchase history. dryRun:true returns the audience
// preview without sending.
app.post('/admin/blast-by-mood', requireAdminKey, async (req, res) => {
  try {
    const { title, body, data, mood, genre, subgenre, dryRun } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });
    if (!mood && !genre && !subgenre) {
      return res.status(400).json({ error: 'at least one of mood/genre/subgenre required' });
    }

    // 1. Find beats matching filters (OR across mood/genre/subgenre).
    const orParts = [];
    const orParams = [];
    if (mood)     { orParams.push(mood);     orParts.push(`mood = $${orParams.length}`); }
    if (genre)    { orParams.push(genre);    orParts.push(`genre = $${orParams.length}`); }
    if (subgenre) { orParams.push(subgenre); orParts.push(`subgenre = $${orParams.length}`); }
    const beatSql = `SELECT id FROM beats WHERE active = true AND (${orParts.join(' OR ')})`;
    const { rows: matchingBeats } = await pgQuery(beatSql, orParams);
    const beatIds = matchingBeats.map(b => b.id);
    if (beatIds.length === 0) {
      return res.json({ success: true, message: 'No beats match those filters', sentCount: 0 });
    }

    // 2. Find emails of customers who bought any of those beats.
    const { rows: items } = await pgQuery(
      `SELECT oi.beat_id, o.customer_email, o.status
         FROM order_items oi
         JOIN orders o ON o.id::text = oi.order_id::text
        WHERE oi.beat_id = ANY($1::uuid[])`,
      [beatIds]
    );
    const emails = new Set();
    for (const it of items) {
      if (it.status === 'paid' && it.customer_email) {
        emails.add(it.customer_email.toLowerCase());
      }
    }
    if (emails.size === 0) {
      return res.json({ success: true, message: 'No buyers match those filters', sentCount: 0, matchedBeats: beatIds.length });
    }

    // 3. Look up active push tokens for those buyers (active = last_seen within 30d).
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { rows: tokenRows } = await pgQuery(
      `SELECT token, user_id FROM push_tokens
        WHERE user_id = ANY($1::text[]) AND last_seen > $2`,
      [Array.from(emails), cutoff]
    );
    const tokens = tokenRows.map(r => r.token);
    if (tokens.length === 0) {
      return res.json({
        success: true,
        message: 'Matched buyers have no active push tokens',
        sentCount: 0,
        matchedBeats: beatIds.length,
        matchedEmails: emails.size,
      });
    }

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        wouldSendTo: tokens.length,
        matchedBeats: beatIds.length,
        matchedEmails: emails.size,
      });
    }

    const result = await sendPushNotification(tokens, title, body, data || {});
    res.json({
      success: true,
      message: 'Targeted blast sent',
      sentCount: tokens.length,
      matchedBeats: beatIds.length,
      matchedEmails: emails.size,
      result,
    });
  } catch (err) {
    console.error('blast-by-mood error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// FREE BEAT OF THE WEEK + EMAIL SUBSCRIBERS
// ──────────────────────────────────────────────────────────────────────────────
// Required Supabase tables (paste in SQL editor if not present):
//   create table if not exists email_subscribers (
//     id uuid primary key default gen_random_uuid(),
//     email text unique not null,
//     token text not null,
//     consent boolean not null default false,
//     source text default 'unknown',
//     created_at timestamptz default now(),
//     unsubscribed_at timestamptz
//   );
//   alter table beats add column if not exists is_free_weekly boolean default false;

// POST /subscribe/free-beat — public; { email, consent, source? }
// CAN-SPAM/GDPR: requires explicit consent=true. Returns { success, alreadySubscribed }.
app.post('/subscribe/free-beat', async (req, res) => {
  try {
    const { email, consent, source } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (consent !== true) {
      return res.status(400).json({ error: 'Marketing consent required' });
    }
    const supabase = getSupabaseClient();
    const token = require('crypto').randomBytes(24).toString('hex');
    let alreadySubscribed = false;
    try {
      const { data: existing } = await supabase.from('email_subscribers').select('id, unsubscribed_at').eq('email', email).maybeSingle();
      if (existing) {
        alreadySubscribed = !existing.unsubscribed_at;
        await supabase.from('email_subscribers').update({
          consent: true,
          source: source || 'unknown',
          unsubscribed_at: null,
        }).eq('email', email);
      } else {
        await supabase.from('email_subscribers').insert([{
          email, token, consent: true, source: source || 'unknown',
        }]);
      }
    } catch (dbErr) {
      console.warn('subscribe insert skipped:', dbErr.message);
    }
    res.json({ success: true, alreadySubscribed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /unsubscribe?email=...&token=... — one-click unsubscribe link from emails
app.get('/unsubscribe', async (req, res) => {
  try {
    const { email, token } = req.query;
    if (!email || !token) return res.status(400).send('Missing email or token');
    const supabase = getSupabaseClient();
    const { data: row } = await supabase.from('email_subscribers').select('id, token').eq('email', email).maybeSingle();
    if (!row || row.token !== token) return res.status(404).send('Subscription not found or token invalid');
    await supabase.from('email_subscribers').update({ unsubscribed_at: new Date().toISOString() }).eq('email', email);
    res.set('Content-Type', 'text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title><style>body{font-family:system-ui;background:#06060a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px}h1{color:#e63946}</style></head><body><div><h1>You're unsubscribed</h1><p>${email} will no longer receive Free Beat of the Week emails.</p><p style="color:#666;font-size:12px;margin-top:24px">Changed your mind? <a href="https://oneilbeats.store" style="color:#e63946">Resubscribe on the site.</a></p></div></body></html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Bundle pricing ─────────────────────────────────────────────────────────
// Producers configure bundle deals in the desktop EXE admin (Bundles tab).
// Storefront reads the active list via GET /bundles and shows a bundle CTA
// + picker; checkout flow detects bundleId and charges the bundle price as
// a single Stripe line item, with per-beat fulfillment unchanged.

// GET /bundles — public; returns active bundles ordered by sort_order
app.get('/bundles', async (req, res) => {
  try {
    const { rows } = await pgQuery(
      `SELECT id, label, license_type, qty, price, savings_label, description, sort_order
         FROM bundles
        WHERE active = true
        ORDER BY sort_order ASC NULLS LAST`
    );
    res.set('Cache-Control', 'public, max-age=120, s-maxage=300');
    res.json({ success: true, bundles: rows });
  } catch (err) {
    // Table may not exist yet on first deploy — return empty cleanly so
    // the storefront just hides the bundles section.
    res.json({ success: true, bundles: [], error: err.message });
  }
});

// ═══════════════ DRUM KITS ═══════════════
// Sellable sample packs extracted from beats. Files (ZIP + cover) live on GCS;
// metadata in the drum_kits table. The desktop EXE builds a kit locally (Demucs/
// stems → slice → MIDI → zip) then POSTs it to /admin/kits/publish so storage +
// DB stay on the working GCS + direct-Postgres path (Supabase REST is blocked).

// GET /kits — public; active kits for the storefront /kits page.
app.get('/kits', async (req, res) => {
  try {
    const { rows } = await pgQuery(
      `SELECT id, beat_id, title, genre, bpm, cover_url, kit_url, price, sample_count, has_midi, created_at
         FROM drum_kits WHERE active = true ORDER BY created_at DESC`
    );
    res.set('Cache-Control', 'public, max-age=120, s-maxage=300');
    res.json({ success: true, kits: rows });
  } catch (err) {
    // Table may not exist yet on first deploy — fail soft so the page hides it.
    res.json({ success: true, kits: [], error: err.message });
  }
});

// GET /admin/kits — admin; ALL kits (active + inactive).
app.get('/admin/kits', requireAdminKey, async (req, res) => {
  try {
    const { rows } = await pgQuery('SELECT * FROM drum_kits ORDER BY created_at DESC');
    res.json({ success: true, kits: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/kits/publish — admin; multipart { kit: <zip>, cover?: <png> } plus
// metadata fields. Called by the desktop EXE after it builds the kit locally.
app.post('/admin/kits/publish', requireAdminKey,
  upload.fields([{ name: 'kit', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
  async (req, res) => {
    try {
      const kitFile = req.files?.kit?.[0];
      if (!kitFile) return res.status(400).json({ error: 'kit (zip) file required' });
      const b = req.body || {};
      // Text fields arrive URL-encoded (the EXE encodes them so multipart/busboy
      // doesn't mangle accents/em-dashes into latin1 mojibake).
      const dec = (v) => { try { return decodeURIComponent(v || ''); } catch (_) { return v || ''; } };
      const title = dec(b.title);
      const genre = dec(b.genre);
      if (!title) return res.status(400).json({ error: 'title required' });

      const seed = Date.now();
      const safe = String(title).replace(/[^\w\-]+/g, '_').slice(0, 60) || 'DrumKit';
      const kitUrl = await uploadFileToStorage(kitFile.buffer, `kits/${safe}_${seed}.zip`, 'beats', 'application/zip');

      let coverUrl = b.cover_url || null;
      const coverFile = req.files?.cover?.[0];
      if (coverFile) coverUrl = await uploadCoverToStorage(coverFile.buffer, `kit_cover_${seed}.png`, 'image/png');

      const { rows } = await pgQuery(
        `INSERT INTO drum_kits (beat_id, title, genre, bpm, cover_url, kit_url, price, sample_count, has_midi, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [b.beat_id || null, title, genre || null, b.bpm ? parseInt(b.bpm, 10) : null,
         coverUrl, kitUrl, b.price ? parseFloat(b.price) : 9.99,
         b.sample_count ? parseInt(b.sample_count, 10) : 0,
         String(b.has_midi) === 'false' ? false : true,
         String(b.active) === 'true']
      );
      res.json({ success: true, kit: rows[0] });
    } catch (err) {
      console.error('kit publish error:', err);
      res.status(500).json({ error: err.message });
    }
  });

// PATCH /admin/kits/:id — admin; toggle active / change price / rename.
app.patch('/admin/kits/:id', requireAdminKey, async (req, res) => {
  try {
    const sets = [], vals = []; let i = 1;
    if (req.body.active != null) { sets.push(`active=$${i++}`); vals.push(!!req.body.active); }
    if (req.body.price != null && req.body.price !== '') { sets.push(`price=$${i++}`); vals.push(parseFloat(req.body.price)); }
    if (req.body.title) { sets.push(`title=$${i++}`); vals.push(String(req.body.title)); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=now()');
    vals.push(req.params.id);
    const { rows } = await pgQuery(`UPDATE drum_kits SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    res.json({ success: true, kit: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /admin/kits/:id — admin.
app.delete('/admin/kits/:id', requireAdminKey, async (req, res) => {
  try {
    await pgQuery('DELETE FROM drum_kits WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /checkout-kit — public; single-kit Stripe Checkout. Isolated from the
// beat /checkout flow: price is validated server-side from drum_kits and the
// kit is delivered by the webhook's metadata.type==='kit' branch.
app.post('/checkout-kit', async (req, res) => {
  try {
    const { kitId, email } = req.body || {};
    if (!kitId || !email) return res.status(400).json({ error: 'kitId and email required' });
    const { rows } = await pgQuery('SELECT * FROM drum_kits WHERE id=$1 AND active=true', [kitId]);
    const kit = rows[0];
    if (!kit) return res.status(404).json({ error: 'Kit not available' });
    const price = Number(kit.price);
    if (!price || isNaN(price) || price <= 0) return res.status(400).json({ error: 'Invalid kit price' });

    const origin = req.headers.origin || process.env.APP_URL || 'https://oneilbeats.store';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: kit.title,
            description: `${kit.sample_count} one-shots${kit.has_midi ? ' + MIDI' : ''}${kit.genre ? ' — ' + kit.genre : ''} drum kit`,
            images: kit.cover_url ? [kit.cover_url] : undefined,
          },
          unit_amount: Math.round(price * 100),
        },
        quantity: 1,
      }],
      metadata: { type: 'kit', kitId: kit.id, kitTitle: kit.title },
      success_url: `${origin}/drum-kits?purchased=1`,
      cancel_url: `${origin}/drum-kits`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout-kit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/bundles — admin; returns ALL bundles (active + inactive)
app.get('/admin/bundles', requireAdminKey, async (req, res) => {
  try {
    const { rows } = await pgQuery(
      'SELECT * FROM bundles ORDER BY sort_order ASC NULLS LAST'
    );
    res.json({ success: true, bundles: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/bundles — admin; create OR update a bundle.
//   body: { id?, label, license_type, qty, price, savings_label?, description?, active?, sort_order? }
//   id present → update existing row, else create.
app.post('/admin/bundles', requireAdminKey, async (req, res) => {
  try {
    const b = req.body || {};
    const valid = ['lease', 'premium', 'stems'].includes(b.license_type) &&
      Number.isInteger(Number(b.qty)) && Number(b.qty) >= 2 && Number(b.qty) <= 20 &&
      Number(b.price) > 0 && typeof b.label === 'string' && b.label.trim().length > 0;
    if (!valid) return res.status(400).json({ error: 'label, license_type (lease|premium|stems), qty (2-20), price required' });
    const label = b.label.trim();
    const licenseType = b.license_type;
    const qty = Number(b.qty);
    const price = Number(b.price);
    const savingsLabel = b.savings_label || null;
    const description = b.description || null;
    const active = b.active !== false;
    const sortOrder = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 0;

    let row;
    if (b.id) {
      const { rows } = await pgQuery(
        `UPDATE bundles
            SET label = $1, license_type = $2, qty = $3, price = $4,
                savings_label = $5, description = $6, active = $7, sort_order = $8,
                updated_at = now()
          WHERE id = $9
          RETURNING *`,
        [label, licenseType, qty, price, savingsLabel, description, active, sortOrder, b.id]
      );
      row = rows[0] || null;
    } else {
      const { rows } = await pgQuery(
        `INSERT INTO bundles (label, license_type, qty, price, savings_label, description, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [label, licenseType, qty, price, savingsLabel, description, active, sortOrder]
      );
      row = rows[0] || null;
    }
    res.json({ success: true, bundle: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/bundles/:id — admin; removes a bundle row entirely.
app.delete('/admin/bundles/:id', requireAdminKey, async (req, res) => {
  try {
    await pgQuery('DELETE FROM bundles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /featured-free — public; returns the currently featured free beat (or null)
// Direct Postgres (pgQuery) — Supabase PostgREST is quota-blocked.
app.get('/featured-free', async (req, res) => {
  try {
    const { rows } = await pgQuery('SELECT * FROM beats WHERE is_free_weekly = true LIMIT 1');
    const beat = rows[0] || null;
    res.set('Cache-Control', 'public, max-age=120');
    res.json({ success: true, beat });
  } catch (err) {
    res.json({ success: true, beat: null, error: err.message });
  }
});

// POST /admin/featured-free — admin; { beatId | null } sets one beat as featured (clears others)
app.post('/admin/featured-free', requireAdminKey, async (req, res) => {
  try {
    const { beatId } = req.body || {};
    // Clear the current featured beat, then set the new one (if any).
    await pgQuery('UPDATE beats SET is_free_weekly = false WHERE is_free_weekly = true');
    if (beatId) {
      await pgQuery('UPDATE beats SET is_free_weekly = true WHERE id = $1', [beatId]);
    }
    res.json({ success: true, beatId: beatId || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/send-free-beat — admin; emails the currently featured Free Beat to all active subscribers.
// CRITICAL: Always uses beat.audio_url (the TAGGED preview MP3) — never audio_original_url (clean premium).
// Free subscribers get the producer-tagged version so the clean audio stays paid-only.
app.post('/admin/send-free-beat', requireAdminKey, async (req, res) => {
  try {
    // Direct Postgres (pgQuery) — Supabase PostgREST is quota-blocked.
    // 1. Find the currently featured free beat
    const { rows: featured } = await pgQuery('SELECT * FROM beats WHERE is_free_weekly = true LIMIT 1');
    const beat = featured && featured[0];
    if (!beat) return res.status(400).json({ error: 'No beat is currently set as Free Beat of the Week. Set one first.' });
    // Tagged MP3 only — never the untagged original.
    const taggedUrl = beat.audio_url;
    if (!taggedUrl) return res.status(400).json({ error: 'Featured beat has no audio_url (tagged preview).' });

    // 2. Get all active subscribers
    const { rows: subs } = await pgQuery('SELECT email, token FROM email_subscribers WHERE unsubscribed_at IS NULL');
    const recipients = (subs || []).filter(s => s.email);
    if (recipients.length === 0) return res.status(400).json({ error: 'No active subscribers.' });

    // 3. Send each one an email (best-effort; collect failures)
    const subject = `🎁 Your Free Beat: ${beat.title}`;
    let sent = 0, failed = 0;
    for (const sub of recipients) {
      const unsubUrl = `${process.env.PUBLIC_BASE_URL || 'https://oneil-beats-backend.vercel.app'}/unsubscribe?email=${encodeURIComponent(sub.email)}&token=${sub.token}`;
      const html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;background:#06060a;color:#e2e8f0;padding:32px;border-radius:12px">
          <div style="text-align:center;margin-bottom:24px">
            <div style="color:#fbbf24;font-size:11px;font-weight:900;letter-spacing:2px">FREE BEAT OF THE WEEK</div>
            <h1 style="color:#fff;margin:8px 0 0;font-size:24px">${beat.title}</h1>
            <p style="color:#888;font-size:13px;margin-top:6px">${beat.genre || ''}${beat.bpm ? ' · ' + beat.bpm + ' BPM' : ''}${beat.key ? ' · ' + beat.key : ''}</p>
          </div>
          ${beat.cover_art_url ? `<img src="${beat.cover_art_url}" alt="cover" style="width:100%;max-width:400px;border-radius:12px;display:block;margin:0 auto 24px">` : ''}
          <div style="text-align:center;margin:24px 0">
            <a href="${taggedUrl}" style="display:inline-block;background:#e63946;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:900;font-size:14px;letter-spacing:0.5px">⬇ DOWNLOAD FREE BEAT</a>
          </div>
          <p style="color:#888;font-size:12px;text-align:center;line-height:1.6">
            This is the producer-tagged preview, free for non-commercial use.<br>
            Want the clean untagged version? <a href="https://oneilbeats.store" style="color:#e63946">Buy a license at oneilbeats.store</a>
          </p>
          <hr style="border:none;border-top:1px solid #222;margin:24px 0">
          <p style="color:#555;font-size:11px;text-align:center">
            You're receiving this because you signed up for Free Beat of the Week.<br>
            <a href="${unsubUrl}" style="color:#888">Unsubscribe</a>
          </p>
        </div>`;
      try {
        await mailer.sendMail({
          from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
          to: sub.email,
          subject,
          html,
        });
        sent++;
      } catch (e) {
        console.warn('send-free-beat to', sub.email, 'failed:', e.message);
        failed++;
      }
    }
    res.json({ success: true, sent, failed, total: recipients.length, beat: { id: beat.id, title: beat.title } });
  } catch (err) {
    console.error('send-free-beat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/subscribers — admin; subscriber stats
app.get('/admin/subscribers', requireAdminKey, async (req, res) => {
  try {
    // Direct Postgres (pgQuery) — Supabase PostgREST is quota-blocked.
    const { rows } = await pgQuery('SELECT email, consent, source, created_at, unsubscribed_at FROM email_subscribers ORDER BY created_at DESC LIMIT 500');
    const active = rows.filter(s => !s.unsubscribed_at);
    res.json({ success: true, total: rows.length, active: active.length, subscribers: rows });
  } catch (err) {
    res.json({ success: true, subscribers: [], error: err.message });
  }
});

// POST /referral/get-or-create — auto-creates a Stripe promotion code for the user's referral code.
// Idempotent: safe to call multiple times. Returns the same code derived from userId.
// Code formula MUST match the customer app: 'OB-' + last 6 alphanumeric chars of userId, uppercased.
app.post('/referral/get-or-create', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const code = 'OB-' + String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();

    // 1. If a Stripe promotion code with this exact code already exists, return it.
    const existing = await stripe.promotionCodes.list({ code, limit: 1 });
    if (existing.data.length > 0) {
      return res.json({ success: true, code, status: 'already_exists' });
    }

    // 2. Get or create the shared "Referral $10 off" coupon (one for all referrals).
    let coupon = null;
    const coupons = await stripe.coupons.list({ limit: 100 });
    coupon = coupons.data.find(c => c.metadata && c.metadata.purpose === 'referral_10_off');
    if (!coupon) {
      coupon = await stripe.coupons.create({
        amount_off: 1000, // $10
        currency: 'usd',
        duration: 'once',
        name: 'Referral $10 off',
        metadata: { purpose: 'referral_10_off' },
      });
    }

    // 3. Create the per-user promotion code, restricted to first-time customers, $20 minimum.
    const promo = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code,
      max_redemptions: 100,
      restrictions: {
        first_time_transaction: true,
        minimum_amount: 2000,
        minimum_amount_currency: 'usd',
      },
      metadata: { user_id: userId, type: 'referral' },
    });

    res.json({ success: true, code, status: 'created', promoId: promo.id });
  } catch (err) {
    console.error('Referral create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /account/delete — Apple-compliant account deletion.
// Requires the user's Supabase access_token (so the delete is authenticated by the user themselves).
// Order records are PRESERVED for tax/accounting compliance (per Privacy Policy section 6).
// Email subscriptions, push tokens, favorites, and the auth user itself are removed.
app.post('/account/delete', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

    const supabase = getSupabaseClient(); // service-role client
    // Verify the token and get the user it belongs to.
    const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });
    const user = userData.user;
    const uid = user.id;
    const email = (user.email || '').toLowerCase();

    // Best-effort deletes — don't fail the whole request if one table is missing.
    try { await supabase.from('push_tokens').delete().eq('user_id', uid); } catch (_) {}
    try { await supabase.from('push_tokens').delete().eq('email', email); } catch (_) {}
    try { await supabase.from('favorites').delete().eq('user_id', uid); } catch (_) {}
    try { await supabase.from('customer_events').delete().eq('user_id', uid); } catch (_) {}
    if (email) {
      try {
        await supabase.from('email_subscribers')
          .update({ unsubscribed_at: new Date().toISOString() })
          .eq('email', email);
      } catch (_) {}
    }
    try { await supabase.from('customers').delete().eq('id', uid); } catch (_) {}

    // Finally delete the auth user.
    const { error: delErr } = await supabase.auth.admin.deleteUser(uid);
    if (delErr) return res.status(500).json({ error: 'Account deletion failed: ' + delErr.message });

    res.json({ success: true, message: 'Account deleted. Order records retained for tax compliance.' });
  } catch (err) {
    console.error('Account delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─�
// ──────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK
// ──────────────────────────────────────────────────────────────────────────────

// POST /payment/sheet — native Stripe PaymentSheet flow (Apple Pay / Google Pay / cards)
// Returns ephemeralKey + paymentIntent + customer for @stripe/stripe-react-native PaymentSheet.
app.post('/payment/sheet', async (req, res) => {
  try {
    const { customerEmail, cartItems } = req.body;
    if (!customerEmail || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: 'customerEmail and cartItems required' });
    }

    // Server-side price validation (mirror /checkout)
    const allBeats = await fetchBeatsFromDB();
    const beatById = new Map(allBeats.map(b => [b.id, b]));
    const validatedItems = [];
    for (const item of cartItems) {
      const beat = beatById.get(item.beatId);
      if (!beat) return res.status(400).json({ error: `Beat ${item.beatId} not found or inactive` });
      const priceKey =
        item.licenseType === 'exclusive' ? 'exclusive_price' :
        item.licenseType === 'premium'   ? 'premium_price'   :
        item.licenseType === 'stems'     ? 'stems_price'     :
                                           'lease_price';
      const serverPrice = parseFloat(beat[priceKey]);
      if (!serverPrice || isNaN(serverPrice) || serverPrice <= 0) {
        return res.status(400).json({ error: `Invalid price for ${beat.title} (${item.licenseType})` });
      }
      validatedItems.push({
        beatId: beat.id,
        beatTitle: beat.title,
        licenseType: item.licenseType,
        price: serverPrice,
      });
    }
    const totalAmount = validatedItems.reduce((s, it) => s + it.price, 0);
    const orderId = uuidv4();

    await createOrder({ orderId, customerEmail, cartItems: validatedItems, totalAmount });

    // Find or create Stripe Customer for the email (required for ephemeralKey)
    let customer;
    const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
    customer = existing.data[0] || await stripe.customers.create({ email: customerEmail });

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2024-06-20' }
    );

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100),
      currency: 'usd',
      customer: customer.id,
      receipt_email: customerEmail,
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId,
        beatTitles: validatedItems.map(i => i.beatTitle).join(' | ').slice(0, 480),
      },
      description: `O'Neil Beats Order #${orderId.slice(0, 8)}`,
    });

    res.json({
      orderId,
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
      amount: totalAmount,
    });
  } catch (err) {
    console.error('Payment sheet error:', err);
    res.status(500).json({ error: err.message || 'Payment sheet setup failed' });
  }
});

// ─── Apple In-App Purchase (StoreKit 2) — receipt validation ────────────────
// 2026-05-06 v1.8.9 — endpoint that the iOS app POSTs to after Apple confirms
// a StoreKit purchase. We verify the receipt with Apple's verifyReceipt /
// App Store Server API, then create an order_item linking the IAP transaction
// → beat → user. Existing license/download infrastructure delivers from there.
//
// Request body: { receipt, productId, tier, beatId, transactionId,
//                 customerEmail, isRestore? }
// Response:     { success: true, orderId, downloadUrl, licensePdfUrl }
//
// Env required:
//   APPLE_SHARED_SECRET — App-Specific Shared Secret from ASC → Monetization
//                         → App-Specific Shared Secret. Used by the legacy
//                         verifyReceipt endpoint and StoreKit 1. New StoreKit
//                         2 transactions can be JWS-verified without it.
//
// Apple's verifyReceipt is technically deprecated in favor of the App Store
// Server API (JWT auth). We use verifyReceipt here for simplicity — Apple
// still maintains it. Migration to JWT-based verification is a follow-up.
const APPLE_VERIFY_PROD    = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_VERIFY_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';
const IAP_TIER_TO_PRICE = { lease: 29.99, premium: 99.99, stems: 199.99 };
const IAP_VALID_PRODUCT_IDS = new Set([
  'com.oneilbeats.app.license.lease',
  'com.oneilbeats.app.license.premium',
  'com.oneilbeats.app.license.stems',
]);

app.post('/iap/validate', async (req, res) => {
  try {
    const { receipt, productId, tier, beatId, transactionId, customerEmail, isRestore } = req.body || {};
    if (!receipt) return res.status(400).json({ error: 'Missing receipt' });
    if (!productId || !IAP_VALID_PRODUCT_IDS.has(productId)) {
      return res.status(400).json({ error: 'Unknown productId' });
    }
    if (!tier || !IAP_TIER_TO_PRICE[tier]) {
      return res.status(400).json({ error: 'Invalid tier' });
    }

    // Verify receipt with Apple. Try production first; on 21007 retry sandbox.
    const verifyOnce = async (url) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'receipt-data': receipt,
          'password': process.env.APPLE_SHARED_SECRET || '',
          'exclude-old-transactions': true,
        }),
      });
      return resp.json();
    };
    let verify = await verifyOnce(APPLE_VERIFY_PROD);
    if (verify?.status === 21007) verify = await verifyOnce(APPLE_VERIFY_SANDBOX);
    if (verify?.status !== 0) {
      console.warn('[IAP] Apple verifyReceipt failed:', verify?.status);
      return res.status(400).json({ error: `Apple receipt verification failed (status ${verify?.status})` });
    }

    // Look up the matching transaction in the receipt to confirm productId
    // matches what the client claimed. This prevents a malicious client from
    // claiming "stems" while paying for "lease".
    const inApp = verify?.receipt?.in_app || verify?.latest_receipt_info || [];
    const matched = inApp.find(t =>
      t.product_id === productId &&
      (!transactionId || t.transaction_id === transactionId || t.original_transaction_id === transactionId)
    );
    if (!matched) {
      return res.status(400).json({ error: 'Transaction not found in receipt' });
    }

    // Look up the beat to attach metadata (title, cover, audio).
    const supa = getSupabaseClient();
    let beat = null;
    if (beatId) {
      const { data } = await supa.from('beats').select('*').eq('id', beatId).single();
      beat = data;
    }

    // Create / upsert an order tied to the IAP transaction. Each IAP transaction
    // is a "single-item order" — one beat, one tier, one Apple receipt.
    const orderId = `iap_${matched.transaction_id || matched.original_transaction_id}`;
    const price = IAP_TIER_TO_PRICE[tier];

    // Check if this transaction already produced an order (idempotency).
    const { data: existingOrder } = await supa.from('orders').select('id, status').eq('id', orderId).maybeSingle();
    if (existingOrder && !isRestore) {
      // Already delivered. Re-return the download URLs without creating another order.
      const { data: items } = await supa.from('order_items').select('*').eq('order_id', orderId);
      return res.json({ success: true, orderId, alreadyDelivered: true, items: items || [] });
    }

    // New order
    if (!existingOrder) {
      await supa.from('orders').insert({
        id: orderId,
        customer_email: customerEmail || null,
        status: 'paid',
        total_amount: price,
        stripe_session_id: null,
        paid_at: new Date().toISOString(),
        provider: 'apple_iap',
        provider_transaction_id: matched.transaction_id || matched.original_transaction_id,
      });
      if (beatId) {
        await supa.from('order_items').insert({
          order_id: orderId,
          beat_id: beatId,
          beat_title: beat?.title || '',
          license_type: tier,
          price,
          mp3_url: beat?.audio_original_url || beat?.audio_url || null,
          wav_url: tier === 'premium' || tier === 'stems' ? beat?.wav_url : null,
          stems_url: tier === 'stems' ? beat?.stem_url : null,
          cover_url: beat?.cover_url || null,
        });
      }
    }

    // Return download details (matches the /orders/lookup response shape).
    const { data: items } = await supa.from('order_items').select('*').eq('order_id', orderId);
    res.json({
      success: true,
      orderId,
      tier,
      price,
      transactionId: matched.transaction_id,
      items: items || [],
    });
  } catch (err) {
    console.error('[IAP] validate error:', err);
    res.status(500).json({ error: err?.message || 'Validation failed' });
  }
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Drum-kit purchase — isolated from beat orders. Deliver the ZIP link.
    if (session.metadata?.type === 'kit') {
      try {
        const { rows } = await pgQuery('SELECT * FROM drum_kits WHERE id=$1', [session.metadata.kitId]);
        const kit = rows[0];
        const email = session.customer_details?.email || session.customer_email;
        if (kit && email) await sendKitEmail(email, kit);
        else console.error('kit fulfillment: missing kit or email', session.metadata.kitId);
      } catch (e) {
        console.error('kit fulfillment error:', e);
      }
      return res.json({ received: true });
    }

    const orderId = session.metadata?.orderId || session.client_reference_id;

    if (orderId) {
      try {
        // Fetch all beats so fulfillOrder can populate download URLs on order_items.
        const beats = await fetchBeatsFromDB();

        // Mark the order paid and stamp mp3/wav/stems urls onto each order item.
        await fulfillOrder({
          orderId,
          stripeSessionId: session.id,
          customerEmail: session.customer_details?.email || session.customer_email,
          customerName: session.customer_details?.name || '',
          beats,
        });

        const order = await getOrderById(orderId);
        const items = order?.order_items || [];

        if (order && order.customer_email && items.length > 0) {
          await sendFulfillmentEmail(order, orderId, items);
        }
      } catch (fulfillErr) {
        console.error('Order fulfillment error:', fulfillErr);
      }
    }
  }

  // Native PaymentSheet (Apple Pay / Google Pay / cards via mobile app) succeeds via PaymentIntent.
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const orderId = pi.metadata?.orderId;
    if (orderId) {
      try {
        const beats = await fetchBeatsFromDB();
        await fulfillOrder({
          orderId,
          stripeSessionId: pi.id,
          customerEmail: pi.receipt_email || pi.charges?.data?.[0]?.billing_details?.email || '',
          customerName: pi.charges?.data?.[0]?.billing_details?.name || '',
          beats,
        });
        const order = await getOrderById(orderId);
        const items = order?.order_items || [];
        if (order && order.customer_email && items.length > 0) {
          await sendFulfillmentEmail(order, orderId, items);
        }
      } catch (e) {
        console.error('PaymentIntent fulfillment error:', e);
      }
    }
  }

  res.json({ received: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────────────────────────

// Mount auto-upload admin routes (POST /admin/auto-upload/tick, /enqueue)
// once the rest of the app is assembled. Safe if autoUpload failed to load.
if (autoUpload && typeof autoUpload.registerRoutes === 'function') {
  try { autoUpload.registerRoutes(app); }
  catch (e) { console.warn('[auto-upload] registerRoutes failed:', e.message); }
}

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;
