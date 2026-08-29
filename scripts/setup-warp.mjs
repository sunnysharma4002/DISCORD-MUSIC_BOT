// Postinstall: vendor the warp-plus binary so yt-dlp can egress through Cloudflare WARP.
//
// WHY: YouTube blocks datacenter IPs with "Sign in to confirm you're not a bot". WARP exit
// IPs are shared with the millions of consumer 1.1.1.1 app users, so they are datacenter-owned
// but not datacenter-shaped — YouTube cannot blanket-block them without breaking real traffic.
//
// WHY warp-plus AND NOT the official client: `cloudflare-warp` needs a TUN device, which needs
// CAP_NET_ADMIN. Managed container hosts don't grant that. warp-plus is a userspace
// wireguard-go implementation that exposes a plain SOCKS5 port instead — no TUN, no root, no
// capabilities. It is a single static Go binary, same deal as the vendored yt-dlp.
//
// The release ships as a .zip, and Node has no zip reader, so there is a minimal one below
// (only STORE and DEFLATE, which is all these archives use).
import { existsSync, mkdirSync, chmodSync, writeFileSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { get } from 'node:https';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

if (process.platform !== 'linux') {
  console.log('[setup-warp] non-Linux platform — WARP proxy is Linux-only, skipping.');
  process.exit(0);
}

/** Pinned release. Bump deliberately: the checksums below must be updated with it. */
const VERSION = 'v1.2.6';

/** sha256 of each release asset, from the GitHub release metadata. */
const ASSETS = {
  x64: {
    name: 'warp-plus_linux-amd64.zip',
    sha256: '380d2c8655b33db818adf407c706d52d14c2ab1764e702e91f356a7d7d9c3c98',
  },
  arm64: {
    name: 'warp-plus_linux-arm64.zip',
    sha256: 'c0b430c117eaa33513fa012aca983303ee88a4bda0f935dc62ff016109e492f3',
  },
};

const asset = ASSETS[process.arch];
if (!asset) {
  console.log(`[setup-warp] no warp-plus build for arch "${process.arch}" — skipping.`);
  process.exit(0);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'vendor');
const outFile = join(outDir, 'warp-plus');
const tmpZip = join(outDir, `${asset.name}.part`);

const URL = `https://github.com/bepass-org/warp-plus/releases/download/${VERSION}/${asset.name}`;

/* Minimal zip reader ---------------------------------------------------- */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/**
 * Extract one entry from a zip archive held in memory.
 *
 * Reads the End of Central Directory record to find the central directory, walks its entries,
 * then follows the matched entry's local-header offset to the compressed bytes. Only STORE (0)
 * and DEFLATE (8) are handled — warp-plus releases use DEFLATE.
 *
 * @param {Buffer} buf whole archive
 * @param {(name: string) => boolean} match predicate over entry names
 * @returns {Buffer} the decompressed entry
 */
function extractFromZip(buf, match) {
  // The EOCD is at the end, but may be followed by a variable-length comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip archive (no end-of-central-directory record)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== CEN_SIG) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }

    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);

    if (match(name)) {
      // Local header is 30 bytes + its own name/extra fields, which may differ from the
      // central directory's, so re-read the lengths here rather than reusing them.
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const data = buf.subarray(dataStart, dataStart + compressedSize);

      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method} for "${name}"`);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error('no matching entry in archive');
}

/* Download -------------------------------------------------------------- */

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));

    get(url, { headers: { 'User-Agent': 'discord-music-bot' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return download(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/* Main ------------------------------------------------------------------ */

mkdirSync(outDir, { recursive: true });

// Unlike yt-dlp, warp-plus does not need to be the latest build — it talks WireGuard, not a
// scraping API. Skip the download when a pinned copy is already vendored.
if (existsSync(outFile)) {
  try {
    const size = statSync(outFile).size;
    if (size > 1_000_000) {
      console.log(`[setup-warp] warp-plus already vendored (${(size / 1024 / 1024).toFixed(1)}MB) — skipping.`);
      process.exit(0);
    }
  } catch { /* fall through and re-download */ }
}

console.log(`[setup-warp] downloading warp-plus ${VERSION} (${asset.name})...`);

try {
  const zip = await download(URL);

  const digest = createHash('sha256').update(zip).digest('hex');
  if (digest !== asset.sha256) {
    // A mismatch means the download was corrupted or the asset was replaced. Either way,
    // do not chmod +x and run it.
    throw new Error(`checksum mismatch\n  expected ${asset.sha256}\n  got      ${digest}`);
  }

  const bin = extractFromZip(zip, (name) => /(^|\/)warp-plus$/.test(name));
  writeFileSync(outFile, bin);
  chmodSync(outFile, 0o755);

  console.log(`[setup-warp] warp-plus installed: ${outFile} (${(bin.length / 1024 / 1024).toFixed(1)}MB)`);
} catch (err) {
  // Never fail the install: WARP is an optional egress path and the bot runs without it.
  console.warn(`[setup-warp] setup failed: ${err.message}`);
  console.warn('[setup-warp] continuing without WARP — yt-dlp will egress via the host IP.');
  try { if (existsSync(tmpZip)) unlinkSync(tmpZip); } catch {}
}
