# Migrate Storage from Supabase → Google Cloud Storage

This walks you through moving the 4.5 GB of audio + cover art + thumbnails + video files off Supabase Storage and onto your existing Google Cloud Storage. The mobile apps **don't need to be rebuilt** — they fetch URLs from `/beats` and don't care which CDN serves them.

## What you do (one-time setup, ~10 min)

### 1. Create a GCS bucket (if you don't have one)

1. Go to **<https://console.cloud.google.com/storage/browser>**
2. Make sure you're in the **oneil-beats** project (top dropdown)
3. Click **Create**
4. **Name**: `oneilbeats-media` (must be globally unique — if taken, try `oneilbeats-media-prod`)
5. **Location type**: Region → `us-east1` (matches Vercel + Supabase)
6. **Storage class**: Standard
7. **Access control**: Uniform
8. **Public access prevention**: ✅ **uncheck** "Enforce public access prevention" (we want public reads)
9. Click **Create**
10. After creation: open the bucket → **Permissions** tab → **Grant access** → New principal: `allUsers` → Role: `Storage Object Viewer` → Save. (This makes the bucket's contents publicly readable, matching the current Supabase model.)

### 2. Create a service account + download the JSON key

1. Go to **<https://console.cloud.google.com/iam-admin/serviceaccounts>**
2. Click **Create Service Account**
3. **Name**: `oneilbeats-storage`
4. **Role**: `Storage Object Admin` (lets the script upload + manage objects in the bucket)
5. **Done**
6. On the service account page → **Keys** tab → **Add Key** → **Create new key** → **JSON** → **Create**
7. The JSON file downloads. **Save it** at exactly:
   ```
   desktop-app/backend/gcs-service-account.json
   ```
   (already in `.gitignore` so it never commits)

### 3. Set env vars

Add these to your `desktop-app/backend/.env` (or set them in your shell):

```bash
GCS_BUCKET=oneilbeats-media
GCS_PROJECT_ID=oneil-beats
GOOGLE_APPLICATION_CREDENTIALS=./gcs-service-account.json
```

For Vercel production: add the same three to **Vercel → Project → Settings → Environment Variables**. For `GOOGLE_APPLICATION_CREDENTIALS`, set `GOOGLE_APPLICATION_CREDENTIALS_JSON` instead with the **contents** of the JSON file (Vercel reads it as a string).

## What the migration script does

```bash
cd desktop-app/backend
npm install                                          # picks up @google-cloud/storage
node scripts/migrate-supabase-to-gcs.js --dry-run    # safety check first
node scripts/migrate-supabase-to-gcs.js              # for real
```

It runs in two phases:

### Phase 1 — Copy files (Supabase → GCS)
Copies every object in your 5 Supabase Storage buckets to GCS at matching paths:

| Supabase bucket | → | GCS path |
|---|---|---|
| `beats` | → | `gs://oneilbeats-media/beats/...` |
| `cover-art` | → | `gs://oneilbeats-media/cover-art/...` |
| `thumbnails` | → | `gs://oneilbeats-media/thumbnails/...` |
| `auto-upload` | → | `gs://oneilbeats-media/auto-upload/...` |
| `cloud-render` | → | `gs://oneilbeats-media/cloud-render/...` |

Idempotent — re-running skips files already in GCS with matching size. Safe to interrupt and resume.

### Phase 2 — Update database URLs
After every file is in GCS, the script rewrites every Supabase URL in your DB to the matching GCS URL. Tables touched:

- `beats`: `audio_url`, `audio_original_url`, `cover_url`, `wav_url`, `stem_url`
- `auto_upload_jobs`: `audio_url`, `album_cover_path`, `thumbnail_path`, `vertical_path`, `video_path`, `short_path`
- `order_items`: `cover_url`, `mp3_url`, `wav_url`, `stems_url`, `license_pdf_url`

The `instagram_url`, `tiktok_url`, and `youtube_url` columns in `auto_upload_jobs` are **not** touched — those are external platform URLs, not Supabase.

## Why the apps stay seamless

- The mobile apps fetch `/beats` from the backend and load whatever URL is in `audio_url` / `cover_url`. They don't have a hardcoded domain — `storage.googleapis.com` is just as valid as `supabase.co`.
- iOS App Transport Security (ATS) and Android Network Security require HTTPS. GCS public URLs are HTTPS. ✓
- GCS supports byte-range requests for audio streaming. ✓
- **Supabase files are NOT deleted by the migration.** Anything an app has cached or has in flight keeps working. Only after 30 days of verified uptime should you optionally delete the Supabase originals to reclaim that 4.5 GB.

## Rollback plan (if something looks wrong)

The DB URL rewrite is reversible:

```sql
-- run inside Supabase SQL editor
UPDATE beats SET audio_url = REPLACE(audio_url, 'https://storage.googleapis.com/oneilbeats-media', 'https://thmqqplnrjwimgqubkhp.supabase.co/storage/v1/object/public');
-- repeat for the other 4 columns + the auto_upload_jobs and order_items tables
```

Since the Supabase files weren't deleted, the rolled-back URLs immediately work again.

## What changes for new uploads after the migration

`backend/supabaseApi.js` already routes through GCS automatically when `GCS_BUCKET` is set in env. So once you set the env var on Vercel:

- New beats uploaded via the EXE → GCS
- AI-generated cover art → GCS
- Beat→video renders → GCS
- Auto-social-post images → GCS

No more Supabase Storage usage going forward. Your Supabase plan stays comfortably under the free 1 GB limit (you're at 14 MB DB + 0 MB new storage = essentially nothing).

## Cost estimate after migration

| Service | Use | Monthly cost |
|---|---|---|
| Supabase free tier | DB (14 MB) + Auth (free) | **$0** |
| Google Cloud Storage | 4.5 GB stored | **~$0.09** |
| GCS egress | depends on traffic — likely under 5 GB/mo | **~$0.60-3** |
| **Total** | | **~$1-3/mo** |

vs Supabase Pro at $25/mo if you grew past free tier. Saves roughly **$20+/mo**.
