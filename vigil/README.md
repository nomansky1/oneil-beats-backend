# Vigil (working name)

A free, Citizen-style safety app for every US state, DC and the five
inhabited territories (Puerto Rico, Guam, U.S. Virgin Islands, American
Samoa, Northern Mariana Islands). Every report shows where it came from and
how well it's confirmed.

This folder is self-contained. It does not touch the O'Neil Beats backend:
the root `vercel.json` sends every request to `server.js`, and nothing here is
imported by it. It should become its own repo and its own Vercel project.

## What's in here

| Path | What it does |
| --- | --- |
| `public/` | The phone web app: map, feed, detail sheets, report flow, alerts, safety. Installable as a home-screen app. |
| `api/feed.js` | `GET /api/feed?lat=&lon=&radius_mi=&hours=`: everything near a point, with sources and a truth label on each item. |
| `api/national.js` | `GET /api/national`: severe alerts, big quakes and top safety stories across the US and territories. |
| `api/geocode.js` | `GET /api/geocode?q=`: place search limited to US states and territories. |
| `api/registry.js` | `GET /api/registry?lat=&lon=&radius_mi=`: registered sex offenders nearby where the state allows apps, plus the official registry link. Never cached. |
| `lib/sources/` | One adapter per data source (below). |
| `lib/verify.js` | The truth meter: Official record / Corroborated / Single source / Unverified. |
| `lib/cluster.js` | Groups articles about the same event so a story shows "reported by 3 outlets". |
| `lib/og-image.js` | Finds an article's own share picture (the link-preview image) for news stories. |
| `data/city-feeds.json` | 46 police calls-for-service and incident feeds in 35 places, generated from OpenPoliceData. |
| `data/sample.js` | **Invented** sample events for the offline phone preview only. |
| `public/map-style.json`, `public/map-style-satellite.json` | Night and Satellite street maps, built from `scripts/map-styles/` by `npm run build:style`. |
| `scripts/build-preview.js` | Builds `preview/vigil-preview.html`, the single-file preview. |
| `scripts/build-city-feeds.js` | Rebuilds `data/city-feeds.json` from OpenPoliceData's source table. |
| `STRATEGY.md` | Citizen's gaps, Vigil's moats, roadmap, money. |

## Data sources (all free unless noted)

The app re-checks every source once a minute while it's open (every two
minutes for the nationwide tab) and shows "Live · 20s ago" so you can see how
fresh it is. "Re-fetched" is how long the server reuses an answer before
asking the source again; "Source delay" is how far behind the source itself
runs.

| Source | What it adds | Re-fetched | Source delay | Truth label |
| --- | --- | --- | --- | --- |
| National Weather Service alerts | Weather, plus AMBER alerts, law-enforcement warnings, evacuations relayed through IPAWS. Covers the territories. | 1 min | Minutes | Official |
| USGS earthquakes | Quakes near you, plus M4.5+ nationwide | 1 min | Minutes | Official |
| NIFC wildfires (WFIGS) | Every active wildfire within 50 miles with acres and % contained; fires over 1,000 acres nationwide | 5 min | Updated by fire crews, often daily | Official |
| NASA FIRMS satellite heat (needs a free key) | Heat spotted from orbit near you, grouped about 1 km apart. Labeled as heat, not confirmed fire. | 10 min | About 3 hours | Official |
| OpenFEMA disaster declarations | Active declarations for your county | 15 min | Days | Official |
| FEMA IPAWS alert archive | Past AMBER, evacuation, shelter-in-place and weather alerts for timeframes over 24 hours. Listed, not pinned (they cover an area). | 1 hour | 24 hours (FEMA's rule) | Official |
| City police and fire open data | Block-level dispatch calls and crime reports: 46 feeds in 35 places in 20 states (Seattle, LA, San Francisco, Chicago, Detroit, Austin, Cincinnati, Memphis, Tacoma, Montgomery County MD and more), matched to your city or county. | 1 min | Real time to a few days, by city | Official |
| Google News RSS + GDELT | Local news, clustered across outlets, with each article's own picture when it has one | 2–3 min | Minutes | Corroborated or Single source |
| Storm damage reports (NWS, via Iowa Environmental Mesonet) | Tornado touchdowns, hail, downed trees and lines, flooding, reported to the weather service, with the exact spot, within 25 miles. Public domain; credit IEM. | 5 min | Minutes | Official (public reports flagged as not yet surveyed) |
| Bluesky public posts | Posts naming your city and a safety topic. A post must also name the state or county, unless it comes from a local agency's .gov address. Handles ending in .gov or .mil count as official; everyone else is Unverified. Text and link only; nothing stored. No key. | 2 min | None | Official or Unverified |
| License plate cameras (OpenStreetMap) | Flock and other plate readers mapped by volunteers, with vendor, operator and direction. A map layer, not incidents. | 6 hours | As fast as volunteers map them | Not rated |
| Sex offender registries | Iowa (with photos), Missouri, Tennessee and DC on the map, with alerts when someone is newly listed nearby, even with the app closed. Every other state, DC and territory: a link to its official registry. | Iowa: every request; MO, TN, DC: 1 hour. Checked every 15 min. | Daily | Official registry |
| Official agency accounts on X (free) | Public posts from police, fire, NWS, FEMA and USGS accounts near you, shown with X's own embed. No X account, no Premium, no API key. Listed in `data/x-accounts.js`. | Live (X's embed) | None | Shown as posted; not rated |
| X search (paid, off by default) | Searches all recent posts naming your city. Government-verified accounts count as official; everyone else is Unverified. Needs an X developer API key (not X Premium), billed per post read. | 2 min | None | Official or Unverified |
| Community reports | What people nearby post in the app | Instant | None | Unverified until confirmed |

News articles rarely give an address, so stories sit at the city center and
say "City-level" instead of a guessed pin. News pictures are the outlet's own
share image (the one chat apps show in link previews). Vigil stores only the
link, loads the picture from the outlet, credits it and links to the article.
Stories that only appear in Google News have no picture, because Google's
links are redirects Vigil doesn't unwrap.

Fires and earthquakes are searched farther out than your radius. They appear
in the list with their distance, but the "within 2 mi" counts leave them out.

## Run it

```bash
cd vigil
npm install
npm test                 # 41 tests: parsers, truth meter, every source adapter, API
npm run dev              # http://localhost:3000 with live upstream data
npm run dev:fixtures     # same, with canned upstream data (no network)
npm run build:preview    # writes preview/vigil-preview.html
npm run build:style      # rewrites the Night and Satellite map styles
npm run build:city-feeds -- path/to/opd_source_table.csv   # refresh city feeds
```

Environment variables:

| Name | Needed? | Purpose |
| --- | --- | --- |
| `VIGIL_CONTACT` | Yes, before going live | Email or URL sent in the User-Agent. NWS and OpenStreetMap require it. |
| `X_BEARER_TOKEN` | Optional | Turns on paid X search. Not needed for the free official-account posts. |
| `X_CACHE_SECONDS` | Optional | How long X results are reused per city (default 120). |
| `FIRMS_MAP_KEY` | Optional | Free NASA FIRMS key (firms.modaps.eosdis.nasa.gov/api/map_key). Turns on satellite heat detections. |
| `OVERPASS_URL` | Optional | A different Overpass API server for plate-camera data. The public one is shared and rate limited. |
| `SUPABASE_URL`, `SUPABASE_KEY` | For background alerts | The alerts database (Supabase project "Vigil") and its publishable key. |
| `WATCH_SECRET` | For background alerts | Shared with the database (`private.settings`); the only way into it. Mark it sensitive. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | For background alerts | Web Push key pair (`npx web-push generate-vapid-keys`). Mark the private one sensitive. |

## Put it live (needs the owner's OK)

Live at https://vigil-mauve-one.vercel.app (Vercel project `vigil`, with
`VIGIL_CONTACT` set to that address). To set it up again elsewhere:

1. Create a new Vercel project from this repo and set **Root Directory** to
   `vigil`. Framework preset: Other. No build command.
2. Add `VIGIL_CONTACT` (and `X_BEARER_TOKEN` if you want X).
3. Deploy. Open the URL on your phone and use "Add to Home Screen".

## On Android

Open the site in Chrome. The Alerts tab shows **Install Vigil on this
phone** when Chrome offers it (or use Chrome's menu, then *Install app*).
Installed, it opens full screen with its own icon. `public/sw.js` keeps the
app files on the phone so it opens on a weak signal, and sends notifications
the way Android requires (through the service worker; the plain browser
call is blocked there). Tapping a notification opens that report or
registry record. The phone's Back button closes an open panel instead of
leaving the app. Live data (`/api/*`) is never stored by the service worker.

The same site can later be packaged for Google Play as a Trusted Web
Activity (for example with Bubblewrap) without rewriting it.

### Registry alerts with the app closed

Where a registry is on the map, a phone with notifications allowed and the
registry switch on signs up for background alerts (`POST /api/push`). It
stores the browser's push address and the map area rounded to about 1 km in
the alerts database. Turning the switch off, or moving to a state without a
registry map, deletes it (`DELETE /api/push`).

Every 15 minutes `pg_cron` in the database calls `/api/registry-watch`
with the shared secret. `lib/watch.js` asks each watched area's registry
who is listed, compares that with the IDs it saw before (IDs only, dropped
14 days after last seen) and pushes any new listing to the phones watching
that area. The first check of an area only records what's there. A capped
answer (more people than the registry returns at once, as Iowa does past
100) can't tell who is new, so it sends nothing. Notifications carry no
names; tapping one opens the record in the app. Iowa is asked about at most
3 areas per check, to stay under its hourly limit.

The database is set up by `db/001_registry_alerts.sql` and
`db/002_watch_schedule.sql`. Row level security is on with no policies,
and every function needs the watch secret, so the publishable key alone
reads nothing.

Responses are cached at Vercel's edge for 60 seconds per ~1 km area, so cost
grows with the number of places people watch rather than the number of
people watching them.

## What's verified and what isn't

- **Tested here:** all 41 unit/API tests pass. The app was driven in a
  headless phone-size browser (360 and 390 px wide, and an emulated Pixel 7)
  against the local server (fixture data, with the MapLibre street map
  loading) and against the preview build, with no script errors. On the
  Pixel 7 run:
  - notifications go through the service worker;
  - tapping one opens the right record;
  - Back closes panels;
  - the app opens offline.
- **Tested live (October 9, 2026)** on https://vigil-mauve-one.vercel.app
  with real data in Detroit, Des Moines, Nashville, Washington DC and
  Chicago:
  - The site, app files, map styles and all three map tile sources load,
    with no login wall.
  - Working: place lookup and search, NWS alerts, USGS, FEMA, NIFC
    wildfires, Google News, Bluesky, storm reports, plate cameras (when
    Overpass answers in time), Detroit 911 calls, Chicago crime reports and
    the national view.
  - Registry pins: Iowa (names, photos, addresses), Tennessee (names,
    addresses, offenses) and DC (names, block, class, home or work). Iowa's
    API leaves offenses out when a page holds more than 20 records; Vigil
    asks for 100 in one call to stay under Iowa's hourly limit, so Iowa
    records say to see the official record. Tennessee's layer has no photos.
  - Fixed after that test:
    - Storm reports from other states showed in every city (the feed
      ignores its area filter).
    - GDELT refused requests (one per 5 seconds per address, and Vercel's
      addresses are shared) and held news up by 8 seconds.
    - Plate-camera lookups could run past the 15-second function limit.
    - Tennessee and DC registry fields were read from the wrong columns.
  - Still open:
    - News pictures came from GDELT, which refuses Vercel's shared servers,
      so most stories have no picture for now.
    - Chicago's crime data runs 7 days behind, so it shows under "Last 7
      days", not "Last 24 hours".
    - Detroit's incident-report dataset is slow and sometimes times out (its
      911 calls work).
    - Satellite heat detections need `FIRMS_MAP_KEY`; X search is off.
  - Not checked live yet: the IPAWS archive (only asked for in the 7- and
    30-day views) and most other cities' feeds. Each source is isolated, so
    one that fails shows red in "Source status" while the rest keep working.
- **Background registry alerts** are covered by tests (sign-up, the
  15-minute check, capped answers, Iowa's limit, the secret). They haven't
  been seen arriving on a real phone yet.
- **Not built yet:** push for reports other than the registry, a database for
  community reports and corrections (they stay on the device for now), SMS
  for the check-in timer, the native iOS/Android app, Spanish UI.

## Licenses and terms to check before launch

- Maps: OpenFreeMap vector tiles (free, no key, commercial use allowed)
  drawn with MapLibre, in three styles picked under Layers.
  - **Night** (default): OpenFreeMap's Dark (Dark Matter, BSD-3 code, design
    CC-BY 3.0 CARTO), recolored so streets and names read on a phone. It
    adds police, fire, hospital and school icons in gold, other places,
    house numbers and highway shields from OSM Liberty (BSD-3).
  - **Streets**: OpenFreeMap's hosted Liberty style.
  - **Satellite**: USGS The National Map aerial imagery (public domain, US
    only) with street names.

  Keep the credits the map shows ("OpenFreeMap © OpenMapTiles Data from
  OpenStreetMap", "Style © CARTO", "USGS The National Map"). The upstream
  license texts are in `scripts/map-styles/NOTICE.md`. OpenFreeMap runs on
  donations; for heavy traffic, self-host the tiles or pay a tile host.
- OpenStreetMap data (plate cameras, place names) is ODbL: keep the
  "© OpenStreetMap contributors" credit. Use a private Overpass server at
  scale.
- City feed list: built from OpenPoliceData (BSD-3 license; notice kept in
  `data/city-feeds.json`). Each city's portal has its own terms; most are
  public-domain or open licenses.
- News pictures belong to their publishers. Vigil shows them the way link
  previews do: loaded from the publisher, credited, linked to the article,
  never copied. If a publisher objects, add its domain to a block list.
- Google News RSS has no published license for apps. GDELT allows commercial
  use with attribution. A licensed news API is the safer long-term choice.
- X: the free official-account posts use X's embed widget, which falls under
  X's Developer Agreement. Vigil never scrapes X; X's terms forbid it.
  Before launch, open each handle in `data/x-accounts.js` marked
  `checked: 'known'` on x.com and confirm the grey government check.
- X search (optional): pay-per-use developer API; check its terms on
  display, deletions and commercial use.
- Nominatim (place search) allows about 1 request per second. Heavy use needs
  a hosted geocoder.
- Sex offender registry:
  - **On the map** (`lib/sources/registry.js`, `GET /api/registry`): only
    registries that let apps read their data.
    - Iowa's data API: stay under 50 requests an hour, never cache
      coordinates, keep nothing over 14 days. Vigil asks Iowa on every
      request, sends `Cache-Control: no-store` and caps itself at 45 an hour
      per server. Busy use needs Iowa DPS's OK for a higher limit.
    - Tennessee's TBI map service (no published license; TBI asked for
      credit).
    - DC open data (CC BY 4.0, block-level; names, class and whether the
      block is a home or work location, but no offenses).
    - Missouri State Highway Patrol's public registry map service (NSOR
      layer 7): one geocoded point per registered home, work, school or
      temporary address, updated daily. No license is published; the
      Patrol publishes the layer for its own public map. Confirming with
      mosor@mshp.dps.mo.gov would be prudent.
  - **Everywhere else**: a link to the official registry for every state,
    DC and territory (`data/registries.js`, from the DOJ's list), plus the
    national NSOPW search. NSOPW and most state sites forbid automated
    collection; Michigan says its list isn't available for download.
    Recheck the four entries marked `checked: false`.
  - **Every state on the map** needs a licensed provider whose contract
    allows public display; standard API licenses are internal-use only.
    Offenders.io's terms allow showing results to users but forbid
    replicating its registry, so a nationwide map needs written enterprise
    terms first.
  - **Next free candidates** (October 2026 research, terms from search
    snippets; confirm with each agency before building):
    - Florida FDLE public data file: CSV with an automatic-download URL,
      updated about every 4 hours. It has addresses but maybe no
      coordinates, so it may need geocoding (US Census batch geocoder) and
      storage. Show FDLE's two recommended warnings.
    - Texas DPS export: free, any purpose, needs an account, about 15 MB
      twice a week. Ask DPS whether a script may download it.
    - Georgia GBI data download: free; terms silent; format unknown.
    - Chicago Police (Socrata `vc9r-bqvy`): block addresses only; the city
      requires a disclaimer.
    - Paid: Hawaii ($100 a download), Montana ($550 a request), Arkansas
      (subscription plus 10 cents a record).
    - Forbidden or commercial use barred: Arizona, Mississippi, Washington,
      Vermont, Pennsylvania, California, Nevada, New Jersey. Michigan has no
      download.
  - The federal warning (34 U.S.C. §20920) is shown on every record. Some
    states restrict use for jobs, housing, loans and insurance (CA Penal
    Code 290.46, NV NRS 179B, NJ 2C:7-16); the app is not a background check.
  - "Newly listed" alerts compare against listing IDs (IDs only, dropped 14
    days after last seen): on the phone while the app is open, and in the
    alerts database with the app closed (see "Registry alerts with the app
    closed").
  - Field names in the readers were checked against each registry's live
    data in October 2026.
