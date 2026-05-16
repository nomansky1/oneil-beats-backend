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
| Cron config | `vercel.json` | `0 12 * * *` (daily at 12:00 UTC = 8am Puerto Rico) |

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

## Vercel plan + cron precision

This PR ships with `0 12 * * *` (daily at 12:00 UTC = 8am Puerto Rico time)
because Vercel **Hobby plan** caps cron at one run per day. The build was
initially attempted with `*/15 * * * *` and failed — Vercel rejects sub-day
intervals on Hobby.

**What this means in practice:**
- A scheduled beat publishes at the **next 12:00 UTC tick after its
  `scheduled_for` timestamp.**
- If you schedule a beat for Tuesday 9am UTC, it publishes at Tuesday 12pm UTC
  (3 hours late).
- If you schedule a beat for Tuesday 5pm UTC, it publishes at Wednesday 12pm
  UTC (19 hours late).
- **For multiple beats per day, all of them scheduled before 12pm UTC fire at
  the same 12pm UTC tick.** No staggering within a single day unless you
  upgrade.

**To get tighter precision (every 15 min, every hour, etc.):**
1. Upgrade to **Vercel Pro** ($20/mo) — supports cron at minute-level intervals
2. Change `vercel.json` cron to your desired schedule (e.g. `*/15 * * * *`)
3. Redeploy

**To shift the daily tick time** to match your audience: change `0 12 * * *`
to your preferred UTC hour (e.g. `0 17 * * *` = 5pm UTC = 1pm Puerto Rico time
for an afternoon drop window).

**Alternative for Hobby:** run a free external cron service (cron-job.org,
EasyCron) that hits `https://oneilbeats.store/cron/publish-scheduled` with
the `X-Admin-Key` header every 15 min. Works around Vercel's plan limit
without paying for Pro.

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
