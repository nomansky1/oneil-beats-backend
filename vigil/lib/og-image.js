'use strict';

// The share image a publisher sets for its own article (og:image or
// twitter:image), the same picture chat apps show as a link preview. We
// only keep its URL: the image stays on the publisher's server, is shown
// with credit and links back to the article.
const { fetchText } = require('./http');

function safeImage(u, base) {
  if (!u) return '';
  try {
    const url = new URL(String(u).trim(), base);
    return url.protocol === 'https:' && url.href.length < 1000 ? url.href : '';
  } catch {
    return '';
  }
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/gi, '/');

function ogImageFrom(html, pageUrl) {
  const head = String(html).slice(0, 300000);
  const found = {};
  for (const tag of head.match(/<meta\s[^>]*>/gi) || []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const val = /content\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!key || !val) continue;
    const k = key[1].toLowerCase();
    if (/^og:image(:secure_url|:url)?$/.test(k) && !found.og) found.og = safeImage(decode(val[1]), pageUrl);
    if (/^twitter:image(:src)?$/.test(k) && !found.tw) found.tw = safeImage(decode(val[1]), pageUrl);
  }
  return found.og || found.tw || '';
}

async function ogImage(pageUrl) {
  const html = await fetchText(pageUrl, { ttl: 12 * 3600, timeoutMs: 3500, headers: { Accept: 'text/html' } });
  return ogImageFrom(html, pageUrl);
}

module.exports = { ogImage, ogImageFrom, safeImage };
