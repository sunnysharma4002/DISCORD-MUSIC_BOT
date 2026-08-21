// Postinstall fixup for youtube-sr@4.3.12.
// YouTube intermittently omits ownerText/shortBylineText in renderers, causing
// "Cannot read properties of undefined (reading 'browseId')" crashes.
// This script patches ALL unsafe access points in the library.
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
let patched = 0;

// Helper: replace unsafe browseId chain with safe optional chaining
function safeBrowseId(obj, prop) {
  return `${obj}?.${prop}?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null`;
}

function safeBrowseUrl(obj, prop) {
  return `\`${obj}?.${prop}?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || ${obj}?.${prop}?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}\``;
}

// Patch 1: videoRenderer ownerText (line ~701)
const p1_old = 'id: data.videoRenderer.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId || null,\n' +
  '        name: data.videoRenderer.ownerText.runs[0].text || null,\n' +
  '        url: `https://www.youtube.com${data.videoRenderer.ownerText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl || data.videoRenderer.ownerText.runs[0].navigationEndpoint.commandMetadata.webCommandMetadata.url}`,';
const p1_new = 'id: data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,\n' +
  '        name: data.videoRenderer.ownerText?.runs?.[0]?.text || null,\n' +
  '        url: `https://www.youtube.com${data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`,';
if (src.includes(p1_old)) { src = src.replace(p1_old, p1_new); patched++; }

// Patch 2: playlistRenderer shortBylineText (line ~730)
const p2_old = 'id: data.playlistRenderer.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId,\n' +
  '          name: data.playlistRenderer.shortBylineText.runs[0].text,';
const p2_new = 'id: data.playlistRenderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,\n' +
  '          name: data.playlistRenderer.shortBylineText?.runs?.[0]?.text || null,';
if (src.includes(p2_old)) { src = src.replace(p2_old, p2_new); patched++; }

// Patch 3: video info shortBylineText (line ~761)
const p3_old = 'id: info.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId || null,\n' +
  '            name: info.shortBylineText.runs[0].text || null,\n' +
  '            url: `https://www.youtube.com${info.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl || info.shortBylineText.runs[0].navigationEndpoint.commandMetadata.webCommandMetadata.url}`,';
const p3_new = 'id: info.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,\n' +
  '            name: info.shortBylineText?.runs?.[0]?.text || null,\n' +
  '            url: `https://www.youtube.com${info.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || info.shortBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`,';
if (src.includes(p3_old)) { src = src.replace(p3_old, p3_new); patched++; }

// Patch 4: videoOwnerRenderer (line ~808)
const p4_old = 'id: author.videoOwnerRenderer.title.runs[0].navigationEndpoint.browseEndpoint.browseId,';
const p4_new = 'id: author.videoOwnerRenderer?.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,';
if (src.includes(p4_old)) { src = src.replace(p4_old, p4_new); patched++; }

// Patch 5: details shortBylineText in search (line ~925)
const p5_old = 'id: details.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId,';
const p5_new = 'id: details.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,';
if (src.includes(p5_old)) { src = src.replace(p5_old, p5_new); patched++; }

// Patch 6: t.shortBylineText in playlist videos (line ~973)
const p6_old = 'id: t.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId,';
const p6_new = 'id: t.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,';
if (src.includes(p6_old)) { src = src.replace(p6_old, p6_new); patched++; }

// Patch 7: item.ownerText in related videos (line ~1257)
const p7_old = 'id: item.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId,';
const p7_new = 'id: item.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,';
if (src.includes(p7_old)) { src = src.replace(p7_old, p7_new); patched++; }

if (patched === 0) {
  console.log('[fix-youtube-sr] already patched (no changes needed).');
} else {
  writeFileSync(target, src);
  console.log(`[fix-youtube-sr] patched ${patched} browseId crash site(s).`);
}
