'use strict';

// The "truth meter". Every item carries the sources it came from, and the
// level is derived from those sources alone, so the label can always be
// explained to the reader.
//
//   4  Official record  a government feed (police/fire dispatch, NWS, USGS,
//                       FEMA) or a government-verified account published it
//   3  Corroborated     2+ independent established outlets, or 3+ outlets
//                       of any kind
//   2  Single source    one news outlet
//   1  Unverified       community report or unrated social post only

const LEVELS = {
  4: 'Official record',
  3: 'Corroborated',
  2: 'Single source',
  1: 'Unverified',
};

function verify(item) {
  const sources = item.sources || [];
  const official = sources.filter((s) => s.kind === 'official');
  const news = sources.filter((s) => s.kind === 'news');
  const outlets = new Set(news.map((s) => s.name));
  const established = new Set(news.filter((s) => s.tier === 'established').map((s) => s.name));

  if (official.length) {
    return { level: 4, label: LEVELS[4], reason: `Published by ${official[0].name}` };
  }
  if (established.size >= 2 || outlets.size >= 3) {
    return { level: 3, label: LEVELS[3], reason: `${outlets.size} independent outlets report it` };
  }
  if (outlets.size === 1 || outlets.size === 2) {
    const [first] = outlets;
    return {
      level: 2,
      label: LEVELS[2],
      reason: outlets.size === 1 ? `Only ${first} has reported it so far` : `${outlets.size} outlets, not yet independently confirmed`,
    };
  }
  return { level: 1, label: LEVELS[1], reason: 'Not yet confirmed by an official source or news outlet' };
}

function withVerification(item) {
  return { ...item, verification: verify(item) };
}

module.exports = { verify, withVerification, LEVELS };
