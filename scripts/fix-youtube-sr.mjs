// Postinstall fixup for youtube-sr@4.3.12.
// YouTube intermittently omits ownerText/shortBylineText/navigationEndpoint in
// renderers, causing crashes. This patches ALL unsafe access points.
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

function patchAll(patterns) {
  for (const [oldStr, newStr] of patterns) {
    if (src.includes(oldStr)) {
      src = src.replace(oldStr, newStr);
      patched++;
    }
  }
}

// Patch all unsafe browseId + canonicalBaseUrl + url access patterns
patchAll([
  // 1. videoRenderer ownerText (line ~701) - id, name, url
  [
    'id: data.videoRenderer.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId || null,\n' +
    '        name: data.videoRenderer.ownerText.runs[0].text || null,\n' +
    '        url: `https://www.youtube.com${data.videoRenderer.ownerText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl || data.videoRenderer.ownerText.runs[0].navigationEndpoint.commandMetadata.webCommandMetadata.url}`,',
    'id: data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,\n' +
    '        name: data.videoRenderer.ownerText?.runs?.[0]?.text || null,\n' +
    '        url: `https://www.youtube.com${data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || data.videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`,'
  ],
  // 2. playlistRenderer shortBylineText (line ~730) - id, name, url
  [
    'id: data.playlistRenderer.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId,\n' +
    '          name: data.playlistRenderer.shortBylineText.runs[0].text,',
    'id: data.playlistRenderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,\n' +
    '          name: data.playlistRenderer.shortBylineText?.runs?.[0]?.text || null,'
  ],
  // playlist URL pattern
  [
    'url: `https://www.youtube.com${((_a = data.playlistRenderer.shortBylineText.runs[0].navigationEndpoint.browseEndpoint) == null ? void 0 : _a.canonicalBaseUrl) || ((_c = (_b = data.playlistRenderer.shortBylineText.runs[0].navigationEndpoint.commandMetadata) == null ? void 0 : _b.webCommandMetadata) == null ? void 0 : _c.url)}`',
    'url: `https://www.youtube.com${data.playlistRenderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || data.playlistRenderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`'
  ],
  // 3. video info shortBylineText (line ~761) - id, name, url
  [
    'id: info.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId || null,\n' +
    '            name: info.shortBylineText.runs[0].text || null,\n' +
    '            url: `https://www.youtube.com${info.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl || info.shortBylineText.runs[0].navigationEndpoint.commandMetadata.webCommandMetadata.url}`,',
    'id: info.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,\n' +
    '            name: info.shortBylineText?.runs?.[0]?.text || null,\n' +
    '            url: `https://www.youtube.com${info.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || info.shortBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`,'
  ],
  // 4. videoOwnerRenderer (line ~808) - id, url
  [
    'id: author.videoOwnerRenderer.title.runs[0].navigationEndpoint.browseEndpoint.browseId,',
    'id: author.videoOwnerRenderer?.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,'
  ],
  [
    'url: `https://www.youtube.com${author.videoOwnerRenderer.navigationEndpoint.commandMetadata.webCommandMetadata.url || author.videoOwnerRenderer.navigationEndpoint.browseEndpoint.canonicalBaseUrl}`',
    'url: `https://www.youtube.com${author.videoOwnerRenderer?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || author.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || ""}`'
  ],
  // 5. channel owner (line ~877)
  [
    'url: `https://www.youtube.com${info.owner.videoOwnerRenderer.title.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl}`',
    'url: `https://www.youtube.com${info.owner?.videoOwnerRenderer?.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || info.owner?.videoOwnerRenderer?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`'
  ],
  // 6. details shortBylineText (line ~925)
  [
    'id: details.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId,',
    'id: details.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,'
  ],
  [
    'url: `https://www.youtube.com${details.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl}`',
    'url: `https://www.youtube.com${details.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || details.shortBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`'
  ],
  // 7. t.shortBylineText (line ~973)
  [
    'id: t.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId,',
    'id: t.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,'
  ],
  [
    'url: `https://www.youtube.com${t.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl}`',
    'url: `https://www.youtube.com${t.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || t.shortBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`'
  ],
  // 8. item.ownerText (line ~1257)
  [
    'id: item.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId,',
    'id: item.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,'
  ],
  [
    'url: `https://www.youtube.com${item.ownerText.runs[0].navigationEndpoint.browseEndpoint.canonicalBaseUrl}`',
    'url: `https://www.youtube.com${item.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || item.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`'
  ],
  // 9. channelRenderer (line ~665)
  [
    'let url = `https://www.youtube.com${data.channelRenderer.navigationEndpoint.browseEndpoint.canonicalBaseUrl || data.channelRenderer.navigationEndpoint.commandMetadata.webCommandMetadata.url}`;',
    'let url = `https://www.youtube.com${data.channelRenderer?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || data.channelRenderer?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || ""}`;'
  ],
]);

if (patched === 0) {
  console.log('[fix-youtube-sr] already patched (no changes needed).');
} else {
  writeFileSync(target, src);
  console.log(`[fix-youtube-sr] patched ${patched} crash site(s).`);
}
