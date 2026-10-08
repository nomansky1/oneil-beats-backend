# Vigil: gaps in Citizen, and how we win

## Citizen's gaps

From the Citizen screens you shared, plus public App Store / Play reviews
collected by unitQ and coverage by NBC News.

| Gap | Evidence | Vigil's answer |
| --- | --- | --- |
| Basic features behind a paywall | Premium ($5.99/mo or $39.99/yr) locks map filters, incidents older than 24 hours, registered-offender details and police radio. Safety Network shows a lock. | All free. 30 days of history, every filter, official offender registry link, scanner links, safety network. |
| Paying to control alerts | Reviewers call charging for notification preferences "insane"; others say alerts stopped arriving or can't be opened. | Every alert setting is free, with a simulation showing what your settings would have sent in the last 24 hours. |
| Speed over verification | Critics say Citizen prioritizes speed, leading to errors. In 2021 it put a bounty on a man who turned out to be innocent. | Truth meter on every item, the sources behind it, and what's confirmed vs. not. Unverified posts are labelled and can be hidden. |
| Fear and doom-scrolling | The "Nationwide" feed leads with a shooting 652 miles away. | Local first. Calm mode turns off pulsing, hides unverified reports and leads with context ("5 of 16 reports are traffic or medical calls"). |
| Rewards for posting | "Achieve your first badge... alert your community" pushes volume. | No badges for reporting. The report flow coaches people away from naming people, race-only descriptions and calls to confront anyone. |
| Privacy and permission nagging | Reviewers complain about repeated permission prompts. | No account. Search works without location access. The server rounds location to about 1 km. |
| Thin coverage outside big cities | Citizen is strongest where it has staff and users. | Official national feeds (NWS, USGS, FEMA) cover every county and all five inhabited territories on day one. Local news clustering works for any town. |

## Moats

1. **Trust you can check.** Each label comes from the sources alone, the
   outlet tier list is public, and corrections are logged on the item. Hard to
   copy for an app whose growth depends on raw volume.
2. **Official-data adapters.** Every city police/fire feed added to
   `lib/sources/opendata.js` is work a competitor has to redo. This list is
   the long-term asset.
3. **Territories and Spanish.** Puerto Rico, Guam, USVI, American Samoa and
   the Northern Marianas are covered from launch. Spanish UI is next on the
   roadmap.
4. **Low cost per user.** Edge caching per ~1 km area means a busy town
   costs about the same as a quiet one. That's what lets the core stay free.
5. **Fast first, labelled honestly.** X posts from police, fire and NWS
   accounts are often the first sign of an incident. Vigil shows them
   immediately, labelled Official if the account is government-verified and
   Unverified otherwise, then upgrades them when news or dispatch data
   confirms.

## X (x.com) as a source

- **What it's good for:** speed. Agencies post road closures, shelter-in-place
  orders and missing-person alerts there first.
- **Free, on now:** the feed shows official agency accounts for your area
  (police, fire, your NWS office, FEMA, USGS) and, in the live app, their
  latest public posts through X's own embed. No X account, X Premium or API
  key needed. X Premium (the blue check) doesn't unlock any of this anyway;
  the API is a separate developer account.
- **Paid, optional:** searching every recent post that names your city.
  Government-verified accounts count as official; everything else is
  Unverified until confirmed. Retweets and replies are skipped.
- **Not doing:** scraping X. Its terms ban it, and it breaks often.
- **Cost:** new developers pay per post read, about $0.005 each as of 2026,
  with no free tier since February 2026. A city with ~50 matching posts a
  day is roughly $0.25/day. 100 active cities is roughly $25/day. These are
  estimates; the X Developer Console has the real rates.
- **Plan:** free embeds now; turn on paid search once there's revenue,
  busiest metros first. Grow the official-account list city by city. Community Notes have no public read API today, so
  they can't feed the truth meter yet.

## Money (later, via the website)

The core safety features stay free for individuals. Options that don't
undercut that:

- Local business sponsorships on the website, with no tracking ads in the app.
- A paid data/API tier for newsrooms, researchers and property managers
  (clustered, sourced incident data).
- Donations / memberships, the public-radio model.
- Paid organization accounts (schools, campuses, HOAs) for private alert
  channels.

## Roadmap

1. **Now (this branch):** web app, live API, offline preview, tests.
2. **Go live (needs owner sign-off):** separate Vercel project, domain,
   `VIGIL_CONTACT` set; check the Source status panel against real data.
3. **Accounts-free persistence:** Supabase tables for community reports,
   corrections and follows; moderation queue.
4. **Push:** a scheduled worker that polls feeds per active area and sends
   web push / Expo push for matches.
5. **Native apps:** an Expo app that reuses this API, then App Store / Play.
   Apple's user-generated-content rules need report/block tools and a
   moderation process, which step 3 covers.
6. **Coverage:** more city dispatch feeds, Spanish UI, state 511 traffic feeds.

## Sources

- Citizen Premium and profile screens shared by the owner (Oct 2026).
- unitQ Citizen scorecard: https://unitq.com/unitq-scorecards/citizen
- NBC News, "Inside Citizen": https://www.nbcnews.com/tech/tech-news/citizen-public-safety-app-pushing-surveillance-boundaries-rcna1058
- X API pricing, 2026: https://www.postproxy.dev/blog/x-api-pricing-2026/ and https://opentermsarchive.org/en/memos/x-replaces-its-dollar200-entry-level-api-plan-with-a-pay-per-use-model/
- X Community Notes API (write-only pilot): https://docs.x.com/x-api/community-notes/search-for-community-notes-written.md
