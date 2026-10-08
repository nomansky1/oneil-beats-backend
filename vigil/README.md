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
| `lib/og-image.js` | Finds an article's own share picture (the link-preview image) for news stories. |
| `data/city-feeds.json` | 46 police calls-for-service and incident feeds in 35 places, generated from OpenPoliceData. |
| `data/sample.js` | **Invented** sample events for the offline phone preview only. |
| `public/map-style.json` | Dark street-map style for OpenFreeMap vector tiles (`npm run build:style`). |
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
| License plate cameras (OpenStreetMap) | Flock and other plate readers mapped by volunteers, with vendor, operator and direction. A map layer, not incidents. | 6 hours | As fast as volunteers map them | Not rated |
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
npm test                 # 24 tests: parsers, truth meter, every source adapter, API
npm run dev              # http://localhost:3000 with live upstream data
npm run dev:fixtures     # same, with canned upstream data (no network)
npm run build:preview    # writes preview/vigil-preview.html
npm run build:style      # rewrites public/map-style.json
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

## Put it live (needs the owner's OK)

1. Create a new Vercel project from this repo and set **Root Directory** to
   `vigil`. Framework preset: Other. No build command.
2. Add `VIGIL_CONTACT` (and `X_BEARER_TOKEN` if you want X).
3. Deploy. Open the URL on your phone and use "Add to Home Screen".

Responses are cached at Vercel's edge for 60 seconds per ~1 km area, so cost
grows with the number of places people watch rather than the number of
people watching them.

## What's verified and what isn't

- **Tested here:** all 24 unit/API tests pass; the app was driven in a
  headless phone-size browser (360 and 390 px wide) against the local server
  (fixture data, with the MapLibre street map loading) and against the
  preview build, with no script errors.
- **Not tested against the real upstream services.** The build environment
  could not reach api.weather.gov, USGS, FEMA, NIFC, NASA FIRMS, Google News,
  GDELT, the city data portals, OpenStreetMap, OpenFreeMap or X. Each adapter
  follows the provider's documented format and is isolated, so if one is
  wrong it shows red in "Source status" while the others keep working. Check
  that panel on the first real deploy. Most likely to need a fix:
  - City feeds: each city names its columns differently. The reader finds
    type, address and coordinates by name and skips rows without
    coordinates. Some cities may show zero items until mapped by hand.
  - ArcGIS date filters (`TIMESTAMP '…'`) are not accepted by every server.
  - FEMA's IPAWS archive: the point-in-area filter and coordinate order are
    from FEMA's docs; a local polygon check backs it up.
  - Publisher sites may block the share-image lookup; those stories just
    have no picture.
- **Not built yet:** background push notifications, a database for
  community reports and corrections (they stay on the device for now), SMS
  for the check-in timer, the native iOS/Android app, Spanish UI.

## Licenses and terms to check before launch

- Map: OpenFreeMap vector tiles (free, no key, commercial use allowed) drawn
  with MapLibre. Keep the "OpenFreeMap © OpenMapTiles Data from
  OpenStreetMap" credit on the map. OpenFreeMap runs on donations; for heavy
  traffic, self-host the tiles or pay a tile host.
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
- Sex offender data: the app links to the official DOJ NSOPW search instead
  of copying records. NSOPW has no API and forbids automated searching.
  Republishing registry data has state-specific rules (for example CA Penal
  Code 290.46, NV NRS 179B, NJ 2C:7-16), and the federal warning in 34 U.S.C.
  §20920(f) must be shown. Showing registry records on the map is on hold
  until the owner picks a data source; see the PR description.
