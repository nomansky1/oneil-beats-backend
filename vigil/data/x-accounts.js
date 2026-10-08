'use strict';

// Official agency accounts on X, shown with X's free embed (no API key, no
// X Premium, no cost). Vigil only links to and embeds these public posts;
// it never scrapes X, which X's terms forbid.
//
// `checked`: 'source' = handle confirmed from an official page (see `ref`);
// 'known' = long-standing agency account, still to be confirmed on x.com
// (grey government check) before launch. Add accounts the same way.
//
// Coverage is a circle ({ lat, lon, radiusMi }), a bounding box
// ({ bbox: [south, west, north, east] }) or 'national'.
module.exports = [
  { handle: 'NWS', name: 'National Weather Service', kind: 'weather', area: 'national', checked: 'known' },
  { handle: 'fema', name: 'FEMA', kind: 'emergency', area: 'national', checked: 'known' },
  { handle: 'USGS_Quakes', name: 'USGS Earthquakes', kind: 'quake', area: 'national', checked: 'source', ref: 'https://www.usgs.gov/news/follow-earthquake-tweets' },

  { handle: 'NWSGrandRapids', name: 'NWS Grand Rapids', kind: 'weather', area: { bbox: [41.7, -87.2, 44.6, -84.3] }, checked: 'known' },
  { handle: 'MichStatePolice', name: 'Michigan State Police', kind: 'police', area: { bbox: [41.7, -90.4, 48.3, -82.1] }, checked: 'known' },

  { handle: 'SeattlePD', name: 'Seattle Police', kind: 'police', area: { lat: 47.6062, lon: -122.3321, radiusMi: 15 }, checked: 'known' },
  { handle: 'SeattleFire', name: 'Seattle Fire', kind: 'fire', area: { lat: 47.6062, lon: -122.3321, radiusMi: 15 }, checked: 'known' },
  { handle: 'NWSSeattle', name: 'NWS Seattle', kind: 'weather', area: { lat: 47.6062, lon: -122.3321, radiusMi: 120 }, checked: 'known' },

  { handle: 'LAPDHQ', name: 'Los Angeles Police', kind: 'police', area: { lat: 34.0522, lon: -118.2437, radiusMi: 25 }, checked: 'known' },
  { handle: 'LAFD', name: 'Los Angeles Fire', kind: 'fire', area: { lat: 34.0522, lon: -118.2437, radiusMi: 25 }, checked: 'known' },
  { handle: 'NWSLosAngeles', name: 'NWS Los Angeles', kind: 'weather', area: { lat: 34.0522, lon: -118.2437, radiusMi: 100 }, checked: 'known' },

  { handle: 'Chicago_Police', name: 'Chicago Police', kind: 'police', area: { lat: 41.8781, lon: -87.6298, radiusMi: 20 }, checked: 'known' },
  { handle: 'CFDMedia', name: 'Chicago Fire Media', kind: 'fire', area: { lat: 41.8781, lon: -87.6298, radiusMi: 20 }, checked: 'known' },
  { handle: 'NWSChicago', name: 'NWS Chicago', kind: 'weather', area: { lat: 41.8781, lon: -87.6298, radiusMi: 80 }, checked: 'known' },

  { handle: 'NYPDnews', name: 'NYPD', kind: 'police', area: { lat: 40.7128, lon: -74.006, radiusMi: 20 }, checked: 'known' },
  { handle: 'FDNY', name: 'FDNY', kind: 'fire', area: { lat: 40.7128, lon: -74.006, radiusMi: 20 }, checked: 'known' },
  { handle: 'NotifyNYC', name: 'Notify NYC', kind: 'emergency', area: { lat: 40.7128, lon: -74.006, radiusMi: 20 }, checked: 'known' },
  { handle: 'NWSNewYorkNY', name: 'NWS New York', kind: 'weather', area: { lat: 40.7128, lon: -74.006, radiusMi: 60 }, checked: 'known' },

  { handle: 'houstonpolice', name: 'Houston Police', kind: 'police', area: { lat: 29.7604, lon: -95.3698, radiusMi: 25 }, checked: 'known' },
  { handle: 'HoustonFire', name: 'Houston Fire', kind: 'fire', area: { lat: 29.7604, lon: -95.3698, radiusMi: 25 }, checked: 'known' },
  { handle: 'NWSHouston', name: 'NWS Houston', kind: 'weather', area: { lat: 29.7604, lon: -95.3698, radiusMi: 100 }, checked: 'known' },

  { handle: 'NWSSanJuan', name: 'NWS San Juan', kind: 'weather', area: { bbox: [17.5, -67.6, 18.8, -64.3] }, checked: 'source', ref: 'https://2014-2017.commerce.gov/print/2507.html' },
  { handle: 'NWSHonolulu', name: 'NWS Honolulu', kind: 'weather', area: { bbox: [18.8, -160.6, 22.4, -154.7] }, checked: 'known' },
  { handle: 'NWSAnchorage', name: 'NWS Anchorage', kind: 'weather', area: { lat: 61.2181, lon: -149.9003, radiusMi: 250 }, checked: 'known' },
];
