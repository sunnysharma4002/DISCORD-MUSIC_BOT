// Postinstall fixup for youtube-sr@4.3.12.
// Its parseVideo() assumes videoRenderer.ownerText.runs[0].navigationEndpoint
// .browseEndpoint always exists; YouTube now omits it for some results, throwing
// "Cannot read properties of undefined (reading 'browseId')".
// Fresh installs (e.g. Railway) don't carry our local node_modules edit, so we
// re-apply the optional-chaining fix here after every npm install.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'node_modules', 'youtube-sr', 'dist', 'mod.js');

if (!existsSync(target)) {
  console.warn('[fix-youtube-sr] mod.js not found — skipping.');
  process.exit(0);
}

let src = readFileSync(target, 'utf8');

const broken =
  'id: data.videoRenderer.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId || null,\n' +
  '        name: data.videoRenderer.ownerText.runs[0].text || null,\n' +
  '        url: `https://www.youtube.com${data.videoRenderer.ownerText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl || data.videoRenderer.ownerText.runs[0].navigationEndpoint.commandMetadata.webCommandMetadata.url}`,';

const fixed =
  'id: data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,\n' +
  '        name: data.videoRenderer.ownerText?.runs?.[0]?.text || null,\n' +
  '        url: `https://www.youtube.com${data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`,';

if (src.includes(fixed)) {
  console.log('[fix-youtube-sr] already patched.');
  process.exit(0);
}

if (!src.includes(broken)) {
  console.warn('[fix-youtube-sr] expected code not found (version changed?) — skipping.');
  process.exit(0);
}

src = src.replace(broken, fixed);
writeFileSync(target, src);
console.log('[fix-youtube-sr] patched parseVideo() ownerText access.');
