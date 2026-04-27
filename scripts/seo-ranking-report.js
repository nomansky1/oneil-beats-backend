#!/usr/bin/env node
/**
 * Pulls Google Search Console performance data for the SEO-priority pages
 * and prints a readable table: impressions, clicks, CTR, average position
 * for the last 28 days, plus week-over-week deltas.
 *
 * Usage:
 *   node scripts/seo-ranking-report.js
 *   node scripts/seo-ranking-report.js --json   # machine-readable
 *
 * Requires GOOGLE_GSC_REFRESH_TOKEN in .env (run scripts/gsc-reauth.js once
 * to obtain it).
 */
require('dotenv').config();
const { google } = require('googleapis');

const SITE_URL = 'https://oneilbeats.store/'; // GSC property; trailing slash matters
const TARGET_PAGES = [
  '/blog/how-to-find-free-beats-2026-and-why-demos-matter',
  '/blog/free-beats-vs-paid-tagged-mp3-explained',
  '/blog/lease-vs-exclusive-beat-license-guide',
  '/blog/how-to-write-to-a-reggaeton-beat',
  '/bad-bunny-type-beat',
  '/feid-type-beat',
  '/karol-g-type-beat',
  '/future-type-beat',
  '/metro-boomin-type-beat',
  '/drake-type-beat',
  '/reggaeton-beats',
  '/trap-beats',
  '/perreo-beats',
  '/', // homepage
];

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400e3);
  return d.toISOString().slice(0, 10);
}

async function queryRange(sc, startDate, endDate) {
  const res = await sc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate, endDate,
      dimensions: ['page'],
      rowLimit: 1000,
    },
  });
  const map = {};
  for (const row of (res.data.rows || [])) {
    const path = (row.keys[0] || '').replace(/^https?:\/\/oneilbeats\.store/, '') || '/';
    map[path] = {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    };
  }
  return map;
}

(async () => {
  const refresh = process.env.GOOGLE_GSC_REFRESH_TOKEN;
  if (!refresh) {
    console.error('ERROR: GOOGLE_GSC_REFRESH_TOKEN missing — run `node scripts/gsc-reauth.js` first.');
    process.exit(1);
  }
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: refresh });
  const sc = google.searchconsole({ version: 'v1', auth: oauth2Client });

  // Recent 28-day window vs prior 28-day window for WoW-ish deltas
  const recent = await queryRange(sc, daysAgo(28), daysAgo(1));
  const prior  = await queryRange(sc, daysAgo(56), daysAgo(29));

  const rows = TARGET_PAGES.map(p => {
    const r = recent[p] || { clicks: 0, impressions: 0, ctr: 0, position: null };
    const o = prior[p]  || { clicks: 0, impressions: 0, ctr: 0, position: null };
    return {
      page: p,
      impr: r.impressions, impr_prev: o.impressions,
      clicks: r.clicks,    clicks_prev: o.clicks,
      ctr: r.ctr,
      position: r.position, position_prev: o.position,
    };
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ site: SITE_URL, generatedAt: new Date().toISOString(), rows }, null, 2));
    return;
  }

  // Pretty table
  const fmtPos = (p) => p == null ? '—' : p.toFixed(1);
  const fmtDelta = (cur, prev, lowerIsBetter = false) => {
    if (prev == null && cur == null) return '';
    if (prev == null) return ' (new)';
    const d = cur - prev;
    if (Math.abs(d) < 0.05) return '';
    const arrow = (lowerIsBetter ? d < 0 : d > 0) ? '↑' : '↓';
    return ` ${arrow}${Math.abs(d).toFixed(1)}`;
  };

  console.log(`\nSEO RANKING REPORT — oneilbeats.store`);
  console.log(`Window: ${daysAgo(28)} → ${daysAgo(1)} (vs prior 28 days)\n`);
  console.log('PAGE'.padEnd(60) + 'IMPR'.padStart(10) + 'CLICKS'.padStart(10) + 'CTR'.padStart(8) + 'AVG POS'.padStart(12));
  console.log('-'.repeat(100));
  for (const r of rows) {
    const pos = fmtPos(r.position) + fmtDelta(r.position, r.position_prev, true);
    console.log(
      r.page.padEnd(60) +
      String(r.impr).padStart(10) + fmtDelta(r.impr, r.impr_prev) +
      String(r.clicks).padStart(7) + fmtDelta(r.clicks, r.clicks_prev) +
      ((r.ctr * 100).toFixed(1) + '%').padStart(8) +
      pos.padStart(12)
    );
  }
  const tot = rows.reduce((s, r) => ({ impr: s.impr + r.impr, clicks: s.clicks + r.clicks }), { impr: 0, clicks: 0 });
  console.log('-'.repeat(100));
  console.log('TOTAL (tracked pages)'.padEnd(60) + String(tot.impr).padStart(10) + String(tot.clicks).padStart(10));
  console.log('');
})().catch(e => {
  console.error('FATAL:', e.message);
  if (e.code === 403) console.error('→ The Google account does not own this GSC property, or webmasters.readonly scope was not granted.');
  process.exit(1);
});
