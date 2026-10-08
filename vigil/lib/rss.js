'use strict';

// Minimal RSS 2.0 reader — enough for Google News search feeds without
// pulling in an XML dependency.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? { attrs: m[1] || '', text: decode(m[2]) } : null;
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : '';
}

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const title = tag(block, 'title');
    const link = tag(block, 'link');
    const pub = tag(block, 'pubDate');
    const source = tag(block, 'source');
    items.push({
      title: title ? title.text : '',
      link: link ? link.text : '',
      published: pub ? new Date(pub.text).toISOString() : null,
      sourceName: source ? source.text : '',
      sourceUrl: source ? attr(source.attrs, 'url') : '',
    });
  }
  return items;
}

module.exports = { parseRss, decode };
