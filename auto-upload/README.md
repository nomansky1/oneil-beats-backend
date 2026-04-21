# O'Neil Beats — Auto-Upload Pipeline

Queues every finished beat video and automatically publishes it to
**YouTube → Instagram Reels → TikTok** with proper SEO, a 3-second audio
hook, a generated neon thumbnail, and platform-appropriate 16:9 / 9:16 crops.

## What it does

1. **Enqueue** — your FFmpeg job finishes an MP4, calls `enqueueBeat(beat)`.
2. **Every 15 min** a cron tick runs. For each platform it:
   - Validates the video file + duration (1:50–2:30, hard fail outside).
   - Prepends a 3-second audio hook + album-cover still card.
   - Derives a 9:16 blur-pad version for Reels/TikTok (cached on disk).
   - Renders a 1280×720 thumbnail (sharp + SVG overlay, dark/neon).
   - Uploads: **YouTube first**, **Instagram 30–60 min later**, **TikTok 2–4 h later**.
3. **Writes results back to Supabase** (`auto_upload_jobs` table):
   `{ youtube_id, youtube_url, instagram_id, instagram_url, tiktok_id,
      tiktok_url, thumbnail_path, *_status, *_attempts, last_error }`.
4. **Retries** up to 3× per platform with exponential backoff (15 / 30 / 60 min).
5. **Dedupes** on `beat_id` — the same beat can't be queued twice.

## Install

Your `backend/package.json` already has `@supabase/supabase-js`, `googleapis`,
`sharp`, and `dotenv`. You only need four more:

```bash
cd backend
npm install node-cron axios ffmpeg-static ffprobe-static
```

## Migrate the DB

Run `migrations/auto_upload_jobs.sql` against your Supabase project (SQL
editor → paste → Run).

## Wire into `server.js`

```js
const autoUpload = require('./auto-upload');
autoUpload.registerRoutes(app); // exposes POST /admin/auto-upload/{tick,enqueue}

// After your existing FFmpeg job finishes producing beatVideoPath:
await autoUpload.enqueueBeat({
  id: beat.id,
  title: beat.title,
  slug: beat.slug,
  genre: beat.genre,
  bpm: beat.bpm,
  key: beat.key,
  mood: beat.mood,
  videoPath: beatVideoPath,
  albumCoverPath: beat.cover_art_url, // or local path, either works
});
```

## Run the worker

**Option A — standalone process (recommended).** Deploy `backend/` to
Railway / Render / Fly as a worker service, start command:

```bash
node backend/auto-upload/worker.js
```

**Option B — Vercel Cron Jobs.** Your existing backend stays on Vercel. Add
a Vercel Cron at `*/15 * * * *` pointing to
`POST /admin/auto-upload/tick` with header `x-admin-secret: $ADMIN_SECRET`.
The tick runs the same logic but inside the serverless function. Works for
small jobs, but long FFmpeg renders may exceed Vercel's max duration — so
this is a stopgap, not a destination.

## Required environment variables

```bash
# Supabase (reuse your existing project)
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...            # service-role, NOT anon
AUTO_UPLOAD_BUCKET=auto-upload       # create a PUBLIC bucket with this name

# YouTube — OAuth 2.0 refresh-token flow
YT_CLIENT_ID=...
YT_CLIENT_SECRET=...
YT_REFRESH_TOKEN=...
YT_PRIVACY=public                    # or unlisted / private
YT_CATEGORY_ID=10                    # 10 = Music

# Instagram — Meta Graph API
IG_USER_ID=...                       # IG Business account numeric id
IG_ACCESS_TOKEN=...                  # long-lived Page token with instagram_content_publish

# TikTok — Content Posting API
TIKTOK_ACCESS_TOKEN=...              # OAuth token with video.publish scope

# Assets
HOOK_AUDIO_PATH=assets/hook.mp3      # 3-second intro audio (YOU supply)
AUTO_UPLOAD_WORK_DIR=tmp/auto-upload # scratch dir for rendered derivatives

# Branding
STORE_URL=https://oneilbeats.store

# Stagger (defaults shown; override if you want tighter/wider)
IG_DELAY_MIN_MINUTES=30
IG_DELAY_MAX_MINUTES=60
TT_DELAY_MIN_MINUTES=120
TT_DELAY_MAX_MINUTES=240

# Optional: protect admin endpoints
ADMIN_SECRET=...
```

## How to get tokens

### YouTube refresh_token
1. Create OAuth credentials in Google Cloud Console → YouTube Data API v3
   enabled. Set type = "Desktop app" or "Web app".
2. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
3. Gear icon → **Use your own OAuth credentials** → paste client id + secret.
4. Select scope `https://www.googleapis.com/auth/youtube.upload`.
5. **Authorize** → grant on the O'Neil Beats Google account → Exchange
   authorization code for tokens. Copy the `refresh_token`. Put it in env.

### Instagram long-lived Page token
1. [Meta App Dashboard](https://developers.facebook.com/apps/) → create an app → add
   **Instagram Graph API** product.
2. Link IG account to a FB Page (only IG **Business** or **Creator**
   accounts can publish via API — **Personal can't**).
3. Graph API Explorer → get a User token → exchange for long-lived →
   extract the **Page Access Token** for the Page connected to the IG
   account. Scopes needed: `instagram_basic`, `instagram_content_publish`,
   `pages_read_engagement`, `pages_show_list`.
4. The token now lasts ~60 days. Schedule a reminder to refresh, or add
   the refresh dance as a monthly cron.

### TikTok access_token
1. [TikTok for Developers](https://developers.tiktok.com/) → create an app → request
   **Content Posting API** access. **Audited apps** can publish publicly.
   **Unaudited** apps can only publish to the user's inbox as drafts.
   Budget 1–2 weeks for the audit review.
2. OAuth flow with scope `video.publish` → user grants → you receive
   `access_token` (valid 24h by default — refresh via the refresh_token flow).

## Thumbnail repo suggestions (the honest answer)

There isn't a well-maintained open-source "album cover → YouTube music
thumbnail" generator that does this cleanly. The ones on GitHub are either
abandoned or Figma-based. The approach in `media.js` (sharp + SVG overlay +
blur-pad background) **is** the idiomatic open-source pattern — you'll find
it in projects like [`@ffmpeg-installer/thumbnail-generator`](https://www.npmjs.com/search?q=thumbnail),
[`banner-maker`](https://github.com/search?q=banner-maker+language%3AJavaScript&type=repositories),
and most YouTube automation scripts.

If you want richer design (gradients, brand glyphs, dynamic font sizing),
the next upgrade is:
- **Satori** (Vercel's JSX-to-SVG renderer) → sharp. Handles real layout
  engine + web fonts. Swap the hand-written SVG in `media.js` for a JSX
  template. Same output pipeline, richer source.

## File layout

```
backend/auto-upload/
├── README.md
├── config.js              # env loader + validation
├── copy.js                # title / description / tags / hashtags
├── cron.js                # scheduler + tick logic
├── index.js               # public API (enqueueBeat, registerRoutes, startWorker)
├── media.js               # validate / hook / vertical / thumbnail
├── notify.js              # console notifications
├── queue.js               # Supabase job CRUD
├── worker.js              # standalone process entrypoint
├── migrations/
│   └── auto_upload_jobs.sql
└── processors/
    ├── instagram.js
    ├── tiktok.js
    └── youtube.js
```

## Operational notes

- **Duration gate is strict.** 1:50–2:30 per spec. Anything outside throws
  and the job is marked failed (no retry). Change the window in `config.js`
  if you want to ship 1:30 drill loops etc.
- **Storage churn.** Derivatives (`*-with-hook.mp4`, `*-vertical.mp4`,
  `*-thumb.jpg`) are kept in `AUTO_UPLOAD_WORK_DIR` indefinitely so retries
  don't re-render. Add a cron to sweep files >30 days old if this grows.
- **Quotas.** YouTube Data API default quota is 10k units/day — each
  `videos.insert` costs 1600. You can ship ~6 videos/day before asking
  Google for more. IG Graph API is 200 calls/user/hour. TikTok is 6/day
  per user for Content Posting API (HARD LIMIT).
- **TikTok 6/day cap is the bottleneck.** Plan around it.
```
