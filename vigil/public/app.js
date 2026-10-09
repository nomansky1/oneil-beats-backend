/* Vigil — client app.
   Live mode reads /api/feed, /api/national and /api/geocode.
   The preview build sets window.VIGIL_PREVIEW and runs the same UI on
   embedded sample data with a vector basemap (no network needed). */
(function () {
  'use strict';

  const PREVIEW = window.VIGIL_PREVIEW || null;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`vigil:${key}`);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`vigil:${key}`, JSON.stringify(value)); } catch (e) { /* storage blocked: settings last for this visit only */ }
    },
  };

  /* ---------- Vocabulary ---------- */
  const ICON = {
    crime: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M12 8v4.5M12 15.6v.4"/>',
    fire: '<path d="M12 3c.8 3.4 5 5.6 5 10.2A5 5 0 0 1 7 13.2c0-2.4 1.3-4 2.4-5 .3 1.6 1 2.6 2 3.1-.2-3 .1-5.6.6-8.3z"/>',
    medical: '<path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z"/>',
    traffic: '<path d="M9.6 4h4.8l4 15H5.6z"/><path d="M7.7 11h8.6M6.6 15h10.8M3.5 19.5h17"/>',
    weather: '<path d="M7 17.5a4 4 0 1 1 .9-7.9A5.6 5.6 0 0 1 18.6 11a3.4 3.4 0 0 1-.6 6.5"/><path d="M12.8 12.5l-2 3.8h3l-2 3.7"/>',
    quake: '<path d="M2.5 12h4l2-5.5 3.2 11 3-14 2.5 8.5h4.3"/>',
    hazard: '<path d="M12 3.8l9 16H3z"/><path d="M12 10v4.2M12 17v.4"/>',
    missing: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.2 0 2.3.3 3.2.8"/><circle cx="17" cy="16.2" r="2.6"/><path d="M19 18.3l2.3 2.3"/>',
    community: '<path d="M4 10v4h3l7 4.5v-13L7 10z"/><path d="M17.5 9.5a3.5 3.5 0 0 1 0 5"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    share: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12v7.5h14V12"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    map: '<path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
    news: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7 9h10M7 12.5h10M7 16h6"/>',
    radio: '<rect x="3.5" y="8" width="17" height="12" rx="2"/><path d="M7 8l9-4.5"/><circle cx="15.5" cy="14" r="2.5"/><path d="M7 12.5h3M7 15.5h3"/>',
    registry: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5"/><circle cx="16.5" cy="16.5" r="3"/><path d="M18.7 18.7l2.3 2.3"/>',
    phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.5 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.5-3.5-8.5s1-5.9 3.5-8.5z"/>',
    leaf: '<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19l7-7"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    camera: '<path d="M3 8.5l11.5-3 1.6 5.6-11.5 3z"/><path d="M16.1 9.4l3.4-1v4.4l-3 .2"/><path d="M7.5 13.6V19M5 19h5"/>',
  };
  const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`;

  const CATS = {
    crime: { label: 'Crime & police', color: '#ff5267' },
    fire: { label: 'Fire', color: '#ff8a34' },
    medical: { label: 'Medical', color: '#f472b6' },
    traffic: { label: 'Traffic', color: '#facc15' },
    weather: { label: 'Weather', color: '#60a5fa' },
    quake: { label: 'Earthquakes', color: '#a78bfa' },
    hazard: { label: 'Hazards', color: '#a3e635' },
    missing: { label: 'Missing persons', color: '#2dd4bf' },
    community: { label: 'Community reports', color: '#94a3b8' },
  };
  const SEV = { 3: 'Critical', 2: 'Serious', 1: 'Info' };
  const LEVELS = {
    4: ['Official record', 'A government agency published it: police or fire dispatch, the National Weather Service, USGS, FEMA, or a government-verified account.'],
    3: ['Corroborated', 'Two or more independent established newsrooms (or three outlets of any kind) report it.'],
    2: ['Single source', 'One news outlet has reported it. Treat details as early.'],
    1: ['Unverified', 'A community report or social post nobody has confirmed yet. Hidden in Calm mode and when "Confirmed only" is on.'],
  };
  const PRECISION = { exact: 'Exact location', block: 'Block-level', area: 'Area-wide', city: 'City-level' };
  const TIMEFRAMES = [[1, 'Last hour', '1h'], [6, 'Last 6 hours', '6h'], [24, 'Last 24 hours', '24h'], [168, 'Last 7 days', '7d'], [720, 'Last 30 days', '30d']];
  const RADII = [0.5, 1, 2, 5, 10];
  const TERRITORIES = [
    { label: 'Puerto Rico', place: 'San Juan, PR', lat: 18.4655, lon: -66.1057 },
    { label: 'Guam', place: 'Hagåtña, GU', lat: 13.4757, lon: 144.7489 },
    { label: 'U.S. Virgin Islands', place: 'Charlotte Amalie, VI', lat: 18.3419, lon: -64.9307 },
    { label: 'American Samoa', place: 'Pago Pago, AS', lat: -14.2794, lon: -170.7009 },
    { label: 'Northern Mariana Is.', place: 'Saipan, MP', lat: 15.1778, lon: 145.7505 },
  ];

  /* ---------- Small helpers ---------- */
  const toRad = (d) => (d * Math.PI) / 180;
  function dist(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  function rel(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!Number.isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  const abs = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const miles = (d) => (d == null ? '—' : d < 0.1 ? '< 0.1 mi' : `${d < 10 ? d.toFixed(1) : Math.round(d)} mi`);
  const radiusText = (r) => `${r} mi`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const levelOf = (it) => (it.verification && it.verification.level) || 1;
  const catOf = (it) => CATS[it.category] || CATS.community;

  function animateNumber(el, to, suffix = '') {
    const from = Number(el.dataset.v || 0);
    el.dataset.v = to;
    if (REDUCED || from === to) { el.textContent = `${to}${suffix}`; return; }
    const start = performance.now(), dur = 700;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = `${Math.round(from + (to - from) * e)}${suffix}`;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- State ---------- */
  const HOME = PREVIEW ? PREVIEW.home : null;
  const S = {
    center: store.get('center', HOME),
    radiusMi: store.get('radius', 2),
    hours: store.get('hours', 24),
    cats: new Set(store.get('cats', Object.keys(CATS))),
    overlays: Object.assign({ cameras: true, registry: true }, store.get('overlays', {})),
    mapStyle: store.get('mapStyle', 'night'),
    registry: { coverage: 'link', registrants: [], official: null, warning: '' },
    registryKey: '',
    registryAt: 0,
    lastUpdated: null,
    lastError: null,
    verifiedOnly: store.get('verifiedOnly', false),
    calm: store.get('calm', false),
    tab: 'map',
    scope: 'local',
    feed: { items: [], area: [], sources: [], place: null },
    national: null,
    reports: store.get('reports', []),
    following: new Set(store.get('following', [])),
    alertPrefs: Object.assign(
      { radiusMi: 2, minSeverity: 2, confirmedOnly: true, cats: ['crime', 'fire', 'hazard', 'missing', 'weather', 'quake'], quiet: true, quietFrom: '22:00', quietTo: '07:00', digest: true, digestAt: '18:00', registry: true },
      store.get('alertPrefs', {})
    ),
    contacts: store.get('contacts', []),
    known: new Set(),
    firstLoad: true,
    selectedId: null,
    timer: null,
  };

  /* ---------- Data sources ---------- */
  const Live = {
    async feed() {
      const c = S.center;
      const res = await fetch(`/api/feed?lat=${c.lat}&lon=${c.lon}&radius_mi=${S.radiusMi}&hours=${S.hours}`);
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      return res.json();
    },
    async national() {
      const res = await fetch('/api/national');
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      return res.json();
    },
    async search(q) {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!res.ok) return [];
      return (await res.json()).results || [];
    },
    async registry() {
      const c = S.center;
      const res = await fetch(`/api/registry?lat=${c.lat}&lon=${c.lon}&radius_mi=${S.radiusMi}`);
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      return res.json();
    },
  };

  const Preview = {
    t0: Date.now(),
    // Sample times count from when the page opened, so ages tick forward
    // naturally; items with releaseAfter "happen" that many seconds in.
    materialize(it) {
      const base = this.t0 + (it.releaseAfter || 0) * 1000;
      const at = (ago) => new Date(base - ago * 60000).toISOString();
      const updates = (it.updates || []).map((u) => ({ time: at(u.ago), text: u.text }));
      const sources = (it.sources || []).map((s) => ({ ...s, time: at(s.ago != null ? s.ago : it.ago) }));
      return { ...it, time: at(it.ago), expires: it.expiresIn ? new Date(base + it.expiresIn * 60000).toISOString() : null, updates, sources, sample: true };
    },
    released(it) { return !it.releaseAfter || (Date.now() - this.t0) / 1000 >= it.releaseAfter; },
    all() { return PREVIEW.sample.items.filter((it) => this.released(it)).map((it) => this.materialize(it)); },
    async feed() {
      const c = S.center;
      const cutoff = Date.now() - S.hours * 3600e3;
      const all = this.all().map((it) => ({ ...it, distanceMi: dist(c, it) }));
      const items = all.filter((it) => it.kind !== 'area' && it.distanceMi <= (it.category === 'quake' ? Math.max(S.radiusMi, 100) : S.radiusMi) && new Date(it.time) >= cutoff);
      const area = all.filter((it) => it.kind === 'area' && it.distanceMi <= (it.areaRadiusMi || 30));
      const cameras = (PREVIEW.sample.cameras || []).filter((cam) => dist(c, cam) <= S.radiusMi);
      const label = c.label || nearestCity(c);
      const st = (/,\s*([A-Z]{2})$/.exec(label) || [])[1];
      const registry = (st && PREVIEW.registries[st]) || null;
      return { items, area, cameras, registry, xAccounts: previewAccounts(c), sources: PREVIEW.sample.sources, place: { label }, generatedAt: new Date().toISOString() };
    },
    async national() {
      const items = this.all().sort((a, b) => b.severity - a.severity || new Date(b.time) - new Date(a.time));
      return { items, sources: PREVIEW.sample.sources };
    },
    async registry() {
      const c = S.center;
      const registrants = (PREVIEW.sample.registrants || [])
        .filter((r) => this.released(r))
        .map((r) => ({ ...r, distanceMi: Math.round(dist(c, r) * 10) / 10 }))
        .filter((r) => r.distanceMi <= S.radiusMi)
        .sort((a, b) => a.distanceMi - b.distanceMi);
      const st = (/,\s*([A-Z]{2})$/.exec(c.label || nearestCity(c)) || [])[1];
      return { coverage: 'map', registrants, official: (st && PREVIEW.registries[st]) || null, warning: PREVIEW.registryWarning };
    },
    async search(q) { return gazetteer(q); },
  };
  const API = PREVIEW ? Preview : Live;

  /* Preview place search: embedded city list plus every county and
     county-equivalent (PR municipios, territory districts). */
  const FIPS = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI' };
  let countyIndex = null;
  function buildCountyIndex() {
    if (countyIndex || !PREVIEW) return countyIndex || [];
    const fc = topoFeatures(PREVIEW.basemap.us, 'counties');
    countyIndex = fc.features.map((f) => {
      const st = FIPS[String(f.id).slice(0, 2)] || '';
      const suffix = st === 'PR' ? 'Municipio' : st === 'LA' ? 'Parish' : ['AS', 'GU', 'MP', 'VI', 'AK'].includes(st) ? '' : 'County';
      const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates.reduce((a, p) => (p[0].length > a.length ? p[0] : a), []);
      let x = 0, y = 0;
      for (const [lon, lat] of ring) { x += lon; y += lat; }
      return { label: `${f.properties.name}${suffix ? ` ${suffix}` : ''}, ${st}`, name: f.properties.name.toLowerCase(), lat: y / ring.length, lon: x / ring.length, county: true };
    });
    return countyIndex;
  }
  function gazetteer(q) {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    const cities = PREVIEW.cities
      .filter(([name, st]) => `${name}, ${st}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(!a[0].toLowerCase().startsWith(needle)) - Number(!b[0].toLowerCase().startsWith(needle)) || a[4] - b[4])
      .slice(0, 6)
      .map(([name, st, lat, lon]) => ({ label: `${name}, ${st}`, detail: 'City', lat, lon }));
    const counties = buildCountyIndex()
      .filter((c) => c.name.startsWith(needle) || c.label.toLowerCase().includes(needle))
      .slice(0, 8 - cities.length)
      .map((c) => ({ label: c.label, detail: 'County or equivalent', lat: c.lat, lon: c.lon }));
    return cities.concat(counties);
  }
  function previewAccounts(c) {
    const covers = (a) => a === 'national' || (a.bbox ? c.lat >= a.bbox[0] && c.lat <= a.bbox[2] && c.lon >= a.bbox[1] && c.lon <= a.bbox[3] : dist(c, a) <= a.radiusMi);
    const pick = (a) => ({ handle: a.handle, name: a.name, kind: a.kind, url: `https://x.com/${a.handle}` });
    const all = PREVIEW.xAccounts || [];
    return all.filter((a) => a.area !== 'national' && covers(a.area)).map(pick).concat(all.filter((a) => a.area === 'national').map(pick));
  }
  function nearestCity(c) {
    if (!PREVIEW) return '';
    let best = null, bestD = Infinity;
    for (const [name, st, lat, lon] of PREVIEW.cities) {
      const d = dist(c, { lat, lon });
      if (d < bestD) { bestD = d; best = `${name}, ${st}`; }
    }
    return bestD < 30 ? best : 'this area';
  }

  /* ---------- Filtering ---------- */
  function reportsAsItems() {
    return S.reports.map((r) => ({ ...r, distanceMi: dist(S.center, r) }))
      .filter((r) => r.distanceMi != null && r.distanceMi <= S.radiusMi && Date.now() - new Date(r.time) <= S.hours * 3600e3);
  }
  function localItems() { return reportsAsItems().concat(S.feed.items || []); }
  function passes(it) {
    if (!S.cats.has(it.category)) return false;
    const lvl = levelOf(it);
    if (S.verifiedOnly && lvl < 3) return false;
    if (S.calm && lvl < 2) return false;
    return true;
  }
  const visibleLocal = () => localItems().filter(passes);
  const visibleArea = () => (S.feed.area || []).filter((it) => S.cats.has(it.category));
  // Fires and quakes are searched farther out than the radius; counts that
  // say "within X mi" use only what is really inside it.
  const inRadius = (it) => it.distanceMi == null || it.precision === 'city' || it.precision === 'area' || it.distanceMi <= S.radiusMi + 0.05;

  /* ---------- Map ---------- */
  const app = $('#app');
  let map, pinLayer, overlayLayer, labelLayer, radiusCircle, meMarker, sweepMarker;
  const labels = [];
  const SWEEP_MS = 1600;

  function topoFeatures(topo, name) {
    const tf = topo.transform;
    const arcs = topo.arcs.map((arc) => {
      let x = 0, y = 0;
      return arc.map(([dx, dy]) => { x += dx; y += dy; return tf ? [x * tf.scale[0] + tf.translate[0], y * tf.scale[1] + tf.translate[1]] : [dx, dy]; });
    });
    const arcPts = (i) => (i >= 0 ? arcs[i] : arcs[~i].slice().reverse());
    const ring = (ids) => {
      const pts = [];
      ids.forEach((i, k) => { const a = arcPts(i); for (let j = k ? 1 : 0; j < a.length; j++) pts.push(a[j]); });
      return pts;
    };
    const geom = (g) => {
      if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.arcs.map(ring) };
      if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: g.arcs.map((p) => p.map(ring)) };
      return null;
    };
    const obj = topo.objects[name];
    const geoms = obj.type === 'GeometryCollection' ? obj.geometries : [obj];
    return {
      type: 'FeatureCollection',
      features: geoms.map((g) => ({ type: 'Feature', id: g.id, properties: g.properties || {}, geometry: geom(g) })).filter((f) => f.geometry),
    };
  }

  function drawVectorBasemap() {
    const B = PREVIEW.basemap;
    map.createPane('base');
    map.getPane('base').style.zIndex = 150;
    const canvas = L.canvas({ padding: 0.4, pane: 'base' });
    const opts = (style) => ({ pane: 'base', renderer: canvas, interactive: false, style });
    L.geoJSON(topoFeatures(B.land, 'land'), opts({ stroke: false, fillColor: '#0f151c', fillOpacity: 1 })).addTo(map);
    const states = topoFeatures(B.us, 'states');
    L.geoJSON(states, opts({ color: '#2a394b', weight: 1.1, fillColor: '#131b25', fillOpacity: 1 })).addTo(map);
    const countyLines = L.geoJSON(topoFeatures(B.us, 'counties'), opts({ color: '#1e2a38', weight: 0.8, fill: false }));
    const stateLines = L.geoJSON(states, opts({ color: '#3a4f68', weight: 1.5, fill: false }));
    const sync = () => {
      const show = map.getZoom() >= 6;
      if (show && !map.hasLayer(countyLines)) { countyLines.addTo(map); stateLines.addTo(map); }
      if (!show && map.hasLayer(countyLines)) { map.removeLayer(countyLines); map.removeLayer(stateLines); }
    };
    map.on('zoomend', sync);
    sync();
    labelLayer = L.layerGroup().addTo(map);
    for (const [name, , lat, lon, rank] of PREVIEW.cities) {
      const m = L.marker([lat, lon], { icon: L.divIcon({ className: `city-label r${rank}`, html: `<span>${esc(name)}</span>`, iconSize: null }), interactive: false, keyboard: false, pane: 'base' });
      m.rank = rank;
      labels.push(m);
    }
    map.on('zoomend', updateLabels);
    map.attributionControl.addAttribution('Preview: outline map only; the live app shows full street maps · Boundaries: U.S. Census Bureau via us-atlas · Natural Earth');
  }
  function updateLabels() {
    const z = map.getZoom();
    for (const m of labels) {
      const show = (m.rank === 1 && z >= 5) || (m.rank === 2 && z >= 7.5) || (m.rank === 3 && z >= 10);
      if (show && !labelLayer.hasLayer(m)) labelLayer.addLayer(m);
      if (!show && labelLayer.hasLayer(m)) labelLayer.removeLayer(m);
    }
  }

  function initMap() {
    map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 3, maxZoom: PREVIEW ? 15 : 18, zoomSnap: 0.25, worldCopyJump: true, fadeAnimation: !REDUCED });
    map.attributionControl.setPrefix('');
    if (PREVIEW) drawVectorBasemap();
    else addStreetMap();
    map.createPane('sweep');
    map.getPane('sweep').style.zIndex = 450;
    overlayLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    const c = S.center || { lat: 39.5, lon: -98.35 };
    map.setView([c.lat, c.lon], S.center ? 13 : 4);
    if (S.center) fitRadius(false);
    map.on('zoomend', () => { renderPins('static'); renderOverlays(); sizeSweep(); });
    if (PREVIEW) updateLabels();
  }

  // Street map: OpenFreeMap vector tiles (free, no key, OpenStreetMap data)
  // drawn by MapLibre inside Leaflet, with Vigil's own dark style.
  // Three street maps, all free: Night (dark, default), Streets (light, the
  // most detail: shops, parks, transit) and Satellite (USGS aerial imagery
  // with street names). Chosen in Layers and remembered on the phone.
  const OFM_CREDIT = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  const MAP_STYLES = {
    night: { label: 'Night', hint: 'Dark street map; police, fire, hospitals and schools in gold', style: '/map-style.json', credit: `${OFM_CREDIT} · Style © CARTO` },
    streets: { label: 'Streets', hint: 'Light street map with shops, parks and transit', style: 'https://tiles.openfreemap.org/styles/liberty', credit: `${OFM_CREDIT} · Style OSM Liberty` },
    satellite: { label: 'Satellite', hint: 'Aerial photos (US) with street names', style: '/map-style-satellite.json', credit: `<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a> · ${OFM_CREDIT}` },
  };
  let streetLayer = null;
  let streetCredit = '';

  function addStreetMap() {
    const webgl = (() => { try { const cv = document.createElement('canvas'); return Boolean(cv.getContext('webgl2') || cv.getContext('webgl')); } catch (e) { return false; } })();
    const m = MAP_STYLES[S.mapStyle] || MAP_STYLES.night;
    if (!L.maplibreGL || !window.maplibregl || !webgl) {
      map.attributionControl.addAttribution(OFM_CREDIT);
      toast('This browser can’t draw the street map. Reports still show on the map.', 'pin', 5000);
      return;
    }
    streetCredit = m.credit;
    map.attributionControl.addAttribution(streetCredit);
    markMapStyle();
    streetLayer = L.maplibreGL({ style: m.style, interactive: false }).addTo(map);
  }

  function markMapStyle() {
    app.classList.toggle('map-light', !PREVIEW && S.mapStyle === 'streets');
    app.classList.toggle('map-photo', !PREVIEW && S.mapStyle === 'satellite');
  }

  function setMapStyle(key) {
    if (!MAP_STYLES[key] || key === S.mapStyle) return;
    S.mapStyle = key;
    store.set('mapStyle', key);
    markMapStyle();
    if (!streetLayer) return;
    streetLayer.getMaplibreMap().setStyle(MAP_STYLES[key].style);
    map.attributionControl.removeAttribution(streetCredit);
    streetCredit = MAP_STYLES[key].credit;
    map.attributionControl.addAttribution(streetCredit);
  }

  function fitRadius(animate = true) {
    if (!S.center) return;
    const deck = $('#top').offsetHeight;
    const bounds = L.latLng(S.center.lat, S.center.lon).toBounds(S.radiusMi * 2 * 1609.34);
    map.fitBounds(bounds, { paddingTopLeft: [16, deck + 12], paddingBottomRight: [16, 190], animate, duration: 0.9, maxZoom: PREVIEW ? 15 : 17 });
  }

  function drawCenter() {
    if (!S.center) return;
    const ll = [S.center.lat, S.center.lon];
    const meters = S.radiusMi * 1609.34;
    if (!radiusCircle) {
      radiusCircle = L.circle(ll, { radius: meters, color: '#ffc65c', weight: 1.2, opacity: 0.5, dashArray: '3 7', fillColor: '#ffc65c', fillOpacity: 0.045, interactive: false }).addTo(map);
    } else {
      radiusCircle.setLatLng(ll);
      tweenRadius(radiusCircle.getRadius(), meters);
    }
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: 'me-wrap', html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    else meMarker.setLatLng(ll);
    if (sweepMarker) map.removeLayer(sweepMarker);
    sweepMarker = L.marker(ll, { pane: 'sweep', icon: L.divIcon({ className: 'sweep-wrap', html: `<div class="sweep" style="--sweep-ms:${SWEEP_MS}ms"><div></div></div>`, iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(map);
    sizeSweep();
  }
  function tweenRadius(from, to) {
    if (REDUCED) { radiusCircle.setRadius(to); return; }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 450);
      radiusCircle.setRadius(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step); else sizeSweep();
    };
    requestAnimationFrame(step);
  }
  function sizeSweep() {
    if (!sweepMarker || !S.center) return;
    const el = sweepMarker.getElement();
    if (!el) return;
    const c = map.latLngToLayerPoint([S.center.lat, S.center.lon]);
    const dLon = S.radiusMi / (69.17 * Math.cos(toRad(S.center.lat)));
    const e = map.latLngToLayerPoint([S.center.lat, S.center.lon + dLon]);
    const d = Math.max(2, Math.abs(e.x - c.x) * 2);
    const sw = el.firstElementChild;
    Object.assign(sw.style, { width: `${d}px`, height: `${d}px`, left: `${-d / 2}px`, top: `${-d / 2}px` });
  }

  function pinHtml(it, delay) {
    const cat = catOf(it);
    const fresh = Date.now() - new Date(it.time) < 60 * 60e3;
    const cls = ['pin', `sev${it.severity || 1}`, `lv${levelOf(it)}`, fresh ? 'is-fresh' : '', it.mine ? 'is-mine' : '', S.selectedId === it.id ? 'is-selected' : ''].join(' ');
    return `<div class="${cls}" style="--c:${cat.color};--d:${delay}ms">${icon(it.category in CATS ? it.category : 'community')}</div>`;
  }

  // mode: 'reveal' (sweep-timed entrance), 'new' (only new ids animate), 'static'
  function renderPins(mode = 'static', freshIds = new Set()) {
    if (!map || !pinLayer) return;
    pinLayer.clearLayers();
    if (!S.center) return;
    const items = visibleLocal();
    // Area-wide alerts (FEMA archive) cover a whole region, so they get no pin.
    const points = items.filter((it) => it.lat != null && it.precision !== 'city' && it.precision !== 'area');
    const stacks = items.filter((it) => it.lat != null && it.precision === 'city');
    const zoom = map.getZoom();
    const clusters = [];
    const R = zoom >= 16 ? 0 : 38;
    for (const it of points.sort((a, b) => b.severity - a.severity)) {
      const p = map.project([it.lat, it.lon], zoom);
      const hit = R && clusters.find((cl) => Math.abs(cl.p.x - p.x) < R && Math.abs(cl.p.y - p.y) < R);
      if (hit) hit.items.push(it); else clusters.push({ p, items: [it] });
    }
    const delayFor = (it) => (mode === 'reveal' && !REDUCED ? Math.round((bearing(S.center, it) / 360) * SWEEP_MS) : 0);
    const animClass = (ids) => (mode === 'reveal' || (mode === 'new' && ids.some((id) => freshIds.has(id))) ? '' : ' static');

    for (const cl of clusters) {
      const lead = cl.items[0];
      const ids = cl.items.map((i) => i.id);
      if (cl.items.length === 1) {
        const m = L.marker([lead.lat, lead.lon], {
          icon: L.divIcon({ className: `pin-wrap${animClass(ids)}`, html: pinHtml(lead, delayFor(lead)), iconSize: [44, 44] }),
          zIndexOffset: (lead.severity || 1) * 100 + (S.selectedId === lead.id ? 1000 : 0),
          title: `${catOf(lead).label}: ${lead.title}`,
        });
        m.on('click', () => openItem(lead, { fly: false }));
        pinLayer.addLayer(m);
      } else {
        const lat = cl.items.reduce((s, i) => s + i.lat, 0) / cl.items.length;
        const lon = cl.items.reduce((s, i) => s + i.lon, 0) / cl.items.length;
        const top = catOf(lead).color;
        const m = L.marker([lat, lon], {
          icon: L.divIcon({ className: `pin-wrap${animClass(ids)}`, html: `<div class="cluster" style="--c:${top};--d:${delayFor({ lat, lon })}ms"><i></i>${cl.items.length}</div>`, iconSize: [56, 44] }),
          zIndexOffset: 500,
          title: `${cl.items.length} reports here. Zoom in`,
        });
        m.on('click', () => map.flyTo([lat, lon], Math.min(zoom + 2, map.getMaxZoom()), { duration: 0.6 }));
        pinLayer.addLayer(m);
      }
    }

    const byPlace = new Map();
    for (const it of stacks) {
      const key = `${it.lat.toFixed(3)},${it.lon.toFixed(3)}`;
      if (!byPlace.has(key)) byPlace.set(key, []);
      byPlace.get(key).push(it);
    }
    for (const group of byPlace.values()) {
      const it = group[0];
      const where = (it.place || '').split(',')[0] || 'this city';
      const m = L.marker([it.lat, it.lon], {
        icon: L.divIcon({ className: `stack-wrap${animClass(group.map((g) => g.id))}`, html: `<div class="stack-pos"><div class="stack" style="--d:${mode === 'reveal' ? SWEEP_MS : 0}ms">${icon('news')}${plural(group.length, 'news report')} · ${esc(where)}</div></div>`, iconSize: null }),
        zIndexOffset: 400,
        title: `News reports in ${where}`,
      });
      m.on('click', () => openList(`News in ${where}`, 'Articles rarely give an exact address, so these sit at the city center instead of a guessed spot.', group));
      pinLayer.addLayer(m);
    }
  }

  /* ---------- Overlay: plate cameras ---------- */
  const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const facing = (deg) => (deg == null ? 'Direction not mapped' : `Faces ${COMPASS[Math.round(deg / 45) % 8]} (${Math.round(deg)}°)`);

  function wedge(c) {
    // ~60° view cone, about 45 m long, drawn only when zoomed in.
    const pts = [[c.lat, c.lon]];
    for (let a = c.direction - 30; a <= c.direction + 30; a += 10) {
      const r = toRad(a), d = 45 / 111320;
      pts.push([c.lat + d * Math.cos(r), c.lon + (d * Math.sin(r)) / Math.cos(toRad(c.lat))]);
    }
    return L.polygon(pts, { stroke: false, fillColor: '#c084fc', fillOpacity: 0.22, interactive: false });
  }

  function renderOverlays() {
    if (!overlayLayer) return;
    overlayLayer.clearLayers();
    const z = map.getZoom();
    if (S.overlays.cameras) {
      for (const c of S.feed.cameras || []) {
        if (z >= 16 && c.direction != null) overlayLayer.addLayer(wedge(c));
        const m = L.circleMarker([c.lat, c.lon], { radius: z >= 15 ? 6 : 4, color: '#c084fc', weight: 1.6, fillColor: '#24123a', fillOpacity: 0.95 });
        m.on('click', () => openCamera(c));
        overlayLayer.addLayer(m);
      }
    }
    if (S.overlays.registry) {
      for (const r of S.registry.registrants || []) {
        const m = L.circleMarker([r.lat, r.lon], { radius: z >= 15 ? 8 : 6, color: REG_COLOR, weight: 2.5, fillColor: '#3b0d18', fillOpacity: 0.95 });
        m.on('click', () => openRegistrant(r));
        overlayLayer.addLayer(m);
      }
    }
  }

  /* ---------- Sex offender registry ---------- */
  const REG_COLOR = '#fb7185';
  const SILHOUETTE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="4" fill="currentColor"/><path d="M4 21c.8-4.2 4-6.5 8-6.5s7.2 2.3 8 6.5z" fill="currentColor"/></svg>`;

  function regPhoto(r, cls) {
    const ok = r.photo && (/^https:\/\//.test(r.photo) || (r.sample && /^data:image\/svg\+xml/.test(r.photo)));
    return `<span class="${cls}">${ok ? `<img src="${esc(r.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}${SILHOUETTE}</span>`;
  }

  function openRegistrant(r) {
    const official = S.registry.official;
    const offenses = (r.offenses || []).length ? `<ul>${r.offenses.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : '<p class="none">Not listed in the data the registry shares. See the official record.</p>';
    openSheet(`
      <div class="reg-head">
        ${regPhoto(r, 'reg-photo big')}
        <div><div class="eyebrow" style="color:${REG_COLOR}">Registered sex offender${r.sample ? ' · sample' : ''}</div><h2 class="d-title">${esc(r.name || 'Name not published by this registry')}</h2></div>
      </div>
      ${r.sample ? '<p class="note"><span class="sample-chip">SAMPLE</span> Placeholder record for the preview. Not a real person. The live app shows official records where the state lets apps read its registry (Iowa, Tennessee, DC) and links to the official registry everywhere else.</p>' : ''}
      <dl class="d-meta">
        <div><dt>${r.precision === 'block' ? 'Block' : 'Address'}</dt><dd>${esc(r.address || 'Not listed')}<span>${r.precision === 'block' ? 'Block-level, as published' : 'As registered'}</span></dd></div>
        <div><dt>Distance</dt><dd>${miles(r.distanceMi)}<span>from map center</span></dd></div>
        <div><dt>Level</dt><dd>${esc(r.level || 'Not listed')}<span>${r.updated ? `Updated ${esc(r.updated)}` : 'Per the registry'}</span></dd></div>
      </dl>
      <section class="sec"><h3>Offenses, as the registry lists them</h3>${offenses}</section>
      <section class="truth lv4"><div class="truth-top"><span class="badge lv4">${icon('shield')}Official registry</span></div><p>${esc(S.registry.warning || '')}</p></section>
      <div class="res">
        ${r.recordUrl ? `<a href="${esc(r.recordUrl)}" target="_blank" rel="noopener noreferrer">${icon('registry')}<b>Full official record</b><small>${esc((r.source && r.source.name) || 'State registry')}</small></a>` : ''}
        ${official ? `<a href="${esc(official.url)}" target="_blank" rel="noopener noreferrer">${icon('pin')}<b>${esc(official.name)} registry map</b><small>${esc(official.agency)}</small></a>` : ''}
      </div>`, 'Registered sex offender');
  }

  function openRegistrantList() {
    const list = S.registry.registrants || [];
    openSheet(`<h2 class="sheet-title">Registered sex offenders</h2>
      <p class="sheet-sub">${plural(list.length, 'listing')} within ${radiusText(S.radiusMi)}, closest first, from the official registry.</p>
      <ol class="feed-list reg-list">${list.map((r, i) => `<li class="card" style="--c:${REG_COLOR};--i:${Math.min(i, 12)}"><button class="card-btn" type="button" data-reg="${esc(r.id)}">
        ${regPhoto(r, 'reg-photo')}<span class="card-main"><span class="card-meta mono"><span>${miles(r.distanceMi)}</span>${r.level ? `<span>${esc(r.level)}</span>` : ''}${r.sample ? '<span class="sample-chip">SAMPLE</span>' : ''}</span><span class="card-title">${esc(r.name || 'Name not published')}</span><span class="src">${esc(r.address || '')}</span></span>
      </button></li>`).join('')}</ol>
      <p class="note">${esc(S.registry.warning || '')}</p>`, 'Registered sex offenders');
    sheetBody.onclick = (e) => {
      const b = e.target.closest('[data-reg]');
      if (b) openRegistrant(list.find((r) => r.id === b.dataset.reg));
    };
  }

  // Which listings this device has already seen, per area, so "newly
  // listed" alerts fire only for real changes. IDs only, dropped after 14
  // days; the preview keeps them in memory.
  const regSeenMem = {};
  const regSeen = {
    get() { return PREVIEW ? regSeenMem : store.get('regSeen', {}); },
    set(v) { if (!PREVIEW) store.set('regSeen', v); },
  };

  function diffRegistry(list) {
    const key = `${S.center.lat.toFixed(2)},${S.center.lon.toFixed(2)},${S.radiusMi}`;
    const all = regSeen.get();
    const now = Date.now();
    const seen = all[key];
    const fresh = seen ? list.filter((r) => !seen[r.id]) : [];
    const next = Object.assign({}, seen || {});
    list.forEach((r) => { next[r.id] = now; });
    for (const [id, t] of Object.entries(next)) if (now - t > 14 * 86400e3) delete next[id];
    all[key] = next;
    const keys = Object.keys(all);
    if (keys.length > 6) keys.sort((a, b) => Math.max(...Object.values(all[a]), 0) - Math.max(...Object.values(all[b]), 0)).slice(0, keys.length - 6).forEach((k) => delete all[k]);
    regSeen.set(all);
    return fresh;
  }

  function registryAlert(fresh) {
    const r = fresh[0];
    toast(`Registry update: ${fresh.length === 1 ? 'a registered sex offender now lists an address' : `${fresh.length} registered sex offenders now list addresses`} ${miles(r.distanceMi)} away`, 'registry', 6000);
    const badge = $('#alerts-badge');
    badge.hidden = false;
    badge.textContent = String(Math.min(9, Number(badge.textContent || 0) + fresh.length));
    if (PREVIEW || !S.alertPrefs.registry) return;
    notify('Registry update near you', `A registered sex offender now lists an address ${miles(r.distanceMi)} away. Tap to view.`, r.id, { kind: 'reg', id: r.id });
  }

  // Registries change daily at most, so this re-checks every 15 minutes
  // (20 seconds in the preview, to show an alert) or when the area changes.
  async function loadRegistry({ quiet = false } = {}) {
    if (!S.center) return;
    const key = `${S.center.lat},${S.center.lon},${S.radiusMi}`;
    if (key === S.registryKey && Date.now() - S.registryAt < (PREVIEW ? 20e3 : 15 * 60e3)) return;
    S.registryKey = key;
    S.registryAt = Date.now();
    try {
      const data = await API.registry();
      if (key !== `${S.center.lat},${S.center.lon},${S.radiusMi}`) return;
      S.registry = { coverage: data.coverage, registrants: data.registrants || [], official: data.official, warning: data.warning, sources: data.sources || [] };
      const fresh = diffRegistry(S.registry.registrants);
      renderOverlays();
      if (pendingOpen) openTarget(pendingOpen);
      if (S.tab === 'feed') renderFeed();
      // A first visit to an area only records what's there; later visits
      // alert on anything listed since.
      if (fresh.length && !quiet) registryAlert(fresh);
    } catch (err) {
      S.registryAt = 0;
    }
  }

  function openCamera(c) {
    openSheet(`
      <div class="d-head" style="--c:#c084fc">
        <span class="glyph big">${icon('camera')}</span>
        <div><div class="eyebrow" style="color:#c084fc">License plate reader${c.sample ? ' · sample' : ''}</div><h2 class="d-title">${esc(c.manufacturer || 'Automated plate camera')}</h2></div>
      </div>
      ${c.sample ? '<p class="note"><span class="sample-chip">SAMPLE</span> Example location for the preview. The live app loads real mapped cameras from OpenStreetMap.</p>' : ''}
      <dl class="d-meta">
        <div><dt>Operator</dt><dd>${esc(c.operator || 'Not mapped')}</dd></div>
        <div><dt>Direction</dt><dd>${esc(facing(c.direction))}</dd></div>
        <div><dt>Distance</dt><dd>${miles(dist(S.center, c))}<span>from map center</span></dd></div>
      </dl>
      <section class="sec"><h3>What it does</h3><p>Automated license plate readers photograph passing vehicles and log the plate number with the time and place. Agencies set their own rules for how long records are kept and who can search them.</p></section>
      <section class="sec"><h3>Source</h3><p>Mapped by volunteers on OpenStreetMap, the same data the DeFlock map uses. Locations can be wrong or out of date.</p></section>
      <div class="res">
        ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${icon('pin')}<b>View or fix this camera on OpenStreetMap</b><small>Anyone can correct the map</small></a>` : ''}
        <a href="https://deflock.me" target="_blank" rel="noopener noreferrer">${icon('camera')}<b>DeFlock map</b><small>Every mapped plate camera in the US</small></a>
        <a href="https://atlasofsurveillance.org" target="_blank" rel="noopener noreferrer">${icon('registry')}<b>Which agencies use them</b><small>EFF Atlas of Surveillance</small></a>
      </div>`, 'License plate reader');
  }

  // Your state's official registry (map and photos live there), plus the
  // national search. Every state, DC and territory has one.
  function registryLinksHtml() {
    const r = S.feed.registry;
    const state = r ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${icon('registry')}<b>${esc(r.name)} sex offender registry</b><small>${esc(r.agency)} · official map and photos</small></a>` : '';
    return `${state}<a href="https://www.nsopw.gov/" target="_blank" rel="noopener noreferrer">${icon('registry')}<b>National sex offender search</b><small>U.S. Dept. of Justice NSOPW · every state, DC and territory</small></a>`;
  }

  function aroundYouHtml() {
    const cams = (S.feed.cameras || []).length;
    const reg = S.registry.official || S.feed.registry;
    const regs = S.registry.registrants || [];
    const onMap = S.registry.coverage === 'map';
    return `<li class="group-label">Around you</li>
      <li class="xacc"><ul class="xacc-list">
        <li class="xacc-row" style="--c:#c084fc"><span class="glyph">${icon('camera')}</span><span class="grow"><b>${plural(cams, 'license plate camera')}</b><small>Mapped on OpenStreetMap near you</small></span><button class="btn small" type="button" data-overlay="cameras" aria-pressed="${S.overlays.cameras}">${S.overlays.cameras ? 'On map' : 'Show'}</button></li>
        ${onMap ? `<li class="xacc-row" style="--c:${REG_COLOR}"><span class="glyph">${icon('registry')}</span><button class="grow linkish" type="button" data-reglist="1"><b>${plural(regs.length, 'registered sex offender')}</b><small>Within ${radiusText(S.radiusMi)} · tap to see the list</small></button><button class="btn small" type="button" data-overlay="registry" aria-pressed="${S.overlays.registry}">${S.overlays.registry ? 'On map' : 'Show'}</button></li>` : ''}
        ${reg ? `<li class="xacc-row" style="--c:${REG_COLOR}"><span class="glyph">${icon('registry')}</span><span class="grow"><b>${onMap ? `${esc(reg.name)} registry` : 'Sex offenders near you'}</b><small>${onMap ? 'Official map, photos and full records' : `${esc(reg.name)} official registry map and photos`}</small></span><a class="btn small" href="${esc(reg.url)}" target="_blank" rel="noopener noreferrer">Open</a></li>` : ''}
      </ul></li>`;
  }

  function toggleOverlay(key) {
    S.overlays[key] = !S.overlays[key];
    store.set('overlays', S.overlays);
    renderOverlays();
    if (S.tab === 'feed') renderFeed();
  }

  // "Live · updated 20 s ago" so freshness is always visible.
  function renderLive() {
    const el = $('#live');
    if (!el) return;
    if (!S.lastUpdated) {
      el.textContent = PREVIEW ? 'Sample data' : S.lastError ? 'Offline · no connection' : 'Connecting…';
      el.className = `live${S.lastError ? ' stale' : ''}`;
      return;
    }
    const secs = Math.round((Date.now() - S.lastUpdated) / 1000);
    const ago = secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)} min ago`;
    el.className = `live${S.lastError ? ' stale' : ''}`;
    el.textContent = S.lastError ? `Offline · ${ago}` : `${PREVIEW ? 'Sample' : 'Live'} · ${ago}`;
  }

  /* ---------- Rendering ---------- */
  function renderChrome() {
    app.classList.toggle('calm', S.calm);
    $('#chip-verified').setAttribute('aria-pressed', String(S.verifiedOnly));
    $('#chip-calm').setAttribute('aria-pressed', String(S.calm));
    const tf = TIMEFRAMES.find((t) => t[0] === S.hours) || TIMEFRAMES[2];
    $('#time-label').textContent = tf[1].replace('Last 24 hours', 'Last 24h');
    $('#radius-label').textContent = radiusText(S.radiusMi);
    const off = Object.keys(CATS).length - S.cats.size;
    $('#layers-count').textContent = off ? `${S.cats.size}/${Object.keys(CATS).length}` : '';
    $('#layers-count').hidden = !off;
    const label = (S.feed.place && S.feed.place.label) || (S.center && S.center.label) || '';
    $('#place-label').innerHTML = S.center ? `<b>${esc(label || 'Your area')}</b> · ${radiusText(S.radiusMi)} radius` : 'Search for a place to start';
    $('#stat-radius').textContent = radiusText(S.radiusMi);
    $('#stat-window').textContent = tf[2];
    $('#ribbon').hidden = !PREVIEW;
  }

  function renderStats() {
    const items = visibleLocal().filter(inRadius);
    animateNumber($('#stat-near'), items.length);
    const confirmed = items.filter((it) => levelOf(it) >= 3).length;
    const pct = items.length ? Math.round((confirmed / items.length) * 100) : 0;
    animateNumber($('#stat-verified'), pct, '%');
    $('#stat-ring').style.strokeDashoffset = String(150.8 * (1 - pct / 100));
  }

  function renderAreaBanner() {
    const el = $('#area-banner');
    const area = visibleArea().sort((a, b) => b.severity - a.severity);
    if (!area.length) { el.hidden = true; return; }
    const top = area[0];
    el.className = `area-banner${top.severity >= 3 ? '' : ' mild'}`;
    const until = top.expires ? ` · until ${new Date(top.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    el.innerHTML = `${icon(top.category in CATS ? top.category : 'hazard')}<span class="ab-text"><b>${esc(top.title)}</b><small>${esc((top.place || '').split(';')[0])}${until}</small></span>${area.length > 1 ? `<span class="ab-more">+${area.length - 1} more</span>` : ''}`;
    el.hidden = false;
    el.onclick = () => (area.length > 1 ? openList('Area-wide alerts', 'Official alerts that cover your whole area rather than one spot.', area) : openItem(top, { fly: false }));
  }

  // News pictures are the outlet's own article image, linked and credited.
  function imageOf(it) {
    const img = it.image;
    if (!img || !img.url) return null;
    return /^https:\/\//.test(img.url) || (it.sample && /^data:image\/svg\+xml/.test(img.url)) ? img : null;
  }

  function photoHtml(it) {
    const pic = imageOf(it);
    if (!pic) return '';
    const img = `<img src="${esc(pic.url)}" alt="" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('figure').remove()">`;
    const credit = pic.sample ? `Sample image · ${esc(pic.credit)}` : `Photo: ${esc(pic.credit)} · from the article`;
    return `<figure class="d-photo">${pic.link ? `<a href="${esc(pic.link)}" target="_blank" rel="noopener noreferrer">${img}</a>` : img}<figcaption>${credit}</figcaption></figure>`;
  }

  function cardHtml(it, i, extraClass = '') {
    const cat = catOf(it);
    const lvl = levelOf(it);
    const sources = (it.sources || []).map((s) => s.name);
    const srcText = sources.length > 2 ? `${sources.slice(0, 2).join(', ')} +${sources.length - 2}` : sources.join(', ');
    const where = S.scope === 'national' || it.distanceMi == null || it.kind === 'area' ? esc((it.place || '').split(';')[0]) : miles(it.distanceMi);
    const pic = imageOf(it);
    return `<li class="card ${extraClass}" style="--c:${cat.color};--i:${Math.min(i, 12)}">
      <button class="card-btn${pic ? ' has-pic' : ''}" type="button" data-id="${esc(it.id)}">
        <span class="glyph">${icon(it.category in CATS ? it.category : 'community')}</span>
        <span class="card-main">
          <span class="card-meta mono"><span class="sev${it.severity}">${SEV[it.severity] || 'Info'}</span><span>${rel(it.time)}</span><span>${where}</span>${it.precision ? `<span>${PRECISION[it.precision] || ''}</span>` : ''}</span>
          <span class="card-title">${esc(it.title)}</span>
          <span class="card-foot"><span class="badge lv${lvl}">${icon('shield')}${LEVELS[lvl][0]}</span>${it.sample ? '<span class="sample-chip">SAMPLE</span>' : ''}${it.mine ? '<span class="sample-chip">YOUR REPORT</span>' : ''}<span class="src">${esc(srcText)}</span></span>
        </span>
        ${pic ? `<img class="thumb" src="${esc(pic.url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.remove('has-pic');this.remove()">` : ''}
      </button>
    </li>`;
  }

  function bucket(it) {
    const age = Date.now() - new Date(it.time);
    if (age < 3600e3) return 'Last hour';
    if (age < 86400e3) return 'Earlier today';
    if (age < 7 * 86400e3) return 'This week';
    return 'Older';
  }

  function renderFeed() {
    const list = $('#feed-list');
    $$('.seg [data-scope]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.scope === S.scope)));
    let html = '';
    const lookup = new Map();
    if (S.scope === 'local') {
      const area = visibleArea();
      const items = visibleLocal().sort((a, b) => new Date(b.time) - new Date(a.time));
      $('#feed-context').innerHTML = contextLine(items);
      if (area.length) {
        html += '<li class="group-label">Area-wide alerts</li>';
        area.forEach((it, i) => { lookup.set(it.id, it); html += cardHtml(it, i, 'area'); });
      }
      html += aroundYouHtml() + xAccountsHtml();
      let last = '';
      items.forEach((it, i) => {
        lookup.set(it.id, it);
        const b = bucket(it);
        if (b !== last) { html += `<li class="group-label">${b}</li>`; last = b; }
        html += cardHtml(it, i + area.length);
      });
      if (!items.length && !area.length) html = emptyState() + xAccountsHtml();
    } else {
      $('#feed-context').innerHTML = `<div class="chips" aria-label="Jump to a territory">${TERRITORIES.map((t, i) => `<button class="chip" type="button" data-terr="${i}">${icon('globe')}${esc(t.label)}</button>`).join('')}</div>`;
      if (!S.national) {
        html = '<li class="empty"><b>Loading all states and territories…</b></li>';
        loadNational();
      } else {
        const items = S.national.items.filter(passes);
        items.forEach((it, i) => { lookup.set(it.id, it); html += cardHtml(it, i); });
        if (!items.length) html = '<li class="empty"><b>Nothing matches your filters</b><span>Try turning more layers on.</span></li>';
      }
    }
    list.innerHTML = html;
    list.onclick = (e) => {
      const ovb = e.target.closest('[data-overlay]');
      if (ovb) { toggleOverlay(ovb.dataset.overlay); return; }
      if (e.target.closest('[data-reglist]')) { openRegistrantList(); return; }
      const xv = e.target.closest('[data-xview]');
      if (xv) { showXPosts(xv.dataset.xview, xv); return; }
      const btn = e.target.closest('[data-id]');
      if (btn && lookup.has(btn.dataset.id)) openItem(lookup.get(btn.dataset.id), { fly: false });
    };
    $('#feed-context').onclick = (e) => {
      const t = e.target.closest('[data-terr]');
      if (t) { const terr = TERRITORIES[Number(t.dataset.terr)]; setCenter({ lat: terr.lat, lon: terr.lon, label: terr.place }); S.scope = 'local'; setTab('map'); }
    };
  }

  /* Official agency accounts on X: free public posts via X's own embed.
     Displayed as X shows them; Vigil doesn't read, rate or edit them. */
  const X_KIND = { police: ['crime', 'Police'], fire: ['fire', 'Fire'], weather: ['weather', 'Weather'], emergency: ['hazard', 'Emergency management'], quake: ['quake', 'Earthquakes'] };
  function xAccountsHtml() {
    const accounts = S.feed.xAccounts || [];
    if (!accounts.length) return '';
    const rows = accounts.map((a) => {
      const [ic, kindLabel] = X_KIND[a.kind] || ['community', 'Agency'];
      const color = (CATS[ic] || CATS.community).color;
      return `<li class="xacc-row" style="--c:${color}">
          <span class="glyph">${icon(ic)}</span>
          <span class="grow"><b>${esc(a.name)}</b><small>@${esc(a.handle)} · ${kindLabel}</small></span>
          ${PREVIEW ? '' : `<button class="btn small" type="button" data-xview="${esc(a.handle)}" aria-expanded="false">Posts</button>`}
          <a class="btn small ghost" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open @${esc(a.handle)} on X">X ↗</a>
        </li>
        <li class="xembed" id="xembed-${esc(a.handle)}" hidden></li>`;
    }).join('');
    return `<li class="group-label">Straight from agencies on X</li>
      <li class="xacc"><p class="note">Free public posts from official accounts, shown the way X shows them. No X account or Premium needed.${PREVIEW ? ' The preview can only link out; the live app shows the posts here.' : ''}</p><ul class="xacc-list">${rows}</ul></li>`;
  }
  let xWidgets = null;
  function loadXWidgets() {
    if (window.twttr && window.twttr.widgets) return Promise.resolve(window.twttr);
    if (!xWidgets) {
      xWidgets = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://platform.twitter.com/widgets.js';
        s.async = true;
        s.onload = () => (window.twttr && window.twttr.widgets ? resolve(window.twttr) : reject(new Error('X embed unavailable')));
        s.onerror = () => { xWidgets = null; reject(new Error('X embed did not load')); };
        document.head.append(s);
      });
    }
    return xWidgets;
  }
  async function showXPosts(handle, btn) {
    const box = document.getElementById(`xembed-${handle}`);
    if (!box) return;
    box.hidden = !box.hidden;
    btn.setAttribute('aria-expanded', String(!box.hidden));
    btn.textContent = box.hidden ? 'Posts' : 'Hide';
    if (box.hidden || box.dataset.loaded) return;
    box.innerHTML = `<a class="twitter-timeline" data-theme="dark" data-height="460" data-dnt="true" data-chrome="noheader nofooter noborders transparent" href="https://twitter.com/${esc(handle)}">Loading posts from @${esc(handle)}…</a>`;
    try {
      const tw = await loadXWidgets();
      await tw.widgets.load(box);
      box.dataset.loaded = '1';
    } catch (err) {
      box.innerHTML = `<p class="note">X didn't load here. <a href="https://x.com/${esc(handle)}" target="_blank" rel="noopener noreferrer">Open @${esc(handle)} on X</a>.</p>`;
    }
  }

  function contextLine(all) {
    const items = all.filter(inRadius);
    const farther = all.length - items.length;
    const fartherText = farther ? ` Also ${plural(farther, 'larger event')} farther out (fires, earthquakes).` : '';
    if (!items.length) return farther ? `<p class="context">Nothing within ${radiusText(S.radiusMi)}.${fartherText}</p>` : '';
    const counts = {};
    items.forEach((it) => { counts[it.category] = (counts[it.category] || 0) + 1; });
    const routine = (counts.traffic || 0) + (counts.medical || 0);
    const critical = items.filter((it) => it.severity >= 3).length;
    const confirmed = items.filter((it) => levelOf(it) >= 3).length;
    const tf = (TIMEFRAMES.find((t) => t[0] === S.hours) || TIMEFRAMES[2])[1].toLowerCase();
    return `<p class="context"><b>${plural(items.length, 'report')}</b> within ${radiusText(S.radiusMi)} in the ${tf}. ${confirmed} confirmed by an agency or 2+ outlets. ${routine ? (routine === 1 ? '1 is a traffic or medical call. ' : `${routine} are traffic or medical calls. `) : ''}${critical ? `${critical} marked critical.` : 'None marked critical.'}${fartherText}</p>`;
  }

  function emptyState() {
    if (!S.center) return '<li class="empty"><b>Pick a place</b><span>Search above or tap the location button.</span></li>';
    if (PREVIEW) {
      return `<li class="empty"><b>No sample reports here</b><span>The preview only carries sample data for a few places. The live app pulls real feeds for every US location.</span>
        <span class="row">${PREVIEW.sampleAreas.map((a, i) => `<button class="btn small" type="button" data-sample-area="${i}">${esc(a.label)}</button>`).join('')}</span></li>`;
    }
    return `<li class="empty"><b>All quiet within ${radiusText(S.radiusMi)}</b><span>No reports in this window. Widen the radius or timeframe to see more.</span></li>`;
  }

  /* ---------- Sheet ---------- */
  const sheet = $('#sheet'), sheetBody = $('#sheet-body'), scrim = $('#scrim');
  let sheetState = 'closed', sheetOffset = 0;

  function snap(to) {
    const h = sheet.offsetHeight;
    const vh = app.clientHeight;
    let y = 0;
    if (to === 'closed') y = h + 30;
    else if (to === 'half') y = Math.max(0, h - vh * 0.62);
    sheetOffset = y;
    sheet.style.setProperty('--sheet-y', `${y}px`);
    sheetState = to;
  }
  // Android's Back button closes an open panel instead of leaving the app.
  const backCloses = !PREVIEW && 'pushState' in history;
  let ownBack = false; // history.back() called by closeSheet itself
  window.addEventListener('popstate', () => {
    if (ownBack) {
      ownBack = false;
      // A new panel opened before the old entry was removed: give it one.
      if (sheetState !== 'closed') history.pushState({ sheet: true }, '');
      return;
    }
    if (sheetState !== 'closed') closeSheet({ fromBack: true });
  });

  function openSheet(html, label = 'Details') {
    if (backCloses && sheetState === 'closed' && !ownBack && !(history.state && history.state.sheet)) history.pushState({ sheet: true }, '');
    sheetBody.onclick = null;
    sheetBody.innerHTML = html;
    sheetBody.scrollTop = 0;
    sheet.setAttribute('aria-hidden', 'false');
    sheet.setAttribute('aria-label', label);
    scrim.hidden = false;
    requestAnimationFrame(() => {
      scrim.classList.add('is-on');
      if (sheetState === 'closed') snap('closed');
      requestAnimationFrame(() => snap('half'));
    });
  }
  function closeSheet({ fromBack = false } = {}) {
    if (sheetState === 'closed') return;
    if (backCloses && !fromBack && history.state && history.state.sheet) { ownBack = true; history.back(); }
    snap('closed');
    sheet.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('is-on');
    setTimeout(() => {
      if (sheetState !== 'closed') return;
      scrim.hidden = true;
      sheetBody.innerHTML = '';
    }, 420);
    if (S.selectedId) { S.selectedId = null; renderPins('static'); }
  }
  (function dragSheet() {
    const grip = $('#sheet-grip');
    let startY = 0, startOff = 0, dragging = false;
    grip.addEventListener('pointerdown', (e) => {
      dragging = true; startY = e.clientY; startOff = sheetOffset;
      sheet.classList.add('is-dragging'); grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      sheet.style.setProperty('--sheet-y', `${Math.max(0, startOff + (e.clientY - startY))}px`);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('is-dragging');
      const dy = e.clientY - startY;
      if (dy > 110) (sheetState === 'full' && dy < 260 ? snap('half') : closeSheet());
      else if (dy < -50) snap('full');
      else snap(sheetState);
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    sheetBody.addEventListener('scroll', () => { if (sheetState === 'half' && sheetBody.scrollTop > 8) snap('full'); }, { passive: true });
  })();
  scrim.addEventListener('click', closeSheet);
  $('#sheet-close').addEventListener('click', closeSheet);

  function openList(title, sub, items) {
    const lookup = new Map(items.map((it) => [it.id, it]));
    openSheet(`<h2 class="sheet-title">${esc(title)}</h2><p class="sheet-sub">${esc(sub)}</p><ol class="feed-list">${items.map((it, i) => cardHtml(it, i)).join('')}</ol>`, title);
    sheetBody.querySelector('.feed-list').onclick = (e) => {
      const b = e.target.closest('[data-id]');
      if (b) openItem(lookup.get(b.dataset.id), { fly: false });
    };
  }

  function openItem(it, { fly = true } = {}) {
    if (!it) return;
    S.selectedId = it.id;
    if (map && it.lat != null && S.tab === 'map') {
      if (fly) map.flyTo([it.lat, it.lon], Math.max(map.getZoom(), 14), { duration: 0.8 });
      renderPins('static');
    }
    openSheet(detailHtml(it), it.title);
    bindDetail(it);
  }

  function detailHtml(it) {
    const cat = catOf(it);
    const lvl = levelOf(it);
    const [label] = LEVELS[lvl];
    const reason = (it.verification && it.verification.reason) || LEVELS[lvl][1];
    const where = it.place || (S.feed.place && S.feed.place.label) || '';
    const sources = (it.sources || []).map((s) => {
      const name = it.sample || !s.url ? `<span class="name">${esc(s.name)}</span>` : `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>`;
      return `<li><span class="kind ${esc(s.kind)}">${esc(s.kind === 'social' ? 'post' : s.kind)}</span>${name}<span class="mono">${s.time ? rel(s.time) : ''}</span>${s.headline && s.headline !== it.title ? `<q>${esc(s.headline)}</q>` : ''}</li>`;
    }).join('');
    const list = (arr, none) => (arr && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="none">${none}</p>`);
    const updates = (it.updates || []).slice().sort((a, b) => new Date(b.time) - new Date(a.time));
    const timeline = updates.length
      ? `<section class="sec"><h3>Updates</h3><ol class="timeline">${updates.map((u) => `<li><time class="mono">${abs(u.time)} · ${rel(u.time)}</time>${esc(u.text)}</li>`).join('')}</ol></section>`
      : '';
    const following = S.following.has(it.id);
    const showOnMap = it.lat != null && (S.tab !== 'map' || S.scope === 'national');
    return `
      <div class="d-head" style="--c:${cat.color}">
        <span class="glyph big">${icon(it.category in CATS ? it.category : 'community')}</span>
        <div><div class="eyebrow" style="color:${cat.color}">${esc(cat.label)} · ${SEV[it.severity] || 'Info'}</div><h2 class="d-title">${esc(it.title)}</h2></div>
      </div>
      ${photoHtml(it)}
      ${it.sample ? '<p class="note"><span class="sample-chip">SAMPLE</span> Example data for the preview. Names of sources are placeholders.</p>' : ''}
      <dl class="d-meta">
        <div><dt>When</dt><dd>${abs(it.time)}<span>${rel(it.time)}</span></dd></div>
        <div><dt>Where</dt><dd>${esc(where.split(';')[0] || '—')}<span>${PRECISION[it.precision] || ''}</span></dd></div>
        <div><dt>Distance</dt><dd>${miles(it.distanceMi != null ? it.distanceMi : dist(S.center, it))}<span>from map center</span></dd></div>
      </dl>
      <section class="truth lv${lvl}">
        <div class="truth-top"><span class="badge lv${lvl}">${icon('shield')}${label}</span><button class="link" type="button" data-act="explain">How we verify</button></div>
        <div class="meter">${[1, 2, 3, 4].map((k) => `<i class="${k <= lvl ? 'on' : ''}" style="--k:${k}"></i>`).join('')}</div>
        <div class="meter-scale"><span>Unverified</span><span>Official</span></div>
        <p>${esc(reason)}</p>
      </section>
      ${it.summary || it.details ? `<section class="sec"><h3>What we know</h3><p>${esc([it.summary, it.details].filter(Boolean).join('\n\n'))}</p></section>` : ''}
      <section class="sec"><h3>Sources (${(it.sources || []).length})</h3><ul class="sources">${sources || '<li>No sources attached</li>'}</ul></section>
      <section class="sec two"><div><h3>Confirmed</h3>${list(it.confirmed, 'Nothing confirmed yet')}</div><div><h3>Not confirmed</h3>${list(it.unconfirmed, 'No open questions listed')}</div></section>
      ${timeline}
      <div class="actions" style="grid-template-columns:repeat(${showOnMap ? 4 : 3},1fr)">
        <button class="btn" type="button" data-act="share">${icon('share')}Share</button>
        <button class="btn" type="button" data-act="follow" aria-pressed="${following}">${icon('bell')}${following ? 'Following' : 'Follow'}</button>
        ${showOnMap ? `<button class="btn" type="button" data-act="show">${icon('pin')}Map</button>` : ''}
        <button class="btn" type="button" data-act="correct">${icon('flag')}Correct</button>
      </div>
      <form class="block" id="correct-form" hidden>
        <h2>Suggest a correction</h2>
        <p>Tell us what's wrong and where you saw the right information. Corrections are reviewed and logged publicly on the item.</p>
        <label class="sr" for="correct-text">Correction</label>
        <textarea class="input" id="correct-text" required placeholder="e.g. The road reopened at 6:40 PM, per the county sheriff's post."></textarea>
        <button class="btn primary" type="submit">Send correction</button>
      </form>`;
  }

  function bindDetail(it) {
    sheetBody.onclick = async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const a = act.dataset.act;
      if (a === 'explain') openExplain();
      if (a === 'share') {
        const text = `${it.title} (${LEVELS[levelOf(it)][0]}; sources: ${(it.sources || []).map((s) => s.name).join(', ')})`;
        try {
          if (navigator.share && !PREVIEW) await navigator.share({ title: it.title, text });
          else { await navigator.clipboard.writeText(text); toast('Copied a summary with its sources', 'share'); }
        } catch (err) { toast('Sharing is blocked here. Long-press the title to copy it.', 'share'); }
      }
      if (a === 'follow') {
        if (S.following.has(it.id)) S.following.delete(it.id); else S.following.add(it.id);
        store.set('following', [...S.following]);
        const on = S.following.has(it.id);
        act.setAttribute('aria-pressed', String(on));
        act.innerHTML = `${icon('bell')}${on ? 'Following' : 'Follow'}`;
        toast(on ? 'Following. New updates will show in Alerts.' : 'Stopped following', 'bell');
      }
      if (a === 'correct') { const f = $('#correct-form'); f.hidden = false; f.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' }); $('#correct-text').focus(); }
      if (a === 'show') {
        const nearby = S.scope === 'local' && dist(S.center, it) <= Math.max(S.radiusMi, 25);
        S.scope = 'local';
        setTab('map');
        if (nearby) {
          S.selectedId = it.id;
          map.flyTo([it.lat, it.lon], Math.max(map.getZoom(), 14), { duration: 0.8 });
          renderPins('static');
        } else {
          setCenter({ lat: it.lat, lon: it.lon, label: (it.place || '').split(';')[0] });
        }
      }
    };
    const form = $('#correct-form');
    if (form) form.onsubmit = (e) => {
      e.preventDefault();
      form.innerHTML = `<h2>Thanks</h2><p>${PREVIEW ? 'In the preview your note stays on this device. In the live app it goes to the review queue.' : 'Sent to the review queue. We log every accepted correction on the item.'}</p>`;
    };
  }

  function openExplain() {
    const health = (S.feed.sources || []).map((s) => {
      const state = s.notConfigured ? 'off' : s.ok ? '' : 'bad';
      const detail = s.notConfigured ? 'Not turned on' : s.ok ? `${plural(s.count, 'item')}${s.ms != null ? ` · ${s.ms} ms` : ''}` : esc(s.error || 'No answer');
      return `<li><span class="dot ${state}"></span><span class="grow">${esc(s.label)}</span><small>${detail}</small></li>`;
    }).join('');
    openSheet(`
      <h2 class="sheet-title">How Vigil verifies</h2>
      <p class="sheet-sub">Every item shows where it came from. The label comes from those sources alone, so you can always check our work.</p>
      <ol class="list levels">${[4, 3, 2, 1].map((l) => `<li><span class="badge lv${l}">${icon('shield')}${LEVELS[l][0]}</span><p>${esc(LEVELS[l][1])}</p></li>`).join('')}</ol>
      <section class="sec"><h3>Ground rules</h3><ul class="list" style="padding-left:18px;list-style:disc;display:grid;gap:6px;color:#c9d3de">
        <li>We never guess an exact address. If a source only names a city, the pin says so.</li>
        <li>No names or photos of suspects from community reports.</li>
        <li>Headlines stay in the outlet's own words, with a link back.</li>
        <li>Corrections are logged on the item, not silently edited.</li>
      </ul></section>
      <section class="sec"><h3>${PREVIEW ? 'Sources in this preview' : 'Source status right now'}</h3><ul class="list health">${health || '<li>Loading…</li>'}</ul>
      ${PREVIEW ? '<p class="note" style="margin-top:10px">This preview runs on sample data. The live server pulls the National Weather Service, USGS, FEMA, city police and fire dispatch feeds, local news (Google News, GDELT) and, with an API key, X posts.</p>' : ''}</section>`, 'How Vigil verifies');
  }

  /* ---------- Filter sheets ---------- */
  function openLayers() {
    const counts = {};
    localItems().forEach((it) => { counts[it.category] = (counts[it.category] || 0) + 1; });
    const render = () => `
      <h2 class="sheet-title">Layers</h2>
      <p class="sheet-sub">All layers are free. Counts are reports in your radius and timeframe.</p>
      <div class="row"><button class="btn small" type="button" data-all="1">Show all</button><button class="btn small" type="button" data-all="0">Hide all</button></div>
      <div class="list">${Object.entries(CATS).map(([id, c]) => `
        <button class="opt" type="button" role="checkbox" aria-checked="${S.cats.has(id)}" data-cat="${id}" style="--c:${c.color}">
          <span class="glyph" style="--c:${c.color}">${icon(id)}</span><span class="grow">${esc(c.label)}<small>${plural(counts[id] || 0, 'report')}</small></span><span class="tick">${icon('check')}</span>
        </button>`).join('')}</div>
      ${PREVIEW ? '' : `<section class="sec"><h3>Map</h3><div class="list">${Object.entries(MAP_STYLES).map(([key, m]) => `
        <button class="opt" type="button" role="radio" aria-checked="${S.mapStyle === key}" data-mapstyle="${key}"><span class="glyph" style="--c:#7cc4ff">${icon('map')}</span><span class="grow">${esc(m.label)}<small>${esc(m.hint)}</small></span><span class="tick">${icon('check')}</span></button>`).join('')}
      </div></section>`}
      <section class="sec"><h3>Map overlays</h3><div class="list">
        <button class="opt" type="button" role="checkbox" aria-checked="${S.overlays.cameras}" data-ov="cameras"><span class="glyph" style="--c:#c084fc">${icon('camera')}</span><span class="grow">License plate cameras<small>${plural((S.feed.cameras || []).length, 'camera')} mapped on OpenStreetMap</small></span><span class="tick">${icon('check')}</span></button>
        <button class="opt" type="button" role="checkbox" aria-checked="${S.overlays.registry}" data-ov="registry"><span class="glyph" style="--c:${REG_COLOR}">${icon('registry')}</span><span class="grow">Registered sex offenders<small>${S.registry.coverage === 'map' ? `${plural((S.registry.registrants || []).length, 'listing')} from the official registry` : 'This state only shares its registry on its own site; see Around you in the feed'}</small></span><span class="tick">${icon('check')}</span></button>
      </div></section>`;
    openSheet(render(), 'Layers');
    sheetBody.onclick = (e) => {
      const ov = e.target.closest('[data-ov]');
      if (ov) { toggleOverlay(ov.dataset.ov); ov.setAttribute('aria-checked', String(S.overlays[ov.dataset.ov])); return; }
      const ms = e.target.closest('[data-mapstyle]');
      if (ms) {
        setMapStyle(ms.dataset.mapstyle);
        $$('[data-mapstyle]', sheetBody).forEach((b) => b.setAttribute('aria-checked', String(b === ms)));
        return;
      }
      const opt = e.target.closest('[data-cat]');
      const all = e.target.closest('[data-all]');
      if (!opt && !all) return;
      if (all) S.cats = new Set(all.dataset.all === '1' ? Object.keys(CATS) : []);
      else if (S.cats.has(opt.dataset.cat)) S.cats.delete(opt.dataset.cat); else S.cats.add(opt.dataset.cat);
      store.set('cats', [...S.cats]);
      $$('[data-cat]', sheetBody).forEach((b) => b.setAttribute('aria-checked', String(S.cats.has(b.dataset.cat))));
      renderAll('static');
    };
  }

  function openChoice(title, sub, options, current, onPick) {
    openSheet(`<h2 class="sheet-title">${esc(title)}</h2><p class="sheet-sub">${esc(sub)}</p>
      <div class="list" role="radiogroup">${options.map(([value, text, hint]) => `
        <button class="opt" type="button" role="radio" aria-checked="${value === current}" data-v="${value}"><span class="grow">${esc(text)}${hint ? `<small>${esc(hint)}</small>` : ''}</span><span class="tick">${icon('check')}</span></button>`).join('')}</div>`, title);
    sheetBody.onclick = (e) => {
      const opt = e.target.closest('[data-v]');
      if (!opt) return;
      $$('[data-v]', sheetBody).forEach((b) => b.setAttribute('aria-checked', String(b === opt)));
      onPick(Number(opt.dataset.v));
      setTimeout(closeSheet, 220);
    };
  }

  /* ---------- Search ---------- */
  function initSearch() {
    const input = $('#search'), box = $('#suggest');
    let results = [];
    const show = (html) => { box.innerHTML = html; box.hidden = !html; };
    const territoryRow = `<li class="hint">Jump to a territory</li><li class="row">${TERRITORIES.map((t, i) => `<button class="chip" type="button" data-terr="${i}">${esc(t.label)}</button>`).join('')}</li>`;
    const run = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { show(territoryRow); return; }
      results = await API.search(q).catch(() => []);
      show(results.length
        ? results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.label)}<small>${esc(r.detail || '')}</small></button></li>`).join('')
        : `<li class="hint">No US place matches “${esc(q)}”.</li>`);
    }, PREVIEW ? 60 : 300);
    input.addEventListener('focus', () => { if (!input.value) show(territoryRow); });
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && results[0]) { pick(results[0]); }
      if (e.key === 'Escape') { input.blur(); show(''); }
    });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.deck')) show(''); });
    const pick = (r) => { input.value = ''; input.blur(); show(''); setCenter({ lat: r.lat, lon: r.lon, label: r.label }); };
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      const t = e.target.closest('[data-terr]');
      if (b) pick(results[Number(b.dataset.i)]);
      if (t) { const terr = TERRITORIES[Number(t.dataset.terr)]; pick({ lat: terr.lat, lon: terr.lon, label: terr.place }); }
    });
  }

  function setCenter(c) {
    S.center = { lat: c.lat, lon: c.lon, label: c.label || '' };
    store.set('center', S.center);
    S.feed = { items: [], area: [], sources: [], place: { label: S.center.label } };
    S.registry = { coverage: 'link', registrants: [], official: null, warning: '' };
    S.known = new Set();
    S.firstLoad = true;
    S.selectedId = null;
    renderAll('static');
    drawCenter();
    fitRadius(true);
    setTimeout(() => refresh(), REDUCED ? 0 : 700);
  }

  function locate() {
    if (PREVIEW || !navigator.geolocation) {
      toast(PREVIEW ? 'The preview can’t read your location. Showing the sample area.' : 'Location isn’t available in this browser.', 'pin');
      if (HOME) setCenter(HOME);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => setCenter({ lat: p.coords.latitude, lon: p.coords.longitude, label: '' }),
      () => toast('Location is off. Search for a place instead.', 'pin'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  /* ---------- Tabs ---------- */
  function setTab(tab) {
    S.tab = tab;
    app.dataset.tab = tab;
    $$('.dock [data-tab]').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    for (const [name, sel] of [['feed', '#view-feed'], ['alerts', '#view-alerts'], ['safety', '#view-safety']]) {
      const el = $(sel);
      const on = name === tab;
      el.classList.toggle('is-active', on);
      el.inert = !on;
    }
    closeSheet();
    if (tab === 'feed') renderFeed();
    if (tab === 'alerts') renderAlerts();
    if (tab === 'safety') renderSafety();
    if (tab === 'map') setTimeout(() => map.invalidateSize(), 50);
  }

  /* ---------- Alerts ---------- */
  function matchesPrefs(it, p = S.alertPrefs) {
    if (!p.cats.includes(it.category)) return false;
    if ((it.severity || 1) < p.minSeverity) return false;
    if (p.confirmedOnly && levelOf(it) < 3) return false;
    if (it.distanceMi != null && it.distanceMi > p.radiusMi && it.kind !== 'area') return false;
    return true;
  }

  function renderAlerts() {
    const p = S.alertPrefs;
    const day = Date.now() - 86400e3;
    const pool = localItems().concat(S.feed.area || []).filter((it) => new Date(it.time) >= day);
    const mine = pool.filter((it) => matchesPrefs(it));
    const instant = mine.filter((it) => it.severity >= 3 || !p.digest);
    const digest = mine.length - instant.length;
    const max = Math.max(pool.length, 1);
    const seg = (key, values, labelFn) => `<div class="segs">${values.map((v) => `<button type="button" data-pref="${key}" data-v="${v}" aria-pressed="${p[key] === v}">${labelFn(v)}</button>`).join('')}</div>`;
    const sw = (key, title, hint) => `<div class="switch-row"><div><b>${title}</b><small>${hint}</small></div><button type="button" class="switch" role="switch" aria-checked="${!!p[key]}" data-toggle="${key}" aria-label="${title}"></button></div>`;
    const followed = localItems().filter((it) => S.following.has(it.id));
    $('#view-alerts').innerHTML = `
      <div class="panel-head"><h1>Alerts on your terms</h1><p>Every setting here is free. Fewer, better alerts beat a phone that buzzes all night.</p></div>
      <div class="block">
        <h2>Your last 24 hours</h2>
        <p>What these settings would have sent you, from reports already in your area${PREVIEW ? ' (sample data)' : ''}.</p>
        <div class="sim">
          <div class="sim-row"><span>Every report</span><span class="sim-bar"><i style="width:${(pool.length / max) * 100}%"></i></span><b>${pool.length}</b></div>
          <div class="sim-row"><span>Your settings</span><span class="sim-bar you"><i style="width:${(mine.length / max) * 100}%"></i></span><b>${mine.length}</b></div>
        </div>
        <p class="note">${instant.length} right away${p.digest ? `, ${digest} saved for your ${esc(p.digestAt)} digest` : ''}. Critical alerts always come through, even in quiet hours.</p>
      </div>
      <div class="block">
        <h2>When to alert me</h2>
        <div class="field"><span>Distance</span>${seg('radiusMi', RADII, (v) => `${v} mi`)}</div>
        <div class="field"><span>Minimum severity</span>${seg('minSeverity', [1, 2, 3], (v) => ({ 1: 'Everything', 2: 'Serious and up', 3: 'Critical only' })[v])}</div>
        ${sw('confirmedOnly', 'Confirmed reports only', 'Skip single-source and unverified reports')}
        <div class="field"><span>Topics</span><div class="segs">${Object.entries(CATS).map(([id, c]) => `<button type="button" data-cat-pref="${id}" aria-pressed="${p.cats.includes(id)}">${esc(c.label)}</button>`).join('')}</div></div>
        ${sw('registry', 'Sex offender registry changes', 'When someone is newly listed within your map radius. Iowa, Tennessee and DC for now')}
      </div>
      <div class="block">
        <h2>Quiet time</h2>
        ${sw('quiet', 'Quiet hours', 'Hold non-critical alerts overnight')}
        <div class="times"><label for="quiet-from">From</label><input type="time" id="quiet-from" value="${esc(p.quietFrom)}"><label for="quiet-to">to</label><input type="time" id="quiet-to" value="${esc(p.quietTo)}"></div>
        ${sw('digest', 'Daily digest', 'Bundle non-urgent reports into one summary')}
        <div class="times"><label for="digest-at">Send at</label><input type="time" id="digest-at" value="${esc(p.digestAt)}"></div>
      </div>
      <div class="block">
        <h2>Following</h2>
        ${followed.length ? `<ol class="feed-list">${followed.map((it, i) => cardHtml(it, i)).join('')}</ol>` : '<p>Tap Follow on any report to get its updates here.</p>'}
        ${PREVIEW ? '<p class="note">Push notifications need the installed app. This preview shows the settings and what they would send.</p>' : `${S.installPrompt ? `<button class="btn primary" type="button" id="install-btn">${icon('pin')}Install Vigil on this phone</button>` : ''}<button class="btn" type="button" id="notify-btn">${icon('bell')}${'Notification' in window && Notification.permission === 'granted' ? 'Notifications are on' : 'Allow notifications on this device'}</button><p class="note">While Vigil is open, matching reports pop up as notifications. Alerts with the app closed are on the roadmap.</p>`}
      </div>`;
    const view = $('#view-alerts');
    view.onclick = async (e) => {
      const t = e.target;
      const prefBtn = t.closest('[data-pref]');
      const tog = t.closest('[data-toggle]');
      const catBtn = t.closest('[data-cat-pref]');
      const card = t.closest('[data-id]');
      if (prefBtn) p[prefBtn.dataset.pref] = Number(prefBtn.dataset.v);
      else if (tog) p[tog.dataset.toggle] = !p[tog.dataset.toggle];
      else if (catBtn) { const id = catBtn.dataset.catPref; p.cats = p.cats.includes(id) ? p.cats.filter((c) => c !== id) : p.cats.concat(id); }
      else if (card) { const it = followed.find((f) => f.id === card.dataset.id); return openItem(it, { fly: false }); }
      else if (t.closest('#notify-btn')) {
        if (!('Notification' in window)) return toast('This browser doesn’t support notifications', 'bell');
        const res = await Notification.requestPermission();
        toast(res === 'granted' ? 'Notifications are on for this device' : 'Notifications stay off. You can turn them on in Chrome’s site settings.', 'bell');
        return renderAlerts();
      } else if (t.closest('#install-btn') && S.installPrompt) {
        const prompt = S.installPrompt;
        S.installPrompt = null;
        prompt.prompt();
        await prompt.userChoice.catch(() => null);
        return renderAlerts();
      } else return;
      store.set('alertPrefs', p);
      const y = view.scrollTop;
      renderAlerts();
      view.scrollTop = y;
    };
    view.onchange = (e) => {
      const map_ = { 'quiet-from': 'quietFrom', 'quiet-to': 'quietTo', 'digest-at': 'digestAt' };
      if (map_[e.target.id]) { p[map_[e.target.id]] = e.target.value; store.set('alertPrefs', p); }
    };
  }

  function notifyNew(items) {
    const hits = items.filter((it) => matchesPrefs(it));
    const badge = $('#alerts-badge');
    if (hits.length) { badge.hidden = false; badge.textContent = String(Math.min(9, Number(badge.textContent || 0) + hits.length)); }
    if (PREVIEW) return;
    for (const it of hits.slice(0, 3)) notify(it.title, `${LEVELS[levelOf(it)][0]} · ${(it.sources[0] || {}).name || ''}`, it.id, { kind: 'item', id: it.id });
  }

  // Phones (Android, iPhone home-screen apps) only show notifications sent
  // through the service worker; desktop browsers also accept the direct way.
  async function notify(title, body, tag, open) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = 'serviceWorker' in navigator && (await navigator.serviceWorker.getRegistration());
      if (reg) return await reg.showNotification(title, { body, tag, icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [200, 100, 200], data: { open } });
      const n = new Notification(title, { body, tag });
      n.onclick = () => { window.focus(); openTarget(open); };
    } catch (e) { /* notification blocked by the browser; the in-app alert still shows */ }
  }

  // Open the report or registry record a notification pointed to, once
  // the data that holds it has loaded.
  let pendingOpen = null;
  function openTarget(open) {
    if (!open) return;
    const found = open.kind === 'reg'
      ? (S.registry.registrants || []).find((r) => r.id === open.id)
      : localItems().concat(S.feed.area || []).find((it) => it.id === open.id);
    if (!found) { pendingOpen = open; return; }
    pendingOpen = null;
    if (open.kind === 'reg') openRegistrant(found); else openItem(found, { fly: false });
  }

  /* ---------- Safety ---------- */
  function renderSafety() {
    const t = S.timer;
    const left = t ? Math.max(0, t.end - Date.now()) : 0;
    const frac = t ? left / t.total : 1;
    const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    $('#view-safety').innerHTML = `
      <div class="panel-head"><h1>Safety, free for everyone</h1><p>No account, no subscription. Your contacts and settings stay on this device.</p></div>
      <div class="block">
        <h2>Safety network</h2>
        <p>People who get your check-in alerts.</p>
        <ul class="contacts">${S.contacts.map((c, i) => `<li><span class="avatar">${esc(c.name.slice(0, 1).toUpperCase())}</span><span class="grow">${esc(c.name)}<small>${esc(c.phone)}</small></span><button class="icon-btn" type="button" data-del="${i}" aria-label="Remove ${esc(c.name)}">${icon('x')}</button></li>`).join('') || '<li><span class="grow"><small>No one yet. Add a friend or family member.</small></span></li>'}</ul>
        <form class="row" id="contact-form">
          <label class="sr" for="c-name">Name</label><input class="input" id="c-name" placeholder="Name" required autocomplete="off">
          <label class="sr" for="c-phone">Phone</label><input class="input" id="c-phone" placeholder="Phone" inputmode="tel" required autocomplete="off">
          <button class="btn" type="submit">${icon('plus')}Add</button>
        </form>
      </div>
      <div class="block">
        <h2>Check-in timer</h2>
        <p>Walking home or meeting someone new? If you don't tap "I'm safe" in time, your network is alerted.</p>
        <div class="timer">
          <div class="timer-ring"><svg viewBox="0 0 150 150"><circle class="track" cx="75" cy="75" r="66"/><circle class="bar" id="timer-bar" cx="75" cy="75" r="66" stroke-dasharray="414.7" stroke-dashoffset="${414.7 * (1 - frac)}"/></svg><b id="timer-text">${t ? `${mm}:${ss}` : 'Off'}</b></div>
          ${t ? `<button class="btn primary" type="button" data-timer="stop">${icon('check')}I'm safe</button>` : `<div class="segs">${[15, 30, 60].map((m) => `<button type="button" data-timer="${m}">${m} min</button>`).join('')}</div>`}
        </div>
        <p class="note">${PREVIEW ? 'Preview: the timer runs, but no texts are sent.' : 'Texts to your network need the SMS service connected (see README). Until then the timer alerts you on this device.'}</p>
      </div>
      <div class="block">
        <h2>Free public records</h2>
        <p>Official sources, no paywall. We link to them instead of copying people's records.</p>
        <div class="res">
          ${registryLinksHtml()}
          <a href="https://www.broadcastify.com/listen/" target="_blank" rel="noopener noreferrer">${icon('radio')}<b>Police and fire scanner audio</b><small>Broadcastify · free live feeds by county</small></a>
          <a href="https://openmhz.com/" target="_blank" rel="noopener noreferrer">${icon('radio')}<b>Recorded radio calls</b><small>OpenMHz · trunked systems in many cities</small></a>
          <a href="https://alerts.weather.gov/" target="_blank" rel="noopener noreferrer">${icon('weather')}<b>Official weather and emergency alerts</b><small>National Weather Service</small></a>
        </div>
      </div>
      <div class="block">
        <h2>Numbers to know</h2>
        <div class="numbers">
          <div><b>911</b><span>Emergencies in every state and territory</span></div>
          <div><b>988</b><span>Suicide &amp; Crisis Lifeline, call or text</span></div>
          <div><b>211</b><span>Local help: food, shelter, utilities</span></div>
          <div><b>1-800-222-1222</b><span>Poison Help</span></div>
        </div>
      </div>
      <div class="block">
        <h2>What Citizen charges for, free here</h2>
        <p>From Citizen Premium's upgrade screen ($5.99/month or $39.99/year).</p>
        <div class="scroll-x"><table class="compare">
          <thead><tr><th>Feature</th><th>Citizen</th><th>Vigil</th></tr></thead>
          <tbody>
            <tr><td>Map filters by date, time, category</td><td>${icon('lock')} Premium</td><td>Free</td></tr>
            <tr><td>Incidents older than 24 hours</td><td>${icon('lock')} Premium</td><td>Free, 30 days</td></tr>
            <tr><td>Registered offender details</td><td>${icon('lock')} Premium</td><td>Free official registry</td></tr>
            <tr><td>Police radio audio</td><td>${icon('lock')} Premium</td><td>Free scanner links</td></tr>
            <tr><td>Safety network</td><td>${icon('lock')} Locked</td><td>Free</td></tr>
          </tbody>
        </table></div>
        <p class="note">Only in Vigil: a truth label and source list on every report, Calm mode, alert simulation, and coverage of all five inhabited territories.</p>
      </div>`;
    const view = $('#view-safety');
    view.onclick = (e) => {
      const del = e.target.closest('[data-del]');
      const tm = e.target.closest('[data-timer]');
      if (del) { S.contacts.splice(Number(del.dataset.del), 1); store.set('contacts', S.contacts); renderSafety(); }
      if (tm) {
        if (tm.dataset.timer === 'stop') { clearInterval(S.timer.iv); S.timer = null; toast('Checked in. Glad you’re safe.', 'check'); }
        else startTimer(Number(tm.dataset.timer));
        renderSafety();
      }
    };
    $('#contact-form').onsubmit = (e) => {
      e.preventDefault();
      S.contacts.push({ name: $('#c-name').value.trim(), phone: $('#c-phone').value.trim() });
      store.set('contacts', S.contacts);
      renderSafety();
      toast('Added to your safety network', 'check');
    };
  }
  function startTimer(min) {
    const total = min * 60000;
    S.timer = { end: Date.now() + total, total, iv: setInterval(() => {
      const left = S.timer.end - Date.now();
      if (left <= 0) {
        clearInterval(S.timer.iv); S.timer = null;
        toast(PREVIEW ? 'Time’s up. In the full app your network would get your last location now.' : 'Time’s up. Alerting your safety network.', 'phone', 6000);
        if (S.tab === 'safety') renderSafety();
        return;
      }
      const bar = $('#timer-bar'), txt = $('#timer-text');
      if (bar) bar.style.strokeDashoffset = String(414.7 * (1 - left / total));
      if (txt) txt.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    }, 1000) };
  }

  /* ---------- Report flow ---------- */
  let R = null;
  function lint(text) {
    const out = [];
    const race = /\b(black|white|hispanic|latino|latina|asian|arab|mexican|middle eastern)\s+(man|men|male|guy|guys|woman|women|female|kid|kids|teen|teens|boy|boys|girl|girls|person|people|dude|individual)\b/i;
    const detail = /\b(wearing|shirt|hoodie|jacket|coat|pants|jeans|hat|cap|shoes|backpack|car|truck|van|vehicle|bike|carrying|plate)\b/i;
    if (race.test(text) && !detail.test(text)) out.push('Race alone doesn’t help anyone recognize a person. Describe clothing, what they were doing, or a vehicle.');
    if (/\b(named|name is|his name|her name|their name)\b/i.test(text)) out.push('Please don’t name people. Accusations spread fast and can be wrong.');
    if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text)) out.push('Remove phone numbers and other personal details.');
    if (/\b(get (him|her|them)|go after|bounty|catch (him|her|them)|find (him|her|them))\b/i.test(text)) out.push('Don’t ask others to confront anyone. Share what you saw and let responders handle it.');
    return out;
  }
  function openReport() {
    const c = map.getCenter();
    R = { step: 0, cat: null, text: '', lat: Math.round(c.lat * 700) / 700, lon: Math.round(c.lng * 700) / 700 };
    $('#report').hidden = false;
    renderReport();
  }
  function closeReport() { $('#report').hidden = true; R = null; }
  function renderReport() {
    const el = $('#report');
    const steps = `<div class="steps">${[0, 1, 2, 3].map((i) => `<i class="${i <= R.step ? 'on' : ''}"></i>`).join('')}</div>`;
    let body = '';
    if (R.step === 0) {
      body = `<h2>What's happening?</h2><p>Pick the closest match.</p>
        <div class="cat-grid">${Object.entries(CATS).filter(([id]) => id !== 'quake').map(([id, c]) => `<button type="button" data-rcat="${id}" aria-pressed="${R.cat === id}" style="--c:${c.color}"><span class="glyph" style="--c:${c.color}">${icon(id)}</span>${esc(c.label)}</button>`).join('')}</div>
        <div class="callout"><b>Danger right now?</b> Call 911 first. Reports here don't reach police.</div>`;
    } else if (R.step === 1) {
      body = `<h2>Where?</h2><p>We use the center of your map, rounded to about a block so your exact spot isn't shared.</p>
        <div class="block"><div class="switch-row"><div><b>${esc((S.feed.place && S.feed.place.label) || 'Map center')}</b><small class="mono">${R.lat.toFixed(4)}, ${R.lon.toFixed(4)} · ±150 m</small></div>${icon('pin')}</div></div>
        <p class="note">To move it, close this, drag the map, and tap Report again.</p>`;
    } else if (R.step === 2) {
      const warnings = lint(R.text);
      body = `<h2>What did you see?</h2><p>Stick to what you saw and heard. Actions, clothing and vehicles help. Guesses don't.</p>
        <label class="sr" for="r-text">Description</label>
        <textarea class="input" id="r-text" maxlength="400" placeholder="e.g. Car hit a light pole at the corner. Driver is out and talking. Smoke from the hood.">${esc(R.text)}</textarea>
        <div id="r-warn">${warnings.map((w) => `<div class="warn">${icon('hazard')}<span>${esc(w)}</span></div>`).join('')}</div>`;
    } else {
      const c = CATS[R.cat];
      body = `<h2>Review</h2><p>Your report posts as <b>Unverified</b>. It upgrades automatically when an agency or two newsrooms confirm it.</p>
        <ol class="feed-list">${cardHtml({ id: 'draft', title: R.text.split(/[.!?]/)[0].slice(0, 90) || c.label, category: R.cat, severity: 1, time: new Date().toISOString(), distanceMi: 0, precision: 'block', sources: [{ name: 'You' }], verification: { level: 1 } }, 0)}</ol>
        <div class="block"><h2>Posting rules</h2><ul style="margin:0;padding-left:18px;display:grid;gap:6px;color:#c9d3de">
          <li>No names, faces or license plates of people who haven't been charged.</li>
          <li>Describe what happened, not who you think someone is.</li>
          <li>Never ask others to confront anyone.</li></ul></div>`;
    }
    const canNext = (R.step === 0 && R.cat) || R.step === 1 || (R.step === 2 && R.text.trim().length >= 10) || R.step === 3;
    el.innerHTML = `
      <div class="report-top"><button class="icon-btn" type="button" data-r="close" aria-label="Close">${icon('x')}</button><h1>Report</h1><span class="mono" style="color:var(--muted)">Step ${R.step + 1} of 4</span></div>
      ${steps}
      <div class="step">${body}</div>
      <div class="report-foot">
        ${R.step ? '<button class="btn" type="button" data-r="back">Back</button>' : ''}
        <button class="btn primary" type="button" data-r="${R.step === 3 ? 'post' : 'next'}" ${canNext ? '' : 'disabled style="opacity:.45"'}>${R.step === 3 ? 'Post report' : 'Next'}</button>
      </div>`;
    const ta = $('#r-text');
    if (ta) {
      ta.focus();
      ta.oninput = () => {
        R.text = ta.value;
        $('#r-warn').innerHTML = lint(R.text).map((w) => `<div class="warn">${icon('hazard')}<span>${esc(w)}</span></div>`).join('');
        const next = el.querySelector('[data-r="next"]');
        const ok = R.text.trim().length >= 10;
        next.disabled = !ok; next.style.opacity = ok ? '' : '.45';
      };
    }
  }
  $('#report').addEventListener('click', (e) => {
    const cat = e.target.closest('[data-rcat]');
    const act = e.target.closest('[data-r]');
    if (cat) { R.cat = cat.dataset.rcat; renderReport(); return; }
    if (!act || act.disabled) return;
    const a = act.dataset.r;
    if (a === 'close') closeReport();
    if (a === 'back') { R.step--; renderReport(); }
    if (a === 'next') { R.step++; renderReport(); }
    if (a === 'post') {
      const rep = {
        id: `mine:${Date.now()}`, kind: 'incident', category: R.cat, severity: 1, mine: true,
        title: R.text.split(/[.!?]\s/)[0].slice(0, 120), summary: R.text, details: '',
        lat: R.lat, lon: R.lon, precision: 'block', place: (S.feed.place && S.feed.place.label) || '', time: new Date().toISOString(),
        sources: [{ name: 'You (community report)', kind: 'community', tier: 'community' }],
        confirmed: [], unconfirmed: ['Waiting for an agency or newsroom to confirm'],
        verification: { level: 1, label: 'Unverified', reason: 'Your community report. It upgrades when an agency or two newsrooms confirm it.' },
      };
      S.reports.unshift(rep);
      S.reports = S.reports.slice(0, 20);
      store.set('reports', S.reports);
      closeReport();
      if (S.calm || S.verifiedOnly) toast('Posted. Turn off Calm and Confirmed only to see unverified reports, including yours.', 'check', 5000);
      else toast(PREVIEW ? 'Posted as Unverified. In the preview it stays on this device.' : 'Posted as Unverified', 'check');
      setTab('map');
      renderAll('new', new Set([rep.id]));
    }
  });

  /* ---------- Toasts ---------- */
  function toast(msg, ic = 'bell', ms = 3400) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `${icon(ic)}<span>${esc(msg)}</span>`;
    $('#toasts').append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 380); }, ms);
  }

  /* ---------- Loading ---------- */
  function renderAll(mode = 'static', freshIds) {
    renderChrome();
    renderStats();
    renderAreaBanner();
    renderPins(mode, freshIds);
    renderOverlays();
    renderLive();
    if (S.tab === 'feed') renderFeed();
  }

  let loading = false, pending = false;
  const requestKey = () => `${S.center && S.center.lat},${S.center && S.center.lon},${S.radiusMi},${S.hours}`;
  async function refresh({ quiet = false } = {}) {
    if (!S.center) return;
    if (loading) { pending = true; return; }
    loading = true;
    const key = requestKey();
    try {
      const data = await API.feed();
      if (key !== requestKey()) { pending = true; return; }
      S.feed = data;
      S.lastUpdated = Date.now();
      S.lastError = null;
      const ids = localItems().concat(data.area || []).map((it) => it.id);
      const freshIds = S.firstLoad ? new Set() : new Set(ids.filter((id) => !S.known.has(id)));
      ids.forEach((id) => S.known.add(id));
      const mode = S.firstLoad ? 'reveal' : freshIds.size ? 'new' : 'static';
      if (S.firstLoad && sweepMarker) { map.removeLayer(sweepMarker); sweepMarker = null; drawCenter(); }
      renderAll(mode, freshIds);
      if (pendingOpen) openTarget(pendingOpen);
      loadRegistry();
      if (freshIds.size && !quiet) {
        const fresh = localItems().filter((it) => freshIds.has(it.id) && passes(it));
        if (fresh.length) {
          toast(`${plural(fresh.length, 'new report')} nearby: ${fresh[0].title}`, fresh[0].category in CATS ? fresh[0].category : 'bell');
          notifyNew(fresh);
        }
      }
      S.firstLoad = false;
    } catch (err) {
      S.lastError = err.message;
      renderLive();
      toast(`Couldn't refresh the feed: ${err.message}. Showing the last update.`, 'hazard', 5000);
    } finally {
      loading = false;
      if (pending) { pending = false; refresh({ quiet: true }); }
    }
  }

  let nationalLoading = false;
  async function loadNational() {
    if (nationalLoading) return;
    nationalLoading = true;
    try {
      S.national = await API.national();
    } catch (err) {
      S.national = { items: [] };
      toast(`Couldn't load the nationwide feed: ${err.message}`, 'hazard');
    }
    nationalLoading = false;
    if (S.tab === 'feed' && S.scope === 'national') renderFeed();
  }

  /* ---------- Wiring ---------- */
  function bind() {
    $$('.dock [data-tab]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.tab === 'alerts') { const badge = $('#alerts-badge'); badge.hidden = true; badge.textContent = ''; }
      setTab(b.dataset.tab);
    }));
    $('#report-open').addEventListener('click', openReport);
    $('#chip-layers').addEventListener('click', openLayers);
    $('#chip-time').addEventListener('click', () => openChoice('Timeframe', 'History is free — up to 30 days.', TIMEFRAMES.map(([h, l]) => [h, l]), S.hours, (h) => {
      S.hours = h; store.set('hours', h); renderChrome(); refresh({ quiet: true });
    }));
    $('#chip-radius').addEventListener('click', () => openChoice('Radius', 'How far around the map center to look.', RADII.map((r) => [r, `${r} mile${r === 1 ? '' : 's'}`]), S.radiusMi, (r) => {
      S.radiusMi = r; store.set('radius', r); renderChrome(); drawCenter(); fitRadius(true); refresh({ quiet: true });
    }));
    $('#chip-verified').addEventListener('click', () => {
      S.verifiedOnly = !S.verifiedOnly; store.set('verifiedOnly', S.verifiedOnly);
      renderAll('static');
      toast(S.verifiedOnly ? 'Showing reports confirmed by an agency or 2+ outlets' : 'Showing all reports, labeled by how well they’re confirmed', 'shield');
    });
    $('#chip-calm').addEventListener('click', () => {
      S.calm = !S.calm; store.set('calm', S.calm);
      renderAll('static');
      toast(S.calm ? 'Calm mode: no pulsing, unverified reports hidden, context first' : 'Calm mode off', 'leaf');
    });
    $('#locate').addEventListener('click', locate);
    $('#fab-home').addEventListener('click', () => (S.center ? fitRadius(true) : locate()));
    $('#fab-explain').addEventListener('click', openExplain);
    $$('.seg [data-scope]').forEach((b) => b.addEventListener('click', () => { S.scope = b.dataset.scope; renderFeed(); }));
    $('#feed-list').addEventListener('click', (e) => {
      const a = e.target.closest('[data-sample-area]');
      if (a) { const area = PREVIEW.sampleAreas[Number(a.dataset.sampleArea)]; setCenter(area); setTab('map'); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#report').hidden) closeReport();
      else closeSheet();
    });
    const top = $('#top');
    const syncDeck = () => app.style.setProperty('--deck-h', `${top.offsetHeight + 8}px`);
    if ('ResizeObserver' in window) new ResizeObserver(syncDeck).observe(top);
    syncDeck();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, PREVIEW ? 15000 : 60000);
    setInterval(() => {
      if (document.visibilityState === 'visible' && S.tab === 'feed' && S.scope === 'national') { S.national = null; loadNational(); }
    }, 120000);
    setInterval(renderLive, 5000);
  }

  // Installed-app support and notification taps (live app only; the
  // preview runs inside another page).
  function initServiceWorker() {
    if (PREVIEW || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works without it */ });
    // Chrome on Android offers to install the app; keep the offer for the
    // Install button in the Alerts tab instead of popping it up uninvited.
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      S.installPrompt = e;
      if (S.tab === 'alerts') renderAlerts();
    });
    window.addEventListener('appinstalled', () => {
      S.installPrompt = null;
      toast('Vigil is on your home screen', 'check');
      if (S.tab === 'alerts') renderAlerts();
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open') openTarget({ kind: e.data.kind, id: e.data.id });
    });
    const m = /^(item|reg):(.+)$/.exec(new URLSearchParams(location.search).get('open') || '');
    if (m) {
      pendingOpen = { kind: m[1], id: m[2] };
      history.replaceState(null, '', location.pathname);
    }
  }

  function start() {
    initMap();
    initSearch();
    bind();
    renderChrome();
    if (S.center) {
      drawCenter();
      refresh();
    } else {
      $('#place-label').textContent = 'Search for a place, or use your location';
      locate();
    }
  }

  // Registered even if the map library failed, so the next open can work
  // from the copy saved on the phone.
  initServiceWorker();
  if (window.L) start();
  else document.body.insertAdjacentHTML('beforeend', '<p style="position:fixed;inset:auto 16px 50%;color:#e8edf3;text-align:center">The map library didn’t load. Check your connection and reload.</p>');
})();
