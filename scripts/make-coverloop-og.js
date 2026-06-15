// Generates the CoverLoop Open Graph / social share image (1200x630 PNG).
//   node scripts/make-coverloop-og.js  →  public/coverloop-og.png
// Run again to regenerate after editing the design. Uses sharp (already a dep).
const sharp = require('sharp');
const path = require('path');

// faux equalizer bars along the bottom-right for flavor
let bars = '';
const heights = [34, 58, 26, 72, 44, 90, 38, 64, 30, 80, 48, 96, 36, 60, 28, 76, 50, 88];
heights.forEach((h, i) => {
  const x = 690 + i * 28;
  bars += `<rect x="${x}" y="${560 - h}" width="16" height="${h}" rx="3" fill="url(#gold)" opacity="0.92"/>`;
});

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f0d57a"/><stop offset="1" stop-color="#d4af37"/>
    </linearGradient>
    <radialGradient id="bg" cx="50%" cy="-10%" r="90%">
      <stop offset="0" stop-color="#241a08"/><stop offset="0.55" stop-color="#0d0d12"/><stop offset="1" stop-color="#08080b"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="630" fill="none" stroke="#23232c" stroke-width="2"/>
  <!-- brand -->
  <rect x="64" y="58" width="34" height="34" rx="9" fill="url(#gold)"/>
  <text x="112" y="84" font-family="Arial, Helvetica, sans-serif" font-size="29" font-weight="700" fill="#f2f2f5">CoverLoop</text>
  <text x="1136" y="84" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#9a9aa6">by O'Neil Beats</text>
  <!-- headline -->
  <text x="64" y="288" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="800" fill="#ffffff">Turn your beats into</text>
  <text x="64" y="374" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="800" fill="url(#gold)">YouTube videos.</text>
  <text x="64" y="438" font-family="Arial, Helvetica, sans-serif" font-size="27" fill="#cfcfd6">AI cover art &#183; reactive visualizers &#183; cut-scenes &#183; auto-publish</text>
  <!-- equalizer flavor -->
  ${bars}
  <text x="64" y="585" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="600" fill="#d4af37">oneilbeats.store/coverloop</text>
</svg>`;

const out = path.join(__dirname, '..', 'public', 'coverloop-og.png');
sharp(Buffer.from(svg)).png().toFile(out)
  .then((info) => console.log('wrote', out, info.width + 'x' + info.height, Math.round(info.size / 1024) + 'KB'))
  .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
