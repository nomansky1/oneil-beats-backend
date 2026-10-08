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
| `lib/sources/` | One adapter per data source (below). |
| `lib/verify.js` | The truth meter: Official record / Corroborated / Single source / Unverified. |
| `lib/cluster.js` | Groups articles about the same event so a story shows "reported by 3 outlets". |
| `data/sample.js` | **Invented** sample events for the offline phone preview only. |
| `scripts/build-preview.js` | Builds `preview/vigil-preview.html`, the single-file preview. |
| `STRATEGY.md` | Citizen's gaps, Vigil's moats, roadmap, money. |

## Data sources (all free unless noted)

| Source | What it adds | Truth label |
| --- | --- | --- |
| National Weather Service alerts | Weather, plus AMBER alerts, law-enforcement warnings, evacuations relayed through IPAWS. Covers the territories. | Official |
| USGS earthquakes | Quakes near you, plus M4.5+ nationwide | Official |
| OpenFEMA | Active disaster declarations for your county | Official |
| City police and fire open data (Socrata) | Block-level dispatch calls and crime reports. Seattle Fire 911 (real time), SF Police, Chicago Police (7-day delay), NYPD (quarterly) to start. Add a city in `lib/sources/opendata.js`. | Official |
| Google News RSS + GDELT | Local news, clustered across outlets | Corroborated or Single source |
| X (paid, off by default) | Posts from police, fire and NWS accounts, often first. Government-verified accounts count as official. Everyone else is Unverified. | Official or Unverified |
| Community reports | What people nearby post in the app | Unverified until confirmed |

News articles rarely give an address, so stories sit at the city center and
say "City-level" instead of a guessed pin.

## Run it

```bash
cd vigil
npm install
npm test                 # 14 tests: parsers, truth meter, clustering, API
npm run dev              # http://localhost:3000 with live upstream data
npm run dev:fixtures     # same, with canned upstream data (no network)
npm run build:preview    # writes preview/vigil-preview.html
```

Environment variables:

| Name | Needed? | Purpose |
| --- | --- | --- |
| `VIGIL_CONTACT` | Yes, before going live | Email or URL sent in the User-Agent. NWS and OpenStreetMap require it. |
| `X_BEARER_TOKEN` | Optional | Turns on X posts. Billed per post read by X. |
| `X_CACHE_SECONDS` | Optional | How long X results are reused per city (default 120). |

## Put it live (needs the owner's OK)

1. Create a new Vercel project from this repo and set **Root Directory** to
   `vigil`. Framework preset: Other. No build command.
2. Add `VIGIL_CONTACT` (and `X_BEARER_TOKEN` if you want X).
3. Deploy. Open the URL on your phone and use "Add to Home Screen".

Responses are cached at Vercel's edge for 60 seconds per ~1 km area, so cost
grows with the number of places people watch rather than the number of
people watching them.

## What's verified and what isn't

- **Tested here:** all 14 unit/API tests pass; the app was driven in a
  headless phone-size browser against the local server (fixture data) and
  against the preview build, with no script errors.
- **Not tested against the real upstream services.** The build environment
  could not reach api.weather.gov, USGS, FEMA, Google News, GDELT, Socrata,
  OpenStreetMap or X. Each adapter follows the provider's documented format
  and is isolated, so if one is wrong it shows red in "Source status" while
  the others keep working. Check that panel on the first real deploy.
- **Not built yet:** background push notifications, a database for
  community reports and corrections (they stay on the device for now), SMS
  for the check-in timer, the native iOS/Android app, Spanish UI.

## Licenses and terms to check before launch

- Map tiles: CARTO's free basemaps are for non-commercial use. Switch to a
  paid plan (CARTO, MapTiler, Stadia) or self-hosted Protomaps before
  monetizing.
- Google News RSS has no published license for apps. GDELT allows commercial
  use with attribution. A licensed news API is the safer long-term choice.
- X: pay-per-use API; check its developer terms on display, deletions and
  commercial use.
- Nominatim (place search) allows about 1 request per second. Heavy use needs
  a hosted geocoder.
- Sex offender data: the app links to the official DOJ NSOPW search instead
  of copying records. Republishing registry data has state-specific rules.
