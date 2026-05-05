// One-shot generator: pulls every Pollinations URL referenced inside the
// blog-post bodyHtml strings of scripts/build-beat-pages.js, downloads the
// image, and saves it to public/img/blog/{slug}-{hero|mid}.jpg.
//
// Why this exists:
//   The first version of the blog-images change embedded live Pollinations
//   URLs in the rendered HTML. That works in dev but is fragile in prod —
//   every page view hits image.pollinations.ai, which can be slow or fail.
//   Static files baked into the Vercel deploy are fast, reliable, and
//   cacheable at the CDN edge.
//
// Run: `node scripts/generate-blog-images.js` (no args). Idempotent — if a
// file already exists at the target path, the URL is skipped unless you pass
// `--force`. Output files go in `public/img/blog/`.

const fs = require('fs');
const path = require('path');
const https = require('https');

const FORCE = process.argv.includes('--force');
const OUT_DIR = path.join(__dirname, '..', 'public', 'img', 'blog');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Stable seed mapping that mirrors what build-beat-pages.js uses inline.
// Keep this in sync with the blogFigure() seeds in BLOG_POSTS.
const IMAGES = [
  { slug: 'ai-reggaeton', kind: 'hero', width: 1200, height: 630, seed: 20260505,
    prompt: 'modern reggaeton music producer studio, split scene comparison, left side cluttered laptop showing AI music generation interface with waveforms, right side professional producer at hardware audio mixing console with studio monitors and microphone, dim red and gold ambient lighting, palm tree silhouette through window at sunset, cinematic editorial photography, photorealistic, no text no words no letters' },
  { slug: 'ai-reggaeton', kind: 'mid', width: 1100, height: 620, seed: 20260506,
    prompt: 'modern major music label corporate boardroom with executives in suits reviewing AI music platform partnership contract on giant illuminated screen showing audio waveform analysis and royalty data, sleek glass office with floor to ceiling windows at sunset over city skyline, blue and gold lighting, photorealistic editorial photography, dramatic composition, no text no words no letters' },
  { slug: 'lease-vs-exclusive', kind: 'hero', width: 1200, height: 630, seed: 11420260,
    prompt: 'professional beat license contract document on dark wooden desk in music studio, audio waveform glowing red and gold overlaid on the page, headphones and pen beside it, mixing console blurred in background, dramatic side lighting, photorealistic editorial style, no text no words no letters' },
  { slug: 'lease-vs-exclusive', kind: 'mid', width: 1100, height: 620, seed: 11420261,
    prompt: 'calculator and streaming royalty earnings chart bar graph on a sleek modern desk, smartphone showing a music streaming app interface with play counts, headphones, warm golden lamp light, music business analysis aesthetic, photorealistic editorial photography, no text no words no letters' },
  { slug: 'how-to-write', kind: 'hero', width: 1200, height: 630, seed: 41420260,
    prompt: 'Latin reggaeton recording session in a modern professional studio, vocalist at large diaphragm condenser microphone with pop filter, mixing engineer at a wide audio console with red and gold LED indicators, palm tree silhouette through window at golden hour sunset, cinematic warm lighting, photorealistic editorial photography, hip hop urban aesthetic, no text no words no letters' },
  { slug: 'how-to-write', kind: 'mid', width: 1100, height: 620, seed: 41420261,
    prompt: 'songwriter at home studio writing in lyric notebook with reggaeton beat playing on studio monitors, headphones around neck, smartphone with voice memo recording, warm amber lamp lighting, focused thoughtful expression, urban Latino aesthetic, photorealistic editorial photography, no text no words no letters' },
  { slug: 'free-vs-paid', kind: 'hero', width: 1200, height: 630, seed: 31420260,
    prompt: 'modern music producer studio with two large monitors comparing audio waveforms side by side, left waveform with overlay watermarks indicating producer voice tag, right waveform clean and pristine, professional editorial composition, dramatic red and gold studio lighting, photorealistic, no text no words no letters' },
  { slug: 'free-vs-paid', kind: 'mid', width: 1100, height: 620, seed: 31420261,
    prompt: 'producer in dark home studio with hands on hardware audio mixer, professional condenser microphone with pop filter foreground, multiple monitors showing audio editing software, deep red ambient lighting with subtle gold accents, hip hop urban aesthetic, photorealistic editorial photography, no text no words no letters' },
  { slug: 'how-to-find', kind: 'hero', width: 1200, height: 630, seed: 42620260,
    prompt: 'young independent rapper at home bedroom studio with laptop showing music beat marketplace interface, USB condenser microphone in foreground, headphones on desk, hoodie wearing artist focused on screen, warm golden bedroom lamp lighting, urban aesthetic, photorealistic editorial photography, no text no words no letters' },
  { slug: 'how-to-find', kind: 'mid', width: 1100, height: 620, seed: 42620261,
    prompt: 'smartphone voice memo recording app capturing vocal demo over playing reggaeton beat, sticky notes with handwritten lyrics scattered on a wooden desk, headphones beside, focused songwriting atmosphere, warm amber lamp lighting, intimate creative workspace, photorealistic editorial photography, no text no words no letters' },
];

function buildUrl(img) {
  return 'https://image.pollinations.ai/prompt/' + encodeURIComponent(img.prompt)
    + '?width=' + img.width + '&height=' + img.height + '&seed=' + img.seed
    + '&nologo=true&model=flux';
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = https.get(url, { headers: { 'User-Agent': 'oneilbeats-blog-image-gen/1.0' } }, (res) => {
      // Pollinations sometimes 302s to a CDN URL — follow once.
      if (res.statusCode === 301 || res.statusCode === 302) {
        const next = res.headers.location;
        res.resume();
        return download(next, outPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(outPath, buf);
        const ms = Date.now() - start;
        resolve({ bytes: buf.length, ms });
      });
      res.on('error', reject);
    });
    req.setTimeout(120_000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

(async () => {
  console.log('Generating', IMAGES.length, 'blog images →', OUT_DIR);
  for (const img of IMAGES) {
    const filename = `${img.slug}-${img.kind}.jpg`;
    const outPath = path.join(OUT_DIR, filename);
    if (fs.existsSync(outPath) && !FORCE) {
      console.log('SKIP', filename, '(exists, pass --force to redo)');
      continue;
    }
    const url = buildUrl(img);
    process.stdout.write('GET  ' + filename + ' ');
    try {
      const { bytes, ms } = await download(url, outPath);
      console.log(`✓ ${(bytes / 1024).toFixed(0)}KB in ${(ms / 1000).toFixed(1)}s`);
    } catch (err) {
      console.log('✗ ' + err.message);
    }
  }
  console.log('done.');
})();
