'use strict';

// Local server: serves public/ and runs api/*.js the way Vercel does.
//   npm run dev            live upstream data
//   npm run dev:fixtures   canned upstream responses from test/fixtures
const http = require('http');
const fs = require('fs');
const path = require('path');

if (process.env.VIGIL_FIXTURES) require('./test/fixture-fetch').install();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
    const file = path.join(__dirname, 'api', `${name}.js`);
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('{"error":"Not found"}'); }
    req.query = Object.fromEntries(url.searchParams);
    return require(file)(req, res);
  }
  const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Vigil running at http://localhost:${PORT}${process.env.VIGIL_FIXTURES ? ' (fixture data)' : ''}`));
