'use strict';

// City open-data feeds published by police and fire departments (Socrata
// SODA API). These are the most precise sources we have: dispatch type,
// block-level location and a timestamp straight from the agency.
//
// Each entry maps a dataset's columns onto our item shape. Add a city by
// adding an entry; nothing else changes. Coverage grows city by city — the
// README lists how to find more datasets.
const { fetchJson } = require('../http');
const { haversineMi } = require('../geo');
const { classify } = require('../classify');
const { zonedToUtc, utcToFloating } = require('../time');

const FEEDS = [
  {
    id: 'seattle-fire-911',
    label: 'Seattle Fire Dept. 911 dispatch',
    agency: 'Seattle Fire Department',
    url: 'https://data.seattle.gov/resource/kzjm-xkqj.json',
    tz: 'America/Los_Angeles',
    bbox: [47.48, -122.46, 47.74, -122.22],
    cols: { id: 'incident_number', time: 'datetime', type: 'type', lat: 'latitude', lon: 'longitude', address: 'address' },
    defaultCategory: 'fire',
    precision: 'block',
  },
  {
    id: 'sf-police-incidents',
    label: 'San Francisco Police incident reports',
    agency: 'San Francisco Police Department',
    url: 'https://data.sfgov.org/resource/wg3w-h783.json',
    tz: 'America/Los_Angeles',
    bbox: [37.70, -122.52, 37.83, -122.35],
    cols: { id: 'incident_id', time: 'incident_datetime', type: 'incident_category', desc: 'incident_description', lat: 'latitude', lon: 'longitude', address: 'intersection', area: 'analysis_neighborhood' },
    defaultCategory: 'crime',
    precision: 'block',
  },
  {
    id: 'chicago-crimes',
    label: 'Chicago Police crime reports (7-day delay)',
    agency: 'Chicago Police Department',
    url: 'https://data.cityofchicago.org/resource/ijzp-q8t2.json',
    tz: 'America/Chicago',
    bbox: [41.64, -87.94, 42.03, -87.52],
    cols: { id: 'case_number', time: 'date', type: 'primary_type', desc: 'description', lat: 'latitude', lon: 'longitude', address: 'block' },
    defaultCategory: 'crime',
    precision: 'block',
    minHours: 24 * 14, // published with a week's lag, so look further back
  },
  {
    id: 'nyc-nypd-complaints',
    label: 'NYPD complaint data (quarterly)',
    agency: 'New York City Police Department',
    url: 'https://data.cityofnewyork.us/resource/5uac-w243.json',
    tz: 'America/New_York',
    bbox: [40.49, -74.26, 40.92, -73.70],
    cols: { id: 'cmplnt_num', time: 'cmplnt_fr_dt', type: 'ofns_desc', desc: 'pd_desc', lat: 'latitude', lon: 'longitude', area: 'boro_nm' },
    defaultCategory: 'crime',
    precision: 'block',
    minHours: 24 * 120,
  },
];

function inBbox({ lat, lon }, [s, w, n, e], padDeg = 0.1) {
  return lat >= s - padDeg && lat <= n + padDeg && lon >= w - padDeg && lon <= e + padDeg;
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function normalize(feed, row) {
  const c = feed.cols;
  const lat = Number(row[c.lat]);
  const lon = Number(row[c.lon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const type = titleCase(row[c.type]);
  const desc = c.desc ? titleCase(row[c.desc]) : '';
  const text = `${type} ${desc}`;
  const cls = classify(text) || { category: feed.defaultCategory, severity: 1 };
  const where = [row[c.address], row[c.area]].filter(Boolean).map(titleCase).join(' · ');
  const time = zonedToUtc(row[c.time], feed.tz);
  return {
    id: `${feed.id}:${row[c.id]}`,
    kind: 'incident',
    category: cls.category,
    severity: cls.severity,
    title: desc && desc !== type ? `${type}: ${desc}` : type || 'Dispatched call',
    summary: where ? `Reported near ${where}` : '',
    details: '',
    lat,
    lon,
    precision: feed.precision,
    place: where,
    time,
    sources: [{ name: feed.agency, kind: 'official', tier: 'gov', url: feed.url.replace('/resource/', '/d/').replace('.json', ''), time }],
    confirmed: [`${feed.agency} logged this call${type ? ` as “${type}”` : ''}`],
    unconfirmed: ['Dispatch data is preliminary and can change once officers or crews report back'],
  };
}

async function fetchFeed(feed, center, radiusMi, hours) {
  const lookback = Math.max(hours, feed.minHours || 0);
  const since = utcToFloating(new Date(Date.now() - lookback * 3600e3), feed.tz);
  const where = encodeURIComponent(`${feed.cols.time} > '${since}'`);
  const url = `${feed.url}?$where=${where}&$order=${feed.cols.time}%20DESC&$limit=1000`;
  const rows = await fetchJson(url, { ttl: 60 });
  return rows
    .map((r) => normalize(feed, r))
    .filter(Boolean)
    .filter((it) => haversineMi(center, it) <= radiusMi);
}

function feedsFor(center) {
  return FEEDS.filter((f) => inBbox(center, f.bbox));
}

module.exports = { FEEDS, feedsFor, fetchFeed, normalize, inBbox };
