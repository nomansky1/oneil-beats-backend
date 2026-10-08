'use strict';

// USGS earthquake catalog (FDSN event service). Covers all states and the
// Caribbean and Pacific territories. https://earthquake.usgs.gov/fdsnws/event/1/
const { fetchJson } = require('../http');

function normalize(feature) {
  const p = feature.properties || {};
  const [lon, lat, depthKm] = feature.geometry ? feature.geometry.coordinates : [];
  const mag = typeof p.mag === 'number' ? p.mag : null;
  const severity = mag >= 6 ? 3 : mag >= 4.5 ? 2 : 1;
  const magText = mag === null ? '' : `M${mag.toFixed(1)} `;
  return {
    id: `usgs:${feature.id}`,
    kind: 'incident',
    category: 'quake',
    severity,
    title: `${magText}earthquake`,
    summary: p.place ? `${magText}earthquake ${p.place}` : p.title || '',
    details: depthKm != null ? `Depth ${Number(depthKm).toFixed(1)} km. ${p.tsunami ? 'NOAA tsunami flag set — check tsunami.gov.' : ''}`.trim() : '',
    lat,
    lon,
    precision: 'exact',
    place: p.place || '',
    time: p.time ? new Date(p.time).toISOString() : null,
    sources: [{ name: 'U.S. Geological Survey', kind: 'official', tier: 'gov', url: p.url || 'https://earthquake.usgs.gov', time: p.updated ? new Date(p.updated).toISOString() : null }],
    confirmed: [p.title].filter(Boolean),
    unconfirmed: p.status === 'automatic' ? ['Magnitude and location are automatic estimates and may be revised by a seismologist'] : [],
    magnitude: mag,
  };
}

async function quakesNear({ lat, lon }, radiusMi, hours) {
  // Quakes are felt far away, so look at least 100 miles out.
  const km = Math.max(radiusMi, 100) * 1.609;
  const start = new Date(Date.now() - hours * 3600e3).toISOString().slice(0, 19);
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&limit=50&minmagnitude=2&latitude=${lat}&longitude=${lon}&maxradiuskm=${Math.round(km)}&starttime=${start}`;
  const data = await fetchJson(url, { ttl: 60 });
  return (data.features || []).map(normalize);
}

const US_PLACE = /(,\s*(?:[A-Z]{2}|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)$)|Puerto Rico|Virgin Islands|Guam|Northern Mariana|American Samoa|Alaska|Hawaii/;

async function significantNationwide() {
  const data = await fetchJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson', { ttl: 120 });
  return (data.features || []).filter((f) => US_PLACE.test((f.properties || {}).place || '')).map(normalize);
}

module.exports = { quakesNear, significantNationwide, normalize, US_PLACE };
