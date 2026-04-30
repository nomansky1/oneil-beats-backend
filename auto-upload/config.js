// Central env-var loader.
// Required vars throw at module load so misconfig surfaces on startup — NOT
// five seconds into an upload when a token is missing.

require('dotenv').config();

function req(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`[auto-upload] required env var missing: ${name}`);
  }
  return String(v).trim();
}
function opt(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}
function bool(name, fallback = false) {
  const v = String(process.env[name] || '').toLowerCase().trim();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}
function int(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

// YouTube-only platform flags. IG + TikTok + Facebook stay off until you flip these on.
const ENABLE_YOUTUBE   = bool('ENABLE_YOUTUBE',   true);
const ENABLE_INSTAGRAM = bool('ENABLE_INSTAGRAM', false);
const ENABLE_FACEBOOK  = bool('ENABLE_FACEBOOK',  false);
const ENABLE_TIKTOK    = bool('ENABLE_TIKTOK',    false);

// YouTube credentials. Fall back to the existing GOOGLE_OAUTH_* vars so you
// don't have to re-enter the same OAuth client if you granted YouTube scope
// during re-auth. Required only if ENABLE_YOUTUBE is on.
const YT_CLIENT_ID     = ENABLE_YOUTUBE ? (opt('YT_CLIENT_ID')     || req('GOOGLE_OAUTH_CLIENT_ID'))    : '';
const YT_CLIENT_SECRET = ENABLE_YOUTUBE ? (opt('YT_CLIENT_SECRET') || req('GOOGLE_OAUTH_CLIENT_SECRET')) : '';
const YT_REFRESH_TOKEN = ENABLE_YOUTUBE ? (opt('YT_REFRESH_TOKEN') || req('GOOGLE_OAUTH_REFRESH_TOKEN')) : '';

module.exports = {
  // ── Platform switches ─────────────────────────────────────────────────────
  ENABLE_YOUTUBE, ENABLE_INSTAGRAM, ENABLE_FACEBOOK, ENABLE_TIKTOK,

  // ── Supabase (reuses your existing project) ───────────────────────────────
  SUPABASE_URL:        req('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: req('SUPABASE_SERVICE_KEY'),
  // Public bucket for the short-lived URL IG needs. Only required if IG is on.
  STORAGE_BUCKET:      opt('AUTO_UPLOAD_BUCKET', 'auto-upload'),

  // ── YouTube Data API v3 (OAuth 2.0 refresh-token flow) ────────────────────
  YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN,
  YT_PRIVACY:     opt('YT_PRIVACY', 'public'),    // public | unlisted | private
  YT_CATEGORY_ID: opt('YT_CATEGORY_ID', '10'),    // 10 = Music (ranks in Music search)

  // ── Meta Graph API (Instagram Reels) — only required if ENABLE_INSTAGRAM ──
  IG_USER_ID:      ENABLE_INSTAGRAM ? req('IG_USER_ID')      : '',
  IG_ACCESS_TOKEN: ENABLE_INSTAGRAM ? req('IG_ACCESS_TOKEN') : '',

  // ── Meta Graph API (Facebook Page video) — only required if ENABLE_FACEBOOK
  // FB_PAGE_ACCESS_TOKEN can be the same long-lived Page token as IG_ACCESS_TOKEN
  // (Meta issues one token per Page that works for both IG Business + Page posts).
  FB_PAGE_ID:           ENABLE_FACEBOOK ? req('FB_PAGE_ID')           : '',
  FB_PAGE_ACCESS_TOKEN: ENABLE_FACEBOOK ? (opt('FB_PAGE_ACCESS_TOKEN') || (ENABLE_INSTAGRAM ? req('IG_ACCESS_TOKEN') : req('FB_PAGE_ACCESS_TOKEN'))) : '',

  // ── Meta App credentials (used by token health + auto-rotation only) ──────
  // META_APP_SECRET is optional: if missing, refresh button is disabled but
  // /debug_token health checks still work (they only need the token itself).
  META_APP_ID:     opt('META_APP_ID'),
  META_APP_SECRET: opt('META_APP_SECRET'),

  // Token health policy
  META_TOKEN_WARN_DAYS: int('META_TOKEN_WARN_DAYS', 14),  // yellow banner threshold
  META_TOKEN_CRIT_DAYS: int('META_TOKEN_CRIT_DAYS', 3),   // red banner + email alert

  // ── TikTok Content Posting API — only required if ENABLE_TIKTOK ───────────
  TIKTOK_ACCESS_TOKEN: ENABLE_TIKTOK ? req('TIKTOK_ACCESS_TOKEN') : '',

  // ── Assets ────────────────────────────────────────────────────────────────
  HOOK_AUDIO_PATH:     opt('HOOK_AUDIO_PATH', 'assets/hook.mp3'),
  WORK_DIR:            opt('AUTO_UPLOAD_WORK_DIR', 'tmp/auto-upload'),

  // ── Branding ──────────────────────────────────────────────────────────────
  STORE_URL:           opt('STORE_URL', 'https://oneilbeats.store'),

  // ── Stagger timing (only used when IG + TT are enabled) ───────────────────
  IG_DELAY_MIN_MINUTES: int('IG_DELAY_MIN_MINUTES', 30),
  IG_DELAY_MAX_MINUTES: int('IG_DELAY_MAX_MINUTES', 60),
  TT_DELAY_MIN_MINUTES: int('TT_DELAY_MIN_MINUTES', 120),
  TT_DELAY_MAX_MINUTES: int('TT_DELAY_MAX_MINUTES', 240),

  // ── Validation ────────────────────────────────────────────────────────────
  // Window widened 2026-04-21 after hitting real-world beats that exceed the
  // original 110–150s preview-loop window. The desktop flow is now preview-
  // first, so the user sees the full video before publish — no need to
  // re-enforce preview-loop duration here. 30s floor keeps Shorts valid;
  // 360s ceiling covers long reggaeton/trap beats without forcing a trim.
  MIN_DURATION_SEC: 30,    // 0:30 (Shorts floor)
  MAX_DURATION_SEC: 360,   // 6:00 (covers full beats)

  // ── Retry policy ──────────────────────────────────────────────────────────
  MAX_ATTEMPTS: 3,
};
