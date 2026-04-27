#!/usr/bin/env node
// Cloud-runner shim. The heavy lifting (filter graph build, args assembly) is
// done by the desktop app — it serializes the full ffmpeg args array into
// `settings.json` with file-path placeholders __AUDIO__, __COVER__, __OUTPUT__,
// __BG__. This runner just substitutes the actual local paths from the
// downloaded inputs and spawns ffmpeg.
//
// Why placeholder-substitution instead of re-building args server-side: keeps
// the render config in ONE place (desktop-app/backend/server.js). New bg FX,
// new bar styles, new cover fits — all work in the cloud the moment they
// work locally, no separate runner update.
//
// Usage:
//   node render-runner.js <settings.json> <audio.mp3> <cover.jpg> <out.mp4> [bg.jpg]

'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

const [, , settingsPath, audioPath, coverPath, outPath, bgPath] = process.argv;
if (!settingsPath || !audioPath || !coverPath || !outPath) {
  console.error('Usage: node render-runner.js <settings.json> <audio.mp3> <cover.jpg> <out.mp4> [bg.jpg]');
  process.exit(2);
}
if (!fs.existsSync(settingsPath)) { console.error('settings.json not found at', settingsPath); process.exit(2); }
if (!fs.existsSync(audioPath))    { console.error('audio not found at', audioPath); process.exit(2); }
if (!fs.existsSync(coverPath))    { console.error('cover not found at', coverPath); process.exit(2); }

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
if (!Array.isArray(settings.ffmpegArgs) || settings.ffmpegArgs.length === 0) {
  console.error('settings.ffmpegArgs missing or empty');
  process.exit(2);
}

// Substitute placeholders. `bgPath` is optional — drop the entire `-i __BG__`
// pair if no bg image was provided to the workflow (file doesn't exist).
const haveBg = bgPath && fs.existsSync(bgPath);
const subbed = [];
for (let i = 0; i < settings.ffmpegArgs.length; i++) {
  const a = settings.ffmpegArgs[i];
  if (a === '__BG__') {
    if (!haveBg) {
      // Walk back and drop the preceding `-i` so the args list stays valid.
      // Same for any `-loop 1 -r 30 -t <dur>` immediately before the `-i`.
      while (subbed.length > 0) {
        const last = subbed[subbed.length - 1];
        subbed.pop();
        if (last === '-i') break;
      }
      // Also drop `-loop 1 -r 30 -t <dur>` if those preceded the -i for bg
      while (subbed.length >= 2 && subbed[subbed.length - 1] === '-loop' && subbed[subbed.length - 0] === undefined) {
        subbed.pop(); subbed.pop();
      }
      continue;
    }
    subbed.push(bgPath);
    continue;
  }
  subbed.push(
    a.replace(/__AUDIO__/g, audioPath)
     .replace(/__COVER__/g, coverPath)
     .replace(/__OUTPUT__/g, outPath)
     .replace(/__BG__/g, haveBg ? bgPath : '')
  );
}

console.log('[render-runner] ffmpeg with', subbed.length, 'args');
console.log('[render-runner] command:', 'ffmpeg', subbed.map(a => a.includes(' ') ? `"${a}"` : a).join(' ').slice(0, 1500));

// Spawn ffmpeg, inherit stderr so progress shows in workflow logs.
const ff = spawn('ffmpeg', subbed, { stdio: ['ignore', 'pipe', 'inherit'] });
ff.on('error', e => { console.error('ffmpeg spawn error:', e.message); process.exit(1); });
ff.on('close', code => {
  console.log('[render-runner] ffmpeg exit', code);
  process.exit(code === null ? 1 : code);
});
