'use strict';

// OpenFEMA disaster declarations — which counties are under a federal
// disaster or emergency declaration right now. https://www.fema.gov/about/openfema/api
const { fetchJson } = require('../http');

const TYPE = { DR: 'Major disaster declaration', EM: 'Emergency declaration', FM: 'Fire management assistance' };

function categoryFor(incidentType = '') {
  if (/fire/i.test(incidentType)) return 'fire';
  if (/flood|hurricane|storm|tornado|typhoon|snow|winter|ice|coastal/i.test(incidentType)) return 'weather';
  if (/earthquake/i.test(incidentType)) return 'quake';
  return 'hazard';
}

function normalize(d, center) {
  return {
    id: `fema:${d.disasterNumber}`,
    kind: 'area',
    category: categoryFor(d.incidentType),
    severity: d.declarationType === 'DR' ? 2 : 1,
    title: `${TYPE[d.declarationType] || 'Federal declaration'}: ${d.incidentType || 'Disaster'}`,
    summary: d.declarationTitle || '',
    details: `FEMA disaster ${d.disasterNumber}. Federal help may be available — see the FEMA page for this disaster.`,
    lat: center.lat,
    lon: center.lon,
    precision: 'area',
    place: d.designatedArea ? `${d.designatedArea}, ${d.state}` : d.state,
    time: d.declarationDate,
    sources: [{ name: 'FEMA', kind: 'official', tier: 'gov', url: `https://www.fema.gov/disaster/${d.disasterNumber}`, time: d.declarationDate }],
    confirmed: [d.declarationTitle].filter(Boolean),
    unconfirmed: [],
  };
}

// Declarations from the last 120 days whose incident hasn't ended, limited to
// the viewer's county (or statewide designations).
async function declarationsFor(place, center) {
  if (!place.state) return [];
  const since = new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10);
  const filter = encodeURIComponent(`state eq '${place.state}' and declarationDate ge '${since}'`);
  const url = `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=${filter}&$orderby=declarationDate%20desc&$top=200`;
  const data = await fetchJson(url, { ttl: 900 });
  const rows = data.DisasterDeclarationsSummaries || [];
  const county = (place.county || '').toLowerCase();
  const seen = new Set();
  return rows
    .filter((d) => !d.incidentEndDate || new Date(d.incidentEndDate) > Date.now())
    .filter((d) => {
      const area = (d.designatedArea || '').toLowerCase();
      return area.includes('statewide') || (county && area.startsWith(county));
    })
    .filter((d) => (seen.has(d.disasterNumber) ? false : seen.add(d.disasterNumber)))
    .map((d) => normalize(d, center));
}

module.exports = { declarationsFor, normalize };
