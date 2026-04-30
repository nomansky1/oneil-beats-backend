# O'Neil Beats — Backend

Shared Vercel backend + admin dashboard for the O'Neil Beats platform.

## Owner
Non-technical producer (produceroneil@gmail.com). Works across phone + 1 dev PC. Goal is a fully-automated reggaeton/hiphop beat-selling pipeline where the producer only uploads beats and picks a theme.

## Architecture (3 apps share this backend)
- **Customer app** (`OneilBeatsApp` repo) — React Native / Expo, iOS + Android. Public-facing store.
- **OB Uploader** (`OneilBeatsUploader` repo) — React Native admin tool for uploading beats.
- **Desktop app** (`desktop-app` repo) — Electron .exe for render/publish pipeline (YouTube/IG/TT).
- **This repo** — Vercel serverless API + admin web dashboard.

## This repo's role
- `/admin/*` web pages (orders, analytics, customers, push broadcast, free-beat leads)
- `/upload/*` ingestion (tag-beat, WAV→MP3, MP3 decode)
- `/beats/*`, `/orders/*`, `/customers/*` public API
- `/admin/send-free-beat`, `/admin/analytics`, etc.
- Canonical genre/mood taxonomy: `genreTaxonomy.js` (Reggaeton / Trap / Hip Hop / Drill / Dancehall / Afrobeats / + Latin)

## Working style the owner expects
- **Verify before claiming done.** He's been burned by false "done" claims. If you can't test it, say so.
- **Don't truncate working code** while debugging. Preserve features; fix the specific issue.
- **No scope creep.** Bug fix ≠ refactor. A one-shot ≠ a helper abstraction.
- Approval gate: auto-edit + commit ✅. Pushing / deploying to production requires owner sign-off.

## Conventions in this repo
- Vercel serverless functions under `api/` (and `admin/` for admin pages).
- Supabase is the DB + storage (bucket limit currently 500MB per file).
- Orders table: read `total_amount` (not `total`).
- Genre taxonomy is canonical — don't invent new genres, reference `genreTaxonomy.js`.

## Related repos (for cross-app changes)
- `OneilBeatsApp` — customer app
- `OneilBeatsUploader` — uploader
- `desktop-app` — Electron desktop app + MCP server
