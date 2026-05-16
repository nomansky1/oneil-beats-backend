# Cloudflare R2 Migration — Phase 1

**Status:** ✅ Additive setup landed. R2 NOT yet active in production.
**Risk to live traffic:** 0. Feature flag defaults off, no existing code path changed.

---

## What this PR ships

| File | Purpose |
|---|---|
| `r2Api.js` | R2 client. Same function surface as `gcsApi.js` (uploadFileToStorage, uploadAudioToStorage, uploadCoverToStorage, getSignedUploadUrl, deleteObject, listObjects, headObject, publicUrl). |
| `storage.js` | Unified adapter. Routes calls to either GCS or R2 based on `USE_R2_FOR_UPLOADS` env flag. Default = GCS (no change). |
| `scripts/test-r2.js` | Smoke test. Uploads → HEAD → lists → fetches publicly → deletes. Run before flipping the flag. |
| `package.json` | Adds `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. |
| `.env.example` | New `R2_*` vars + `USE_R2_FOR_UPLOADS` flag documented. |

**No existing file is modified beyond `package.json` and `.env.example`.** Every current call site (server.js, supabaseApi.js, gcsApi.js consumers, the upload routes, the desktop EXE) keeps doing exactly what it did yesterday.

---

## Why "Phase 1"

Migrating live storage on a store with paid downloads + cached app URLs is a 4-phase op:

1. **Phase 1 (this PR):** Wire up the R2 client behind a feature flag. Zero customer impact.
2. **Phase 2:** Flip new uploads to dual-write (GCS + R2). Old beats still on GCS. Run for ~1 week.
3. **Phase 3:** Backfill — copy existing GCS files to R2, update DB URLs atomically per beat. Stripe webhook + customer app keep working because both URLs stay valid during the transition.
4. **Phase 4:** Decommission GCS after 30+ days of Phase 3 stability.

Each phase ships separately and gets validated before the next one starts.

---

## How to verify this PR

After deploy (or locally with `.env` populated):

```bash
node scripts/test-r2.js
```

You should see steps 1–6 all pass. Step 5 ("public read") is the one that catches misconfiguration — see below.

---

## Critical config gotcha — `R2_PUBLIC_URL`

The R2 credentials currently in `.env` set `R2_PUBLIC_URL` to the S3 API endpoint:

```
R2_PUBLIC_URL=https://{accountId}.r2.cloudflarestorage.com/oneilbeats-prod
```

**That URL is for signed S3 requests — it will not serve files to a browser.** Files written to R2 will exist, but customer apps / Stripe download links pointing at that URL will 401 / 403.

Before we move to Phase 2 we need to pick ONE of:

**Option A — Cloudflare-managed public domain (fastest):**
1. Cloudflare dashboard → R2 → `oneilbeats-prod` → Settings
2. Under "R2.dev subdomain", click **Allow Access** → enable
3. Copy the URL it gives you (looks like `https://pub-abc123.r2.dev`)
4. Set `R2_PUBLIC_URL=https://pub-abc123.r2.dev` in Vercel env

**Option B — custom subdomain on oneilbeats.store (production-quality):**
1. Cloudflare dashboard → R2 → `oneilbeats-prod` → Settings → Custom Domains → Connect Domain
2. Enter e.g. `cdn.oneilbeats.store` (your DNS must be on Cloudflare for this to work)
3. Cloudflare auto-creates the CNAME and provisions a cert
4. Set `R2_PUBLIC_URL=https://cdn.oneilbeats.store` in Vercel env

`scripts/test-r2.js` step 5 confirms whichever you pick.

---

## Phase 2 preview (not in this PR)

Once Phase 1 is verified and `R2_PUBLIC_URL` is a real public endpoint:

- Audit every call site that touches storage. Replace `require('./gcsApi')` with `require('./storage')` (the unified adapter).
- Add an `audio_url_r2`, `cover_url_r2`, etc. set of columns to `beats`, OR keep one column and dual-write the full GCS+R2 pair into a JSON field for fallback during transition.
- Set `USE_R2_FOR_UPLOADS=true` on a Vercel preview deploy first, smoke-test, then production.
- Verify: customer app catalog loads, Stripe checkout → download still works, DistroKid pull from `audio_original_url` still works (these all currently use GCS URLs — Phase 2 wrap-up has to update the DB rows for new uploads).

Then Phase 3 backfills the existing 50+ beats. Phase 4 turns off GCS.

---

## Rollback

If anything in Phase 1 misbehaves: just unset `USE_R2_FOR_UPLOADS` (or set it to `false`). The storage adapter falls through to GCS instantly. Nothing in this PR is destructive.
