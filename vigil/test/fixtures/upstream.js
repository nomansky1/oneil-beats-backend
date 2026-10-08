'use strict';

// Canned upstream responses for tests and `npm run dev:fixtures`.
// Shapes follow each provider's documented format; contents are invented
// (Muskegon, MI area) and timestamps are relative to "now".
const minsAgo = (m) => new Date(Date.now() - m * 60000);
const iso = (m) => minsAgo(m).toISOString();
const rfc822 = (m) => minsAgo(m).toUTCString();
const gdelt = (m) => minsAgo(m).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const nominatimReverse = () => ({
  address: { city: 'Muskegon', county: 'Muskegon County', state: 'Michigan', 'ISO3166-2-lvl4': 'US-MI', country_code: 'us' },
});

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
    { url: 'https://fox17online.com/news/fixture-stabbing', title: 'Police: Man stabbed overnight in Muskegon, hospitalized', seendate: gdelt(240), domain: 'fox17online.com', language: 'English', sourcecountry: 'United States' },
  ],
});

const seattleFire = () => ([
  { address: '3rd Ave / Pine St', type: 'Aid Response', datetime: new Date(Date.now() - 10 * 60000 - 7 * 3600e3).toISOString().slice(0, 19), latitude: '47.6105', longitude: '-122.3381', incident_number: 'F260000001' },
]);

// URL -> body. Order matters; first match wins.
const ROUTES = [
  [/nominatim\.openstreetmap\.org\/reverse/, nominatimReverse],
  [/nominatim\.openstreetmap\.org\/search/, nominatimSearch],
  [/api\.weather\.gov\/alerts/, nwsAlerts],
  [/earthquake\.usgs\.gov/, usgs],
  [/fema\.gov\/api\/open/, fema],
  [/news\.google\.com\/rss/, googleNews],
  [/api\.gdeltproject\.org/, gdeltDoc],
  [/data\.seattle\.gov/, seattleFire],
];

module.exports = { ROUTES, nominatimReverse, nwsAlerts, usgs, fema, googleNews, gdeltDoc, seattleFire };
