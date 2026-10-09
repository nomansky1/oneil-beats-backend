'use strict';

// Canned upstream responses for tests and `npm run dev:fixtures`.
// Shapes follow each provider's documented format; contents are invented
// (Muskegon, MI area) and timestamps are relative to "now".
const minsAgo = (m) => new Date(Date.now() - m * 60000);
const iso = (m) => minsAgo(m).toISOString();
const rfc822 = (m) => minsAgo(m).toUTCString();
const gdelt = (m) => minsAgo(m).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Muskegon, MI unless the point is in one of the registry test cities.
const nominatimReverse = (url = '') => {
  const lat = Number((/[?&]lat=([-\d.]+)/.exec(url) || [])[1]);
  if (lat > 41 && lat < 42) return { address: { city: 'Des Moines', county: 'Polk County', state: 'Iowa', 'ISO3166-2-lvl4': 'US-IA', country_code: 'us' } };
  if (lat > 36 && lat < 37) return { address: { city: 'Nashville', county: 'Davidson County', state: 'Tennessee', 'ISO3166-2-lvl4': 'US-TN', country_code: 'us' } };
  if (lat > 38.8 && lat < 39) return { address: { city: 'Washington', state: 'District of Columbia', 'ISO3166-2-lvl4': 'US-DC', country_code: 'us' } };
  return { address: { city: 'Muskegon', county: 'Muskegon County', state: 'Michigan', 'ISO3166-2-lvl4': 'US-MI', country_code: 'us' } };
};

const nominatimSearch = () => ([
  { lat: '43.2342', lon: '-86.2484', name: 'Muskegon', display_name: 'Muskegon, Muskegon County, Michigan, United States', address: { city: 'Muskegon', state: 'Michigan', 'ISO3166-2-lvl4': 'US-MI', country_code: 'us' } },
  { lat: '18.4655', lon: '-66.1057', name: 'San Juan', display_name: 'San Juan, Puerto Rico', address: { city: 'San Juan', country_code: 'pr' } },
]);

const nwsAlerts = () => ({
  type: 'FeatureCollection',
  features: [
    {
      id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.fixture1',
      geometry: { type: 'Polygon', coordinates: [[[-86.4, 43.1], [-86.0, 43.1], [-86.0, 43.4], [-86.4, 43.4], [-86.4, 43.1]]] },
      properties: {
        id: 'urn:oid:2.49.0.1.840.0.fixture1', areaDesc: 'Muskegon, MI; Ottawa, MI', sent: iso(14), effective: iso(14), expires: iso(-40), ends: iso(-40),
        severity: 'Severe', event: 'Severe Thunderstorm Warning', senderName: 'NWS Grand Rapids MI',
        headline: 'Severe Thunderstorm Warning issued for Muskegon County until 9:15 PM EDT',
        description: '60 mph wind gusts and quarter size hail.', instruction: 'Move to an interior room on the lowest floor of a building.',
      },
    },
    {
      id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.fixture2',
      geometry: null,
      properties: {
        id: 'urn:oid:2.49.0.1.840.0.fixture2', areaDesc: 'Muskegon, MI', sent: iso(30), expires: iso(-300), severity: 'Severe',
        event: 'Child Abduction Emergency', senderName: 'Michigan State Police via NWS Grand Rapids MI',
        headline: 'AMBER Alert (fixture)', description: 'Fixture text.', instruction: '',
      },
    },
  ],
});

const usgs = () => ({
  type: 'FeatureCollection',
  features: [{
    id: 'us7000fixture', geometry: { type: 'Point', coordinates: [-86.6, 43.5, 8.2] },
    properties: { mag: 2.6, place: '25 km NW of Muskegon, Michigan', time: minsAgo(200).getTime(), updated: minsAgo(150).getTime(), url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000fixture', title: 'M 2.6 - 25 km NW of Muskegon, Michigan', status: 'reviewed', tsunami: 0 },
  }],
});

const fema = () => ({
  DisasterDeclarationsSummaries: [
    { disasterNumber: 9999, state: 'MI', declarationType: 'DR', declarationDate: iso(60 * 24 * 20), incidentType: 'Severe Storm', declarationTitle: 'SEVERE STORMS AND FLOODING', designatedArea: 'Muskegon (County)', incidentEndDate: null },
    { disasterNumber: 9999, state: 'MI', declarationType: 'DR', declarationDate: iso(60 * 24 * 20), incidentType: 'Severe Storm', declarationTitle: 'SEVERE STORMS AND FLOODING', designatedArea: 'Ottawa (County)', incidentEndDate: null },
    { disasterNumber: 9998, state: 'MI', declarationType: 'EM', declarationDate: iso(60 * 24 * 40), incidentType: 'Fire', declarationTitle: 'WILDFIRE', designatedArea: 'Kent (County)', incidentEndDate: null },
  ],
});

const googleNews = () => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>fixture</title>
<item><title>Man hospitalized after overnight stabbing in Muskegon, police say - MLive.com</title><link>https://news.google.com/rss/articles/fixture-a</link><pubDate>${rfc822(300)}</pubDate><source url="https://www.mlive.com">MLive.com</source></item>
<item><title>Muskegon police investigate overnight stabbing; man hospitalized - WZZM13.com</title><link>https://news.google.com/rss/articles/fixture-b</link><pubDate>${rfc822(260)}</pubDate><source url="https://www.wzzm13.com">WZZM13.com</source></item>
<item><title><![CDATA[Crash closes US-31 ramp near Muskegon &amp; Norton Shores - WOOD TV8]]></title><link>https://news.google.com/rss/articles/fixture-c</link><pubDate>${rfc822(90)}</pubDate><source url="https://www.woodtv.com">WOOD TV8</source></item>
<item><title>Muskegon city commission approves new park budget - Example Blog</title><link>https://news.google.com/rss/articles/fixture-d</link><pubDate>${rfc822(120)}</pubDate><source url="https://example-blog.net">Example Blog</source></item>
</channel></rss>`;

const gdeltDoc = () => ({
  articles: [
    { url: 'https://fox17online.com/news/fixture-stabbing', title: 'Police: Man stabbed overnight in Muskegon, hospitalized', seendate: gdelt(240), domain: 'fox17online.com', language: 'English', sourcecountry: 'United States', socialimage: 'https://fox17online.com/img/fixture-stabbing.jpg' },
  ],
});

const seattleFire = () => ([
  { address: '3rd Ave / Pine St', type: 'Aid Response', datetime: new Date(Date.now() - 10 * 60000 - 7 * 3600e3).toISOString().slice(0, 19), latitude: '47.6105', longitude: '-122.3381', incident_number: 'F260000001' },
]);

const overpass = () => ({
  elements: [
    { type: 'node', id: 1001, lat: 43.2300, lon: -86.2400, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', manufacturer: 'Flock Safety', operator: 'Fixture Police Department', direction: '90' } },
    { type: 'node', id: 1002, lat: 43.2250, lon: -86.2550, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', brand: 'Flock Safety', 'camera:direction': '315;135' } },
    { type: 'node', id: 1003, lat: 43.5000, lon: -86.9000, tags: { 'surveillance:type': 'ALPR' } },
  ],
});

// Mesa, AZ (Socrata): floating local time, Arizona has no DST (UTC-7).
const mesaCalls = () => ([
  { event_number: 'M26000001', call_type: 'SHOTS FIRED', received_date_time: new Date(Date.now() - 12 * 60000 - 7 * 3600e3).toISOString().slice(0, 23), address: '100 BLOCK W MAIN ST', latitude: '33.4152', longitude: '-111.8315' },
  { event_number: 'M26000002', call_type: 'WELFARE CHECK', received_date_time: new Date(Date.now() - 40 * 60000 - 7 * 3600e3).toISOString().slice(0, 23), address: '', location_1: { type: 'Point', coordinates: [-111.8200, 33.4200] } },
  { event_number: 'M26000003', call_type: 'ALARM', received_date_time: new Date(Date.now() - 50 * 60000 - 7 * 3600e3).toISOString().slice(0, 23), address: 'UNKNOWN' },
]);

// Gilbert, AZ (ArcGIS GeoJSON): dates come back as epoch milliseconds.
const gilbertCalls = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-111.7890, 33.3528] }, properties: { OBJECTID: 77, EventDate: minsAgo(25).getTime(), CallType: 'TRAFFIC ACCIDENT INJURY', Block: '300 N GILBERT RD' } },
    { type: 'Feature', geometry: null, properties: { OBJECTID: 78, EventDate: minsAgo(30).getTime(), CallType: 'THEFT' } },
  ],
});

// NIFC WFIGS current incidents (GeoJSON, outSR 4326).
const wfigs = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-86.0100, 43.4400] }, properties: { IrwinID: '{FIXTURE-1}', IncidentName: 'Fixture Ridge', IncidentSize: 2350.4, PercentContained: 15, FireDiscoveryDateTime: minsAgo(60 * 30).getTime(), ModifiedOnDateTime_dt: minsAgo(45).getTime(), POOState: 'US-MI', POOCounty: 'Newaygo', FireCause: 'Undetermined', IncidentTypeCategory: 'WF' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-86.3000, 43.2000] }, properties: { IrwinID: '{FIXTURE-2}', IncidentName: 'Dune Road Fire', IncidentSize: 0.3, PercentContained: 100, FireDiscoveryDateTime: minsAgo(300).getTime(), ModifiedOnDateTime_dt: minsAgo(120).getTime(), POOState: 'US-MI', POOCounty: 'Muskegon', IncidentTypeCategory: 'WF' } },
  ],
});

// NASA FIRMS area CSV (VIIRS columns).
const firmsCsv = () => {
  const d = minsAgo(90);
  const date = d.toISOString().slice(0, 10);
  const hhmm = d.toISOString().slice(11, 16).replace(':', '');
  return [
    'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
    `43.4410,-86.0120,345.1,0.39,0.36,${date},${hhmm},N,VIIRS,h,2.0NRT,295.2,18.4,D`,
    `43.4420,-86.0110,338.9,0.39,0.36,${date},${hhmm},N,VIIRS,n,2.0NRT,293.0,9.1,D`,
    `43.3000,-86.5000,301.0,0.39,0.36,${date},${hhmm},N,VIIRS,l,2.0NRT,290.0,1.2,D`,
  ].join('\n');
};

// OpenFEMA IPAWS archive. One alert covers Muskegon, one does not, one was
// cancelled. FEMA has used both "info" and "infos" for the nested list.
const ipaws = () => ({
  IpawsArchivedAlerts: [
    {
      identifier: 'urn:oid:fixture.ipaws.1', sender: 'w-nws.webmaster@noaa.gov', sent: iso(60 * 30), status: 'Actual', msgType: 'Alert',
      searchGeometry: { type: 'Polygon', coordinates: [[[-86.5, 43.0], [-86.0, 43.0], [-86.0, 43.5], [-86.5, 43.5], [-86.5, 43.0]]] },
      info: [{ language: 'en-US', event: 'Flood Warning', severity: 'Severe', senderName: 'NWS Grand Rapids MI', headline: 'Flood Warning for the Muskegon River', description: 'Minor flooding is occurring.', area: [{ areaDesc: 'Muskegon, MI' }] }],
    },
    {
      identifier: 'urn:oid:fixture.ipaws.2', sent: iso(60 * 40), status: 'Actual', msgType: 'Alert',
      searchGeometry: { type: 'Polygon', coordinates: [[[-85.0, 42.0], [-84.5, 42.0], [-84.5, 42.5], [-85.0, 42.5], [-85.0, 42.0]]] },
      infos: [{ event: 'Boil Water Notice', severity: 'Moderate', senderName: 'Elsewhere County', areas: [{ areaDesc: 'Elsewhere, MI' }] }],
    },
    {
      identifier: 'urn:oid:fixture.ipaws.3', sent: iso(60 * 35), status: 'Actual', msgType: 'Cancel',
      infos: [{ event: 'Evacuation Immediate', severity: 'Extreme', areas: [{ areaDesc: 'Muskegon, MI' }] }],
    },
    {
      identifier: 'urn:oid:fixture.ipaws.4', sent: iso(60 * 50), status: 'Actual', msgType: 'Alert',
      infos: [{ event: 'Shelter In Place Warning', severity: 'Extreme', senderName: 'Muskegon County Emergency Management', headline: 'Chemical release near the harbor', areas: [{ areaDesc: 'Muskegon County, MI' }] }],
    },
  ],
});

// A publisher article page with a share image (relative URL, escaped &).
const articlePage = () => `<!doctype html><html><head><title>Fixture</title>
<meta name="twitter:image" content="https://cdn.example-station.com/tw.jpg">
<meta content="/img/story.jpg?w=1200&amp;h=630" property="og:image">
</head><body>Story</body></html>`;

// Registry fixtures. Invented test records, not real people.
const iowaRegistry = () => ({
  records: [
    { registrant: '90001', first_name: 'Test', last_name: 'Registrant A', photo: 'https://www.iowasexoffender.gov/images/photos/90001.jpg', lat: 41.5900, lon: -93.6200, address: '100 Example St', city: 'Des Moines', state: 'IA', tier: 'Tier II', convictions: [{ conviction: 'Fixture offense one', conviction_date: '01/02/2003', iowa_code: '000.1' }, { conviction: 'Fixture offense two', conviction_date: '03/04/2005', iowa_code: '000.2' }], last_changed: '10/01/2026' },
    { registrant: '90002', name: 'Test Registrant B', photo: 'http://insecure.example/b.jpg', lat: '41.6000', lon: '-93.6100', city: 'Des Moines' },
    { registrant: '90003', name: 'Test Registrant Far', lat: 42.5, lon: -93.0 },
  ],
});

const tennesseeRegistry = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-86.7810, 36.1630] }, properties: { OBJECTID: 7, Tid: '00900001', FirstName: 'Test', LastName: 'Registrant C', ResAddr1: '200 Fixture Ave', ResCity: 'Nashville', ResState: 'TN', OffenseDate: '01/02/2003', Tca1: '01/02/2003  Fixture offense three', Tca2: '', tcacode1: '00-00-000', Classification: 'SEXUAL', Imagefile: '' } },
  ],
});

const dcRegistry = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-77.0300, 38.9000] }, properties: { OBJECTID: 5, LASTNAME: 'Registrant D', FIRSTNAME: 'Test', BLOCKNAME: '1200 BLOCK OF FIXTURE ST NW', SEXOFFENDERCODE: '000-001', MAXCLASSIFICATION: 'A', TYPE: 'HOME' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-77.0310, 38.9010] }, properties: { OBJECTID: 6, LASTNAME: 'Registrant E', FIRSTNAME: 'Test', BLOCKNAME: '1300 BLOCK OF FIXTURE ST NW', SEXOFFENDERCODE: '000-002', MAXCLASSIFICATION: 'B', TYPE: 'WORK' } },
  ],
});

// Iowa Environmental Mesonet local storm reports (GeoJSON).
const lsr = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-86.2300, 43.2500] }, properties: { valid: iso(70).slice(0, 19) + 'Z', type: 'D', typetext: 'TSTM WND DMG', magnitude: 'None', unit: '', city: 'MUSKEGON', county: 'MUSKEGON', state: 'MI', source: 'LAW ENFORCEMENT', remark: 'Large tree down on Fixture St blocking both lanes.', wfo: 'GRR', product_id: '202610081900-KGRR-NWUS53-LSRGRR' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-86.1000, 43.3000] }, properties: { valid: iso(95).slice(0, 19) + 'Z', type: 'H', typetext: 'HAIL', magnitude: '1.00', unit: 'INCH', city: '2 N FIXTURE', county: 'MUSKEGON', state: 'MI', source: 'PUBLIC', remark: '', wfo: 'GRR', product_id: '202610081830-KGRR-NWUS53-LSRGRR' } },
    // The real feed ignores the area and returns the whole country.
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-155.0800, 19.7200] }, properties: { valid: iso(50).slice(0, 19) + 'Z', type: 'H', typetext: 'HAIL', magnitude: '0.75', unit: 'INCH', city: 'HILO', county: 'HAWAII', state: 'HI', source: 'PUBLIC', remark: '', wfo: 'HFO', product_id: '202610081900-PHFO-NWUS52-LSRHFO' } },
  ],
});

// Bluesky searchPosts. Invented accounts and posts.
const bskyPost = (n, handle, text, mins) => ({ uri: `at://did:plc:fixture${n}/app.bsky.feed.post/3kfix${n}`, author: { did: `did:plc:fixture${n}`, handle, displayName: handle.split('.')[0] }, record: { text, createdAt: iso(mins) }, indexedAt: iso(mins) });
const bluesky = () => ({
  posts: [
    bskyPost(1, 'police.muskegon-mi.gov', 'Muskegon police: road closed at Fixture St and 3rd for a crash investigation. Avoid the area.', 40),
    bskyPost(2, 'someone.bsky.social', 'Huge fire on the east side of Muskegon, MI right now, smoke everywhere', 25),
    bskyPost(3, 'elsewhere.bsky.social', 'Muskegon is lovely this time of year', 15),
    bskyPost(4, 'other.bsky.social', 'Shooting reported in Muskegon Heights? anyone know', 10),
  ],
});

// URL -> body. Order matters; first match wins.
const ROUTES = [
  [/mesonet\.agron\.iastate\.edu\/geojson\/lsr\.geojson/, lsr],
  [/api\.bsky\.app\/xrpc\/app\.bsky\.feed\.searchPosts/, bluesky],
  [/nominatim\.openstreetmap\.org\/reverse/, nominatimReverse],
  [/nominatim\.openstreetmap\.org\/search/, nominatimSearch],
  [/api\.weather\.gov\/alerts/, nwsAlerts],
  [/earthquake\.usgs\.gov/, usgs],
  [/fema\.gov\/api\/open\/v1\/IpawsArchivedAlerts/, ipaws],
  [/fema\.gov\/api\/open/, fema],
  [/WFIGS_Incident_Locations_Current/, wfigs],
  [/firms\.modaps\.eosdis\.nasa\.gov\/api\/area/, firmsCsv],
  [/data\.mesaaz\.gov\/resource\/izhu-764k/, mesaCalls],
  [/maps\.gilbertaz\.gov\/arcgis/, gilbertCalls],
  [/news\.google\.com\/rss/, googleNews],
  [/api\.gdeltproject\.org/, gdeltDoc],
  [/data\.seattle\.gov/, seattleFire],
  [/overpass-api\.de\/api\/interpreter/, overpass],
  [/www\.example-station\.com\/news\//, articlePage],
  [/iowasexoffender\.gov\/api\/search\/results\.json/, iowaRegistry],
  [/TBI_SEX_OFFENDER_REGISTRY\/MapServer\/0\/query/, tennesseeRegistry],
  [/FEEDS\/MPD\/MapServer\/20\/query/, dcRegistry],
];

module.exports = { ROUTES, lsr, bluesky, articlePage, iowaRegistry, tennesseeRegistry, dcRegistry, overpass, mesaCalls, gilbertCalls, wfigs, firmsCsv, ipaws, nominatimReverse, nwsAlerts, usgs, fema, googleNews, gdeltDoc, seattleFire };
