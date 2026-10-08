'use strict';

const { fetchJson } = require('./http');

const TERRITORY_CODES = { pr: 'PR', gu: 'GU', vi: 'VI', as: 'AS', mp: 'MP' };
const COUNTRY_CODES = 'us,pr,gu,vi,as,mp';

function stateCodeOf(address = {}) {
  const iso = address['ISO3166-2-lvl4'] || address['ISO3166-2-lvl3'] || '';
  if (/^US-[A-Z]{2}$/.test(iso)) return iso.slice(3);
  return TERRITORY_CODES[address.country_code] || null;
}

// Reverse-geocode a point to the names we need for news queries and FEMA
// filters. Cached for a day per ~1 km cell.
async function placeFor({ lat, lon }) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
  const data = await fetchJson(url, { ttl: 86400 });
  const a = data.address || {};
  const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || '';
  const county = (a.county || '').replace(/\s+(County|Parish|Borough|Municipio|Municipality)$/i, '');
  const state = stateCodeOf(a);
  return {
    city,
    county,
    state,
    stateName: a.state || a.country || '',
    label: [city, state].filter(Boolean).join(', '),
  };
}

async function searchPlaces(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=${COUNTRY_CODES}&q=${encodeURIComponent(q)}`;
  const rows = await fetchJson(url, { ttl: 86400 });
  return rows.map((r) => {
    const a = r.address || {};
    const name = a.city || a.town || a.village || a.hamlet || a.county || r.name || '';
    const state = stateCodeOf(a);
    return {
      label: [name, state].filter(Boolean).join(', ') || r.display_name,
      detail: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
    };
  });
}

module.exports = { placeFor, searchPlaces, stateCodeOf, COUNTRY_CODES };
