'use strict';

// Background "newly listed" registry alerts. pg_cron in the alerts
// database calls /api/registry-watch every 15 minutes; this checks each
// watched area's registry and pushes anything new to the phones watching
// it. Notifications carry no names; tapping one opens the record in the app.
const db = require('./alerts-db');
const push = require('./push');
const { registrantsNear, SOURCES } = require('./sources/registry');

// Iowa allows under 50 requests an hour in all, and people using the app
// need most of them.
const IOWA_PER_RUN = 3;

function messageFor(fresh, area, source) {
  const one = fresh.length === 1;
  return {
    title: one ? 'Newly listed near you' : `${fresh.length} newly listed near you`,
    body: `${one ? 'A registered sex offender now lists an address' : 'Registered sex offenders now list addresses'} within ${area.radius_mi} mi on the ${source.agency} registry. Tap to view.`,
    tag: fresh[0].id,
    open: { kind: 'reg', id: fresh[0].id },
  };
}

async function runWatch({ budgetMs = 45000 } = {}) {
  const started = Date.now();
  const report = { areas: 0, checked: 0, skipped: 0, capped: 0, fresh: 0, sent: 0, gone: 0, failed: 0, errors: [] };
  const areas = await db.watchAreas();
  report.areas = areas.length;
  let iowa = 0;
  for (const a of areas) {
    const tooLate = Date.now() - started > budgetMs;
    if (tooLate || !SOURCES[a.state] || (a.state === 'IA' && iowa >= IOWA_PER_RUN)) { report.skipped += 1; continue; }
    if (a.state === 'IA') iowa += 1;
    try {
      const result = await registrantsNear(a.state, { lat: a.lat, lon: a.lon }, a.radius_mi);
      const fresh = new Set(await db.watchDiff(a.area_key, result.registrants.map((r) => r.id)));
      report.checked += 1;
      // A capped answer (more people than the registry returns at once)
      // shifts from check to check, so it can't tell who is newly listed.
      if (!result.complete) { report.capped += 1; continue; }
      const news = result.registrants.filter((r) => fresh.has(r.id));
      if (!news.length) continue;
      report.fresh += news.length;
      const message = messageFor(news, a, result.source);
      for (const s of await db.areaSubscribers(a.area_key)) {
        const out = await push.send(s, message);
        report[out.status] += 1;
        if (out.status === 'gone') await db.unsubscribe(s.endpoint).catch(() => {});
        if (out.error && report.errors.length < 5) report.errors.push(out.error);
      }
    } catch (err) {
      if (report.errors.length < 5) report.errors.push(`${a.state}: ${err.message}`);
    }
  }
  return report;
}

module.exports = { runWatch, messageFor, IOWA_PER_RUN };
