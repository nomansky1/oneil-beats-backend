# Scheduled Beat Uploads — Backend

Lets the producer queue beats with a future `scheduled_for` timestamp. The
beat stays hidden from customers (active=false) until a Vercel cron flips it
live. Auto-upload to YT/IG/TT fires immediately on upload regardless of
schedule (producer's choice — drives anticipation). Push notifications and
email blasts wait for the cron tick to fire alongside the catalog appearance.

## Wiring

| Component | File | What |
|---|---|---|
| DB | `migrations/scheduled_uploads.sql` | `ALTER TABLE beats ADD COLUMN scheduled_for timestamptz` + partial index |
| Filter | `supabaseApi.js::fetchBeatsFromDB` | Hides future-scheduled beats from `GET /beats` |
| Insert | `supabaseApi.js::addBeatToDB` | Honors `scheduled_for`, sets `active=false` when future |
| Upload | `server.js::POST /upload/beat-metadata` | Accepts `scheduled_for` field, gates push+email |
| Admin list | `server.js::GET /admin/scheduled-beats` | Lists pending |
| Admin reschedule | `server.js::PUT /admin/beat/:id/schedule` | Update timestamp |
| Admin cancel | `server.js::DELETE /admin/beat/:id/schedule` | Hard-delete pending row |
| Cron | `server.js::GET /cron/publish-scheduled` | Flips ready beats live, fires push+email |
| Cron config | `vercel.json` | `*/15 * * * *` (every 15 minutes) |

## To deploy

1. **Run the migration** in Supabase SQL editor:
   ```sql
   -- contents of migrations/scheduled_uploads.sql
   ```
2. **Set `CRON_SECRET`** in Vercel env (any random string). Vercel auto-signs
   cron requests with `Authorization: Bearer ${CRON_SECRET}`. Without it, the
   cron route falls back to admin-key auth (`?adminKey=…` or `X-Admin-Key`).
3. **Verify cron is registered**: after deploy, Vercel dashboard → Settings →
   Cron Jobs should show `/cron/publish-scheduled` every 15 min.
4. **Smoke-test**: upload a beat with `scheduled_for` 2 minutes in the future.
   Wait 15+ minutes. Verify `/beats` returns it, push fired, email blast sent.

## Vercel plan caveat

`*/15 * * * *` (every 15 min) requires **Vercel Pro** ($20/mo). On Hobby plan
cron is daily-only — change the schedule in `vercel.json` to e.g. `0 12 * * *`
(daily at 12pm UTC) and your scheduled beats will publish at the next daily
tick after their timestamp.

## Validation rules

- `scheduled_for` must be valid ISO 8601
- Past timestamps are treated as "publish now" — beat goes live immediately
- Max 30 days in the future (anti-typo guard)
- One-way constraint: only `active=false` beats with `scheduled_for IS NOT NULL`
  can be cancelled via `DELETE /admin/beat/:id/schedule`. Live catalog rows
  must use the existing `DELETE /admin/beat/:id` (soft delete).

## What this PR doesn't do

- **EXE UI:** the date-picker, schedule toggle, and queue panel land in the
  desktop-app repo as a separate change. Until that ships, you can test the
  backend via curl:
  ```bash
  curl -X POST https://oneilbeats.store/upload/beat-metadata \
    -H "Content-Type: application/json" \
    -H "X-Admin-Key: $ADMIN_KEY" \
    -d '{"title":"Test","audio_url":"...","cover_url":"...","scheduled_for":"2026-05-17T18:00:00Z"}'
  ```
- **Customer-facing "coming soon" page:** future-scheduled beats currently 404
  on `/beat/:slug`. Could be enhanced later to show a "Drops May 17" placeholder
  for social-traffic UX. Not in scope here.
- **Auto-upload coordination:** YT/IG/TT auto-upload fires immediately on upload
  per the producer's chosen behavior. If they change their mind later, gating
  auto-upload on schedule is a one-line change.

## Rollback

If anything misbehaves: drop the cron job in `vercel.json`. The
`scheduled_for` column is harmless to keep — it's only consulted on read and
ignored on null. Live beats keep working.
