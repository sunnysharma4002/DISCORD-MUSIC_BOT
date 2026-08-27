import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(__dirname));

/** Default cookie jar location: yt-cookies.txt in the project root. */
const DEFAULT_COOKIE_FILE = join(projectRoot, 'yt-cookies.txt');

/**
 * Cookies that prove a signed-in YouTube session. Without these, YouTube treats the
 * request as anonymous and answers age-gated / bot-checked videos with LOGIN_REQUIRED.
 */
const ESSENTIAL_COOKIES = ['__Secure-1PSID', '__Secure-3PSID', 'HSID', 'SSID', 'SID'];

let _pathCache;
let _headerCache;

/**
 * Absolute path to the Netscape cookie file, or null when none exists.
 * Override the location with YOUTUBE_COOKIE_FILE (absolute or relative to the project root).
 * Pass to yt-dlp as `--cookies <path>`.
 */
export function getCookieFilePath() {
  if (_pathCache !== undefined) return _pathCache;

  const override = process.env.YOUTUBE_COOKIE_FILE?.trim();
  const candidate = override
    ? (isAbsolute(override) ? override : resolve(projectRoot, override))
    : DEFAULT_COOKIE_FILE;

  if (existsSync(candidate)) {
    _pathCache = candidate;
    console.log(`[cookies] using cookie file: ${candidate}`);
  } else {
    _pathCache = null;
    console.warn(`[cookies] no cookie file at ${candidate} — age-restricted videos will fail`);
  }

  return _pathCache;
}

/**
 * Parse a Netscape cookie file into a `Cookie:` header string for youtubei.js.
 *
 * IMPORTANT: Netscape files mark HttpOnly cookies with a literal `#HttpOnly_` prefix on the
 * domain field. That prefix is NOT a comment — skipping those lines drops the cookies that
 * actually authenticate the session (__Secure-1PSID, __Secure-3PSID, HSID, LOGIN_INFO, ...),
 * leaving a half-built session that YouTube answers with a bot check.
 */
export function parseNetscapeCookies(contents) {
  if (!contents) return undefined;
  const trimmed = contents.trim();
  if (!trimmed) return undefined;

  // A plain "name=value; name=value" header has no tab-separated table.
  if (trimmed.includes('=') && !trimmed.includes('\t')) return trimmed;

  const HTTP_ONLY_PREFIX = '#HttpOnly_';
  const pairs = [];
  const seen = new Set();

  for (const rawLine of trimmed.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith(HTTP_ONLY_PREFIX)) {
      line = line.slice(HTTP_ONLY_PREFIX.length);
    } else if (line.startsWith('#')) {
      continue; // genuine comment
    }

    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const name = parts[5]?.trim();
    const value = parts[6]?.trim();
    if (!name || value === undefined) continue;

    // A cookie name may appear only once in a header; later entries win.
    if (seen.has(name)) {
      const idx = pairs.findIndex((p) => p.startsWith(`${name}=`));
      if (idx !== -1) pairs.splice(idx, 1);
    }
    seen.add(name);
    pairs.push(`${name}=${value}`);
  }

  if (pairs.length === 0) return undefined;

  const missing = ESSENTIAL_COOKIES.filter((n) => !seen.has(n));
  if (missing.length) {
    console.warn(`[cookies] jar is missing ${missing.join(', ')} — session may not authenticate`);
  }

  return pairs.join('; ');
}

/**
 * The cookie jar as a `Cookie:` header string for youtubei.js, or undefined when unavailable.
 */
export function getCookieHeader() {
  if (_headerCache !== undefined) return _headerCache;

  const path = getCookieFilePath();
  if (!path) {
    _headerCache = undefined;
    return _headerCache;
  }

  try {
    const header = parseNetscapeCookies(readFileSync(path, 'utf8'));
    _headerCache = header;
    if (header) {
      const count = header.split('; ').length;
      console.log(`[cookies] loaded ${count} cookies for youtubei.js`);
    } else {
      console.warn(`[cookies] ${path} contained no usable cookies`);
    }
  } catch (err) {
    console.warn(`[cookies] failed to read ${path}: ${err.message}`);
    _headerCache = undefined;
  }

  return _headerCache;
}

/** Browser UA used when validating the jar against youtube.com. */
const VALIDATE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let _sessionCache;

/**
 * Ask YouTube whether the jar is actually signed in, and grab the Data Sync ID.
 *
 * This matters because youtubei.js infers `logged_in` purely from SAPISID being present —
 * an expired or revoked jar still parses, still looks complete, and still makes the library
 * attach SAPISIDHASH auth headers. Sending authentication that doesn't authenticate is a
 * strong bot signal on a datacenter IP, and it also means a PoToken bound to visitor_data
 * is the wrong binding (a logged-in session must bind to the Data Sync ID).
 *
 * @returns {Promise<{ loggedIn: boolean, dataSyncId: string | null, visitorData: string | null }>}
 */
export async function validateCookieSession() {
  if (_sessionCache !== undefined) return _sessionCache;

  const header = getCookieHeader();
  if (!header) {
    _sessionCache = { loggedIn: false, dataSyncId: null, visitorData: null };
    return _sessionCache;
  }

  try {
    const res = await fetch('https://www.youtube.com/', {
      headers: { Cookie: header, 'User-Agent': VALIDATE_UA },
    });

    if (!res.ok) {
      console.warn(`[cookies] validation request failed: HTTP ${res.status}`);
      _sessionCache = { loggedIn: false, dataSyncId: null, visitorData: null };
      return _sessionCache;
    }

    const html = await res.text();
    const loggedIn = /"LOGGED_IN":\s*true/.test(html);

    // Logged-out sessions still carry a DATASYNC_ID, but in the form "Ve649ed21||".
    // A real one starts with the numeric account id: "1029623964...||".
    const dsMatch = html.match(/"DATASYNC_ID":"([^"]+)"/);
    const rawDataSync = dsMatch ? dsMatch[1] : null;
    const dataSyncId = rawDataSync && /^\d+\|\|/.test(rawDataSync)
      ? rawDataSync.replace(/\|\|$/, '')
      : null;

    const vdMatch = html.match(/"VISITOR_DATA":"([^"]+)"/);
    const visitorData = vdMatch ? vdMatch[1] : null;

    if (loggedIn && dataSyncId) {
      console.log('[cookies] session validated: signed in');
    } else if (loggedIn) {
      console.warn('[cookies] session reports signed in but has no Data Sync ID');
    } else {
      console.warn('[cookies] jar is NOT signed in (expired or revoked) — ignoring it');
      console.warn('[cookies] re-export yt-cookies.txt from a browser where you are signed in');
    }

    _sessionCache = { loggedIn: loggedIn && Boolean(dataSyncId), dataSyncId, visitorData };
    return _sessionCache;
  } catch (err) {
    console.warn(`[cookies] could not validate session: ${err.message}`);
    // Network failure is not proof the jar is bad; assume usable and let InnerTube decide.
    _sessionCache = { loggedIn: true, dataSyncId: null, visitorData: null };
    return _sessionCache;
  }
}

/**
 * The cookie header, but only when the jar is a genuinely signed-in session.
 * Returns undefined for a dead jar so we make clean anonymous requests instead of
 * sending broken credentials.
 */
export async function getValidatedCookieHeader() {
  const { loggedIn } = await validateCookieSession();
  return loggedIn ? getCookieHeader() : undefined;
}

/** Clears the caches so the next call re-reads the file from disk. */
export function resetCookieCache() {
  _pathCache = undefined;
  _headerCache = undefined;
  _sessionCache = undefined;
}
