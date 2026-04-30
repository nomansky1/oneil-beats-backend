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
const cfg = require('./config');

// ffmpeg / ffprobe resolution. Prefer the pinned `ffmpeg-static` +
// `ffprobe-static` packages (used by the GH Actions cron worker), but fall
// back to whatever `ffmpeg`/`ffprobe` is on PATH — this lets the desktop-app
// backend run media.js without shipping ~50 MB of per-platform binaries.
const ffmpegPath  = (() => { try { return require('ffmpeg-static');           } catch { return 'ffmpeg';  } })();
const ffprobePath = (() => { try { return require('ffprobe-static').path;     } catch { return 'ffprobe'; } })();

// `sharp` is only used by synthesizeVideoFromAudio's no-cover fallback
// (generates a solid-black 1920×1080 JPG). Lazy-required so desktop-app
// doesn't need to install the native bindings just to call makeThumbnail /
// validateVideo / makeVertical.
function loadSharp() {
  try { return require('sharp'); } catch { return null; }
}

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
      const sharp = loadSharp();
      if (sharp) {
        await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#000' } })
          .jpeg({ quality: 80 }).toFile(coverPath);
      } else {
        // Pure-ffmpeg fallback — generate a solid black frame via lavfi.
        await run(ffmpegPath, [
          '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080',
          '-frames:v', '1', '-q:v', '3', coverPath,
        ]);
      }
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

// ── 4. THUMBNAIL (1280x720, pure-ffmpeg drawtext/drawbox) ────────────────
// Produces a high-CTR YouTube thumbnail: album cover on the right rail,
// blurred+darkened cover as the left background, a big [FREE] badge in the
// top-left, and the title + genre/BPM chip + store brand overlaid on the
// left rail.
//
// Implemented with system `ffmpeg` (via ffmpeg-static when present) using
// drawbox + drawtext filters — NO sharp, NO canvas. Keeps the desktop-app
// backend light (no native-binding installs).
async function makeThumbnail({ beatId, albumCoverPath, title, bpm, genre }) {
  ensureDir(cfg.WORK_DIR);
  const out = path.join(cfg.WORK_DIR, `${beatId}-thumb.jpg`);
  if (fs.existsSync(out)) return out;

  // Resolve cover — fall back to a solid dark frame via lavfi if missing.
  let coverIn = albumCoverPath && fs.existsSync(albumCoverPath) ? albumCoverPath : null;
  if (!coverIn) {
    coverIn = path.join(cfg.WORK_DIR, `${beatId}-cover-black.jpg`);
    if (!fs.existsSync(coverIn)) {
      await run(ffmpegPath, [
        '-y', '-f', 'lavfi', '-i', 'color=c=0x06060a:s=720x720',
        '-frames:v', '1', '-q:v', '3', coverIn,
      ]);
    }
  }

  const fontFile = findFontFile();
  const titleTxt = truncateForThumb(String(title || 'Untitled').toUpperCase(), 16);
  const chipTxt  = `${String(genre || '').toUpperCase()}${bpm ? '  ' + bpm + ' BPM' : ''}`.trim();
  const titleFontSize = titleTxt.length > 12 ? 72 : 96;

  // Build the filter chain. Text layers are added only when we have a
  // resolvable font file — otherwise the thumbnail is image-only (still
  // better than no thumbnail at all).
  const chain = [
    // Blurred, darkened full-frame background from the cover.
    `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=22:3,eq=brightness=-0.35[bg]`,
    // Sharp 720x720 cover anchored to the right rail.
    `[0:v]scale=720:720:force_original_aspect_ratio=increase,crop=720:720[fg]`,
    `[bg][fg]overlay=x=W-w:y=0[base]`,
    // Dark scrim on the left rail for text legibility.
    `[base]drawbox=x=0:y=0:w=720:h=720:color=black@0.55:t=fill[scrim]`,
    // Bright [FREE] badge top-left.
    `[scrim]drawbox=x=40:y=40:w=170:h=64:color=0xff2d77@0.95:t=fill[badge]`,
  ];

  let last = 'badge';
  if (fontFile) {
    const f = ffEscapePath(fontFile);
    // [FREE] text inside the badge.
    chain.push(`[${last}]drawtext=fontfile='${f}':text='FREE':fontcolor=white:fontsize=46:x=75:y=48[t1]`);
    // Genre · BPM chip immediately under the badge.
    chain.push(`[t1]drawtext=fontfile='${f}':text='${ffEscapeText(chipTxt)}':fontcolor=0x19f0ff:fontsize=30:x=44:y=128[t2]`);
    // Big title, roughly centered vertically on the left rail, with shadow.
    chain.push(
      `[t2]drawtext=fontfile='${f}':text='${ffEscapeText(titleTxt)}':fontcolor=white:fontsize=${titleFontSize}:` +
      `x=44:y=(h/2)-(text_h/2)+10:shadowcolor=black@0.75:shadowx=3:shadowy=3[t3]`
    );
    // Brand block bottom-left.
    // Apostrophes inside single-quoted drawtext values are fragile across
    // ffmpeg builds; using the plain form keeps parsing robust.
    chain.push(`[t3]drawtext=fontfile='${f}':text='ONEIL BEATS':fontcolor=white@0.9:fontsize=28:x=44:y=h-86[t4]`);
    chain.push(`[t4]drawtext=fontfile='${f}':text='oneilbeats.store':fontcolor=0x19f0ff:fontsize=28:x=44:y=h-50[vout]`);
    last = 'vout';
  }

  const filter = chain.join(';');
  await run(ffmpegPath, [
    '-y', '-i', coverIn,
    '-filter_complex', filter,
    '-map', `[${last}]`,
    '-frames:v', '1', '-q:v', '3', out,
  ]);

  return out;
}

// Truncate + line-fit a string so drawtext doesn't overflow the left rail.
function truncateForThumb(s, maxChars) {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1).trim() + '…';
}

// Find a TTF for drawtext. Tries the bundled asset first, then common
// per-platform system paths. Returns null if none found (drawtext skipped).
function findFontFile() {
  const candidates = [
    path.join(__dirname, 'assets', 'font-bold.ttf'),
    path.join(__dirname, 'assets', 'Impact.ttf'),
    'C:/Windows/Fonts/impact.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
    'C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/System/Library/Fonts/HelveticaNeue.ttc',
    '/System/Library/Fonts/Helvetica.ttc',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

// ffmpeg filter-graph path escaping: backslashes → forward slashes, then
// escape the Windows drive-letter colon. Required because drawtext parses
// `:` as an option separator inside the filter.
function ffEscapePath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

// ffmpeg drawtext text escaping: escape backslash, single quote, colon,
// percent, and the filter-separator characters.
function ffEscapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  "\\'")
    .replace(/:/g,  '\\:')
    .replace(/%/g,  '\\%');
}

module.exports = {
  synthesizeVideoFromAudio,
  validateVideo,
  prependHook,
  makeVertical,
  makeThumbnail,
  downloadToCache,
};
