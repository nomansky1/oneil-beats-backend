'use strict';

// Socrata "floating" timestamps have no zone (e.g. "2026-10-08T14:02:11.000")
// and are in the city's local time. Convert one to a real UTC instant.
function zonedToUtc(floating, timeZone) {
  if (!floating) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(floating)) return new Date(floating).toISOString();
  const asUtc = new Date(`${floating.replace(' ', 'T').slice(0, 19)}Z`);
  if (Number.isNaN(asUtc.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(asUtc).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = wall - asUtc.getTime();
  return new Date(asUtc.getTime() - offset).toISOString();
}

// The reverse: a UTC instant as a floating local timestamp for SoQL filters.
function utcToFloating(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((o, p) => ((o[p.type] = p.value), o), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

module.exports = { zonedToUtc, utcToFloating };
