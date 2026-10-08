'use strict';

const ACCOUNTS = require('../data/x-accounts');
const { haversineMi } = require('./geo');

function covers(area, c) {
  if (area === 'national') return true;
  if (area.bbox) {
    const [s, w, n, e] = area.bbox;
    return c.lat >= s && c.lat <= n && c.lon >= w && c.lon <= e;
  }
  return haversineMi(c, area) <= area.radiusMi;
}

// Local accounts first, national ones last.
function accountsFor(center) {
  const pick = ({ handle, name, kind }) => ({ handle, name, kind, url: `https://x.com/${handle}` });
  const local = ACCOUNTS.filter((a) => a.area !== 'national' && covers(a.area, center)).map(pick);
  const national = ACCOUNTS.filter((a) => a.area === 'national').map(pick);
  return local.concat(national);
}

module.exports = { accountsFor, covers };
