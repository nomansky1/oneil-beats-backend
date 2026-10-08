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

// Main time zone for each state and territory, used to read local
// timestamps from city open-data portals. A few states span two zones; the
// zone of their larger cities is used.
const STATE_TZ = {
  Alabama: 'America/Chicago', Alaska: 'America/Anchorage', Arizona: 'America/Phoenix', Arkansas: 'America/Chicago',
  California: 'America/Los_Angeles', Colorado: 'America/Denver', Connecticut: 'America/New_York', Delaware: 'America/New_York',
  'District of Columbia': 'America/New_York', Florida: 'America/New_York', Georgia: 'America/New_York', Hawaii: 'Pacific/Honolulu',
  Idaho: 'America/Boise', Illinois: 'America/Chicago', Indiana: 'America/Indiana/Indianapolis', Iowa: 'America/Chicago',
  Kansas: 'America/Chicago', Kentucky: 'America/New_York', Louisiana: 'America/Chicago', Maine: 'America/New_York',
  Maryland: 'America/New_York', Massachusetts: 'America/New_York', Michigan: 'America/Detroit', Minnesota: 'America/Chicago',
  Mississippi: 'America/Chicago', Missouri: 'America/Chicago', Montana: 'America/Denver', Nebraska: 'America/Chicago',
  Nevada: 'America/Los_Angeles', 'New Hampshire': 'America/New_York', 'New Jersey': 'America/New_York', 'New Mexico': 'America/Denver',
  'New York': 'America/New_York', 'North Carolina': 'America/New_York', 'North Dakota': 'America/Chicago', Ohio: 'America/New_York',
  Oklahoma: 'America/Chicago', Oregon: 'America/Los_Angeles', Pennsylvania: 'America/New_York', 'Rhode Island': 'America/New_York',
  'South Carolina': 'America/New_York', 'South Dakota': 'America/Chicago', Tennessee: 'America/Chicago', Texas: 'America/Chicago',
  Utah: 'America/Denver', Vermont: 'America/New_York', Virginia: 'America/New_York', Washington: 'America/Los_Angeles',
  'West Virginia': 'America/New_York', Wisconsin: 'America/Chicago', Wyoming: 'America/Denver',
  'Puerto Rico': 'America/Puerto_Rico', Guam: 'Pacific/Guam', 'U.S. Virgin Islands': 'America/St_Thomas',
  'American Samoa': 'Pacific/Pago_Pago', 'Northern Mariana Islands': 'Pacific/Saipan',
};
const tzForState = (state) => STATE_TZ[state] || 'America/New_York';

module.exports = { zonedToUtc, utcToFloating, tzForState, STATE_TZ };
