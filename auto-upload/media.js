// Media pipeline: validate → prepend 3s hook → crop to 9:16 → render thumbnail.
//
// All outputs land in cfg.WORK_DIR keyed by beat_id so retries reuse them
// (each of these takes 5–30s to run; no point re-rendering on retry).
//
// FFmpeg binary provided by `ffmpeg-static` so you don't need system ffmpeg.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const sharp = require('sharp');
const cfg = require('./config');

const run = async (bin, args, opts = {}) => {
  try {
    return await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().slice(-400);
    throw new Error(`${path.basename(bin)} failed: ${msg.trim()}`);
  }
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Download a URL (or copy a local path) to a cache file in WORK_DIR.
// Idempotent: if the cached file already exists, returns immediately.
async function downloadToCache(urlOrPath, cacheName) {
  ensureDir(cfg.WORK_DIR);
  const out = path.join(cfg.WORK_DIR, cacheName);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;

  // Local file? Just copy.
  if (!/^https?:\/\//i.test(urlOrPath)) {
    if (!fs.existsSync(urlOrPath)) throw new Error(`source not found: ${urlOrPath}`);
    fs.copyFileSync(urlOrPath, out);
    return out;
  }

  const client = urlOrPath.startsWith('https') ? https : http;
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(out);
    const req = client.get(urlOrPath, (res) => {
      // Follow one redirect.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(out);
        downloadToCache(res.headers.location, cacheName).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(out);
        return reject(new Error(`download ${urlOrPath} → HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (e) => { try { fs.unlinkSync(out); } catch {} reject(e); });
  });
  return out;
}

// ── 0. SYNTHESIZE VIDEO FROM AUDIO + COVER ────────────────────────────────
// Produces the 16:9 "type beat" video every YouTube music channel uses:
// a static cover image over the full beat audio, 1920×1080 @ 30fps. This
// is what the pipeline assumes downstream when no pre-rendered video is
// supplied on enqueue.
//
// Downloads are cached in WORK_DIR so retries don't re-pull from Supabase.
async function synthesizeVideoFromAudio({ beatId, audioUrl, coverUrl }) {
  if (!audioUrl) throw new Error('audioUrl required for synthesis');
  ensureDir(cfg.WORK_DIR);
  const out = path.join(cfg.WORK_DIR, `${beatId}-synth.mp4`);

  // Download audio + cover (cached). Cover is optional — we fall back to
  // a solid-black frame if missing so the render doesn't fail mid-pipeline.
  const audioExt = (audioUrl.match(/\.(mp3|wav|m4a|aac)(?:\?|$)/i) || [, 'mp3'])[1];
  const audioPath = await downloadToCache(audioUrl, `${beatId}-audio.${audioExt}`);

  let coverPath;
  if (coverUrl) {
    try {
      const coverExt = (coverUrl.match(/\.(jpe?g|png|webp)(?:\?|$)/i) || [, 'jpg'])[1];
      coverPath = await downloadToCache(coverUrl, `${beatId}-cover.${coverExt}`);
    } catch (e) {
      coverPath = null; // fall through to solid-black below
    }
  }

  if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
    return { videoPath: out, coverPath };
  }

  // If no cover, generate a 1920×1080 black JPG to feed ffmpeg as -loop input.
  if (!coverPath) {
    coverPath = path.join(cfg.WORK_DIR, `${beatId}-cover-black.jpg`);
    if (!fs.existsSync(coverPath)) {
      await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#000' } })
        .jpeg({ quality: 80 }).toFile(coverPath);
    }
  }

  // Static cover + audio → 16:9 MP4. `-tune stillimage` tells x264 to
  // allocate almost no bits to the (unchanging) video, keeping file size
  // small. `-shortest` ends at audio length.
  await run(ffmpegPath, [
    '-y',
    '-loop', '1', '-framerate', '2', '-i', coverPath,
    '-i', audioPath,
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p',
    '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'medium', '-crf', '22',
    '-r', '30',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart', out,
  ]);

  return { videoPath: out, coverPath };
}

// ── 1. VALIDATE ──────────────────────────────────────────────────────────
// File exists AND duration is in [MIN, MAX] seconds. Throws if not.
async function validateVideo(videoPath) {
  if (!videoPath) throw new Error('videoPath missing');
  if (!fs.existsSync(videoPath)) throw new Error(`video not found: ${videoPath}`);
  const { stdout } = await run(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
  ]);
  const dur = parseFloat(String(stdout).trim());
  if (!Number.isFinite(dur)) throw new Error(`could not read duration of ${videoPath}`);
  if (dur < cfg.MIN_DURATION_SEC || dur > cfg.MAX_DURATION_SEC) {
    throw new Error(`duration ${dur.toFixed(1)}s outside required ${cfg.MIN_DURATION_SEC}–${cfg.MAX_DURATION_SEC}s window`);
  }
  return dur;
}

// ── 2. PREPEND 3s HOOK ───────────────────────────────────────────────────
// Takes the existing 16:9 MP4 and prepends a 3s silent-with-hook-audio
// intro card (still frame of album cover, hook audio). This is the video
// that becomes the YouTube upload.
//
// If HOOK_AUDIO_PATH doesn't exist, we skip the hook step entirely and
// return the source video unchanged. Ship-without-setup mode.
async function prependHook({ beatId, videoPath, albumCoverPath }) {
  ensureDir(cfg.WORK_DIR);
  const out = path.join(cfg.WORK_DIR, `${beatId}-with-hook.mp4`);
  if (fs.existsSync(out)) return out; // cached from prior attempt

  if (!fs.existsSync(cfg.HOOK_AUDIO_PATH)) {
    // No hook configured → just use the original video. Everything downstream
    // (vertical render, thumbnail, upload) still works.
    return videoPath;
  }

  // Build a 3-second still from the album cover at the same resolution as
  // the main video, then concat. Using concat demuxer with transcoding so
  // codec/timebase mismatches don't break the join.
  const intro = path.join(cfg.WORK_DIR, `${beatId}-intro.mp4`);
  const cover = albumCoverPath && fs.existsSync(albumCoverPath)
    ? albumCoverPath
    : await derivePosterFromVideo(videoPath, beatId);

  await run(ffmpegPath, [
    '-y', '-loop', '1', '-t', '3', '-i', cover,
    '-i', cfg.HOOK_AUDIO_PATH,
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest', intro,
  ]);

  // Concat via filter_complex (safer than demuxer when sources differ).
  await run(ffmpegPath, [
    '-y', '-i', intro, '-i', videoPath,
    '-filter_complex',
    '[0:v]scale=1920:1080,setsar=1[v0];[1:v]scale=1920:1080,setsar=1[v1];' +
    '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[vout][aout]',
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
  ]);

  fs.unlinkSync(intro);
  return out;
}

// Fallback poster frame at 1s if no albumCoverPath was given.
async function derivePosterFromVideo(videoPath, beatId) {
  const out = path.join(cfg.WORK_DIR, `${beatId}-poster.jpg`);
  await run(ffmpegPath, ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

// ── 3. MAKE VERTICAL 9:16 ────────────────────────────────────────────────
// Takes the hooked 16:9 video and produces a 1080x1920 version by placing
// the 16:9 frame in the middle of a blurred-enlarged copy of itself (the
// "blur pad" treatment). This looks infinitely better than black bars on
// Reels/TikTok and is the standard for music videos on those platforms.
async function makeVertical({ beatId, videoPath }) {
  ensureDir(cfg.WORK_DIR);
  const out = path.join(cfg.WORK_DIR, `${beatId}-vertical.mp4`);
  if (fs.existsSync(out)) return out;

  await run(ffmpegPath, [
    '-y', '-i', videoPath,
    '-filter_complex',
    // Two copies of input: one scaled/blurred to fill 1080x1920, one centered.
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:4[bg];' +
    '[0:v]scale=1080:-2[fg];' +
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[vout]',
    '-map', '[vout]', '-map', '0:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    '-r', '30', out,
  ]);
  return out;
}

// ── 4. THUMBNAIL (1280x720, dark/neon overlay) ───────────────────────────
// sharp composites the album cover, a dark gradient, a neon stroke ring,
// and an SVG overlay with title + BPM + genre. SVG text is crisp at 1280
// and doesn't need native `canvas` bindings.
async function makeThumbnail({ beatId, albumCoverPath, title, bpm, genre }) {
  ensureDir(cfg.WORK_DIR);
  const out = path.join(cfg.WORK_DIR, `${beatId}-thumb.jpg`);
  if (fs.existsSync(out)) return out;

  const W = 1280, H = 720;
  const neon = '#ff2d77';       // hot pink-red
  const neon2 = '#19f0ff';      // cyan

  // Base: cover image, cover-fit blurred + brightened background, original
  // on the right-third rail for visual anchor.
  const coverBuf = albumCoverPath && require('fs').existsSync(albumCoverPath)
    ? await sharp(albumCoverPath).resize(720, 720, { fit: 'cover' }).toBuffer()
    : await sharp({ create: { width: 720, height: 720, channels: 3, background: '#06060a' } }).png().toBuffer();

  const blurBg = await sharp(coverBuf)
    .resize(W, H, { fit: 'cover' })
    .modulate({ brightness: 0.4 })
    .blur(18)
    .toBuffer();

  // SVG overlay: gradient scrim left→right, title, genre/BPM chip, neon
  // corner ticks. Fonts are `sans-serif` so it renders on any box without
  // shipping a font file.
  const escapedTitle = escapeXml(String(title || '').toUpperCase());
  const chip = `${escapeXml(String(genre || '').toUpperCase())}${bpm ? ` · ${bpm} BPM` : ''}`;
  const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="scrim" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"  stop-color="#000" stop-opacity="0.85"/>
          <stop offset="60%" stop-color="#000" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0"/>
        </linearGradient>
        <filter id="glow"><feGaussianBlur stdDeviation="3"/></filter>
      </defs>

      <!-- Left scrim for text legibility -->
      <rect width="100%" height="100%" fill="url(#scrim)"/>

      <!-- Neon corner ticks -->
      <path d="M32 32 L32 120 M32 32 L120 32" stroke="${neon}" stroke-width="6" fill="none"/>
      <path d="M${W-32} ${H-32} L${W-32} ${H-120} M${W-32} ${H-32} L${W-120} ${H-32}"
            stroke="${neon2}" stroke-width="6" fill="none"/>

      <!-- Genre/BPM chip -->
      <rect x="60" y="72" rx="8" ry="8" width="${Math.min(520, chip.length*18+40)}" height="44"
            fill="rgba(255,45,119,0.18)" stroke="${neon}" stroke-width="2"/>
      <text x="80" y="103" fill="${neon}" font-family="Impact, Arial Black, sans-serif"
            font-size="24" font-weight="900" letter-spacing="2">${chip}</text>

      <!-- Title, 2 lines max -->
      <text x="60" y="${H/2 + 20}" fill="#fff" font-family="Impact, Arial Black, sans-serif"
            font-size="${escapedTitle.length > 12 ? 96 : 128}" font-weight="900"
            letter-spacing="1" filter="url(#glow)">${escapedTitle}</text>

      <!-- Brand -->
      <text x="60" y="${H - 60}" fill="#fff" font-family="Arial, sans-serif"
            font-size="28" font-weight="700" opacity="0.85">O'NEIL BEATS · FREE BEAT</text>
      <text x="60" y="${H - 30}" fill="${neon2}" font-family="Arial, sans-serif"
            font-size="22" font-weight="700">oneilbeats.store</text>
    </svg>
  `;

  // Composite: blurBg + cover-right + svg overlay
  await sharp(blurBg)
    .composite([
      { input: coverBuf, left: W - 720, top: 0 },
      { input: Buffer.from(svg) },
    ])
    .jpeg({ quality: 86, progressive: true })
    .toFile(out);

  return out;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;',
  }[c]));
}

module.exports = {
  synthesizeVideoFromAudio,
  validateVideo,
  prependHook,
  makeVertical,
  makeThumbnail,
  downloadToCache,
};
