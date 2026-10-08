'use strict';

// Outlet tiers used by the truth meter. "established" means a newsroom with
// named editors and a corrections policy. Everything we can't place is
// "unrated" and still shown, just never counted as independent confirmation.
//
// This list is a starting point. In production it should be a reviewed table
// with a public changelog, so anyone can see why an outlet is (or isn't) here.
const ESTABLISHED = new Set([
  'apnews.com', 'reuters.com', 'npr.org', 'pbs.org', 'cbsnews.com', 'nbcnews.com',
  'abcnews.go.com', 'cnn.com', 'usatoday.com', 'nytimes.com', 'washingtonpost.com',
  'wsj.com', 'latimes.com', 'chicagotribune.com', 'bostonglobe.com', 'sfchronicle.com',
  'seattletimes.com', 'dallasnews.com', 'houstonchronicle.com', 'miamiherald.com',
  'ajc.com', 'freep.com', 'detroitnews.com', 'mlive.com', 'startribune.com',
  'denverpost.com', 'azcentral.com', 'oregonlive.com', 'nola.com', 'tampabay.com',
  'elnuevodia.com', 'primerahora.com', 'guampdn.com', 'postguam.com',
  'virginislandsdailynews.com', 'samoanews.com', 'mvariety.com',
  'propublica.org', 'axios.com', 'thecity.nyc', 'gothamist.com', 'kqed.org', 'wbez.org',
  'opb.org', 'wamu.org', 'wnyc.org', 'michiganradio.org', 'wgvunews.org',
]);

// US broadcast call signs start with K or W (e.g. wzzm13.com, kare11.com,
// wood tv's woodtv.com). This catches most local TV and radio newsrooms.
const CALL_SIGN = /^(?:www\.)?[kw][a-z]{2,3}(?:tv|fm|am)?\d{0,2}\.(?:com|org|tv)$/i;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function tierFor(url) {
  const host = hostOf(url);
  if (!host) return 'unrated';
  if (/\.(gov|mil)$/.test(host) || /\.(state|ci|co)\.[a-z]{2}\.us$/.test(host)) return 'gov';
  if (ESTABLISHED.has(host)) return 'established';
  for (const domain of ESTABLISHED) if (host.endsWith(`.${domain}`)) return 'established';
  if (CALL_SIGN.test(host)) return 'established';
  return 'unrated';
}

module.exports = { tierFor, hostOf, ESTABLISHED };
