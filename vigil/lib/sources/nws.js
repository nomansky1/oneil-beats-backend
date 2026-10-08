'use strict';

// National Weather Service alerts. Besides weather, NWS relays non-weather
// emergency alerts issued through IPAWS (AMBER alerts, law enforcement
// warnings, evacuation orders), and it covers PR, USVI, Guam, American Samoa
// and the Northern Mariana Islands. https://www.weather.gov/documentation/services-web-api
const { fetchJson } = require('../http');
const { centroid } = require('../geo');

const SEVERITY = { Extreme: 3, Severe: 2, Moderate: 1, Minor: 1, Unknown: 1 };

function categoryFor(event) {
  if (/child abduction/i.test(event)) return 'missing';
  if (/law enforcement|civil danger|civil emergency/i.test(event)) return 'crime';
  if (/evacuation|shelter in place|hazardous materials|nuclear|radiological|911 telephone|local area emergency|boil water/i.test(event)) return 'hazard';
  if (/fire warning|red flag|fire weather/i.test(event)) return 'fire';
  return 'weather';
}

function normalize(feature, fallback) {
  const p = feature.properties || {};
  const at = centroid(feature.geometry) || fallback;
  const category = categoryFor(p.event || '');
  let severity = SEVERITY[p.severity] || 1;
  if (category !== 'weather' && /warning|emergency|immediate/i.test(p.event || '')) severity = 3;
  return {
    id: `nws:${p.id || feature.id}`,
    kind: 'area',
    category,
    severity,
    title: p.event || 'Weather alert',
    summary: p.headline || '',
    details: [p.description, p.instruction].filter(Boolean).join('\n\n'),
    lat: at ? at.lat : null,
    lon: at ? at.lon : null,
    precision: 'area',
    place: p.areaDesc || '',
    time: p.sent || p.effective,
    expires: p.ends || p.expires || null,
    sources: [{
      name: p.senderName || 'National Weather Service',
      kind: 'official',
      tier: 'gov',
      url: feature.id || p['@id'] || 'https://alerts.weather.gov',
      time: p.sent,
    }],
    confirmed: [p.headline].filter(Boolean),
    unconfirmed: [],
  };
}

async function alertsNear({ lat, lon }) {
  const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
  const data = await fetchJson(url, { headers: { Accept: 'application/geo+json' }, ttl: 60 });
  return (data.features || []).map((f) => normalize(f, { lat, lon }));
}

async function severeNationwide() {
  const url = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&severity=Extreme,Severe';
  const data = await fetchJson(url, { headers: { Accept: 'application/geo+json' }, ttl: 120 });
  return (data.features || []).map((f) => normalize(f, null));
}

module.exports = { alertsNear, severeNationwide, normalize, categoryFor };
