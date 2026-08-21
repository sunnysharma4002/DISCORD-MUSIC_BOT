// Postinstall: provide a python-free yt-dlp on Linux (Railway).
//
// youtube-dl-exec bundles the yt-dlp *zipapp*, whose shebang is
//   #!/usr/bin/env python3
// Railway's runtime image has no python3 → "env: 'python3': No such file or
// directory" (exit 127). The standalone `yt-dlp_linux` build is a PyInstaller
// binary that embeds its own Python, so it runs anywhere with zero deps.
//
// We download it once during install to vendor/yt-dlp and mark it executable.
// Windows/macOS dev keeps using the youtube-dl-exec binary (see Player.js).
import { existsSync, mkdirSync, chmodSync, createWriteStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { get } from 'node:https';

if (process.platform !== 'linux') {
  console.log('[setup-ytdlp] non-Linux platform — using bundled binary, skipping.');
  process.exit(0);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'vendor');
const outFile = join(outDir, 'yt-dlp');
const URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

mkdirSync(outDir, { recursive: true });

// Always download latest — YouTube changes frequently and stale yt-dlp breaks.
console.log('[setup-ytdlp] downloading latest yt-dlp...');

function download(url, redirects = 0) {
  if (redirects > 5) {
    console.warn('[setup-ytdlp] too many redirects — skipping.');
    process.exit(0);
  }
  get(url, { headers: { 'User-Agent': 'discord-music-bot' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      return download(res.headers.location, redirects + 1);
    }
    if (res.statusCode !== 200) {
      console.warn(`[setup-ytdlp] download failed HTTP ${res.statusCode} — skipping.`);
      res.resume();
      process.exit(0);
    }
    const file = createWriteStream(outFile);
    res.pipe(file);
    file.on('finish', () => file.close(() => {
      try {
        chmodSync(outFile, 0o755);
        const size = statSync(outFile).size;
        console.log(`[setup-ytdlp] yt-dlp installed: ${outFile} (${(size/1024/1024).toFixed(1)}MB)`);
      } catch (err) {
        console.warn('[setup-ytdlp] chmod failed:', err.message);
      }
    }));
  }).on('error', (err) => {
    console.warn('[setup-ytdlp] download error:', err.message, '— skipping.');
    process.exit(0);
  });
}

download(URL);
