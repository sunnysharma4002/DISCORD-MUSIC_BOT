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

/**
 * Cookies YouTube clears (empty value + past expiry) when it decides a session is dead.
 * Seeing these in a `Set-Cookie` response is proof of server-side revocation, which is a
 * different failure from on-disk expiry and needs a different fix.
 */
const AUTH_COOKIES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO',
];

/** Short-lived cookies whose expiry says nothing about whether the session is alive. */
const EPHEMERAL_PREFIXES = ['ST-', 'YSC', 'GPS', 'CONSISTENCY', 'VISITOR_INFO', 'PREF'];

function isEphemeral(name) {
  return EPHEMERAL_PREFIXES.some((p) => name.startsWith(p));
}

let _pathCache;
let _headerCache;
let _entriesCache;

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
 * Parse a Netscape cookie file into structured entries.
 *
 * IMPORTANT: Netscape files mark HttpOnly cookies with a literal `#HttpOnly_` prefix on the
 * domain field. That prefix is NOT a comment — skipping those lines drops the cookies that
 * actually authenticate the session (__Secure-1PSID, __Secure-3PSID, HSID, LOGIN_INFO, ...),
 * leaving a half-built session that YouTube answers with a bot check.
 *
 * @returns {Array<{ name: string, value: string, domain: string, expires: number }>}
 *          `expires` is a unix timestamp in seconds; 0 means a session cookie.
 */
export function parseNetscapeEntries(contents) {
  if (!contents) return [];
  const trimmed = contents.trim();
  if (!trimmed) return [];

  // A plain "name=value; name=value" header has no tab-separated table.
  if (trimmed.includes('=') && !trimmed.includes('\t')) {
    return trimmed
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        if (eq === -1) return null;
        return { name: part.slice(0, eq), value: part.slice(eq + 1), domain: '', expires: 0 };
      })
      .filter(Boolean);
  }

  const HTTP_ONLY_PREFIX = '#HttpOnly_';
  const byName = new Map();

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

    const expires = Number.parseInt(parts[4], 10);

    // A cookie name may appear only once in a header; later entries win.
    byName.set(name, {
      name,
      value,
      domain: parts[0]?.trim() ?? '',
      expires: Number.isFinite(expires) ? expires : 0,
    });
  }

  return [...byName.values()];
}

/** Cached structured view of the jar on disk. */
function getCookieEntries() {
  if (_entriesCache !== undefined) return _entriesCache;

  const path = getCookieFilePath();
  if (!path) {
    _entriesCache = [];
    return _entriesCache;
  }

  try {
    _entriesCache = parseNetscapeEntries(readFileSync(path, 'utf8'));
  } catch (err) {
    console.warn(`[cookies] failed to read ${path}: ${err.message}`);
    _entriesCache = [];
  }

  return _entriesCache;
}

/**
 * Static analysis of the jar on disk — no network. Tells apart the failure modes that all
 * previously surfaced as one vague "expired or revoked" line:
 *   - `missing`      : no jar file at all
 *   - `incomplete`   : jar exists but lacks the cookies that carry the session
 *   - `expired`      : the auth cookies themselves are past their expiry date
 *   - `ok`           : nothing wrong on disk (may still be revoked server-side)
 *
 * @returns {{ verdict: 'missing'|'incomplete'|'expired'|'ok', total: number,
 *             missing: string[], expired: string[], soonest: { name: string, date: string } | null }}
 */
export function inspectCookieJar() {
  const entries = getCookieEntries();

  if (entries.length === 0) {
    return { verdict: 'missing', total: 0, missing: [...ESSENTIAL_COOKIES], expired: [], soonest: null };
  }

  const names = new Set(entries.map((e) => e.name));
  const missing = ESSENTIAL_COOKIES.filter((n) => !names.has(n));

  const nowSec = Math.floor(Date.now() / 1000);
  const expired = entries
    .filter((e) => AUTH_COOKIES.includes(e.name) && e.expires > 0 && e.expires < nowSec)
    .map((e) => e.name);

  // Earliest upcoming expiry among cookies that actually matter, for a heads-up before it bites.
  const upcoming = entries
    .filter((e) => e.expires > nowSec && !isEphemeral(e.name))
    .sort((a, b) => a.expires - b.expires)[0];

  const soonest = upcoming
    ? { name: upcoming.name, date: new Date(upcoming.expires * 1000).toISOString().slice(0, 10) }
    : null;

  let verdict = 'ok';
  if (missing.length) verdict = 'incomplete';
  else if (expired.length) verdict = 'expired';

  return { verdict, total: entries.length, missing, expired, soonest };
}

/**
 * Parse a Netscape cookie file into a `Cookie:` header string for youtubei.js.
 */
export function parseNetscapeCookies(contents) {
  const entries = parseNetscapeEntries(contents);
  if (entries.length === 0) return undefined;

  const names = new Set(entries.map((e) => e.name));
  const missing = ESSENTIAL_COOKIES.filter((n) => !names.has(n));
  if (missing.length) {
    console.warn(`[cookies] jar is missing ${missing.join(', ')} — session may not authenticate`);
  }

  return entries.map((e) => `${e.name}=${e.value}`).join('; ');
}

/**
 * The cookie jar as a `Cookie:` header string for youtubei.js, or undefined when unavailable.
 */
export function getCookieHeader() {
  if (_headerCache !== undefined) return _headerCache;

  const entries = getCookieEntries();
  if (entries.length === 0) {
    const path = getCookieFilePath();
    if (path) console.warn(`[cookies] ${path} contained no usable cookies`);
    _headerCache = undefined;
    return _headerCache;
  }

  const names = new Set(entries.map((e) => e.name));
  const missing = ESSENTIAL_COOKIES.filter((n) => !names.has(n));
  if (missing.length) {
    console.warn(`[cookies] jar is missing ${missing.join(', ')} — session may not authenticate`);
  }

  _headerCache = entries.map((e) => `${e.name}=${e.value}`).join('; ');
  console.log(`[cookies] loaded ${entries.length} cookies for youtubei.js`);
  return _headerCache;
}

/** Browser UA used when validating the jar against youtube.com. */
const VALIDATE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let _sessionCache;

/**
 * Detect a server-side logout. When Google decides a session is dead it replies with
 * `Set-Cookie: SID=; expires=<past date>` for every auth cookie — an explicit instruction to
 * delete them. That is proof of revocation, and it is invisible to on-disk expiry checks:
 * the file can hold cookies dated a year out that Google already threw away.
 *
 * @returns {string[]} names of auth cookies the server told us to delete
 */
function detectRevokedCookies(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];

  const revoked = new Set();
  const nowMs = Date.now();

  for (const raw of setCookies) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;

    const name = raw.slice(0, eq);
    if (!AUTH_COOKIES.includes(name)) continue;

    const value = raw.slice(eq + 1).split(';')[0].trim();
    const expiresMatch = raw.match(/expires=([^;]+)/i);
    const expiresMs = expiresMatch ? Date.parse(expiresMatch[1].replace(/-/g, ' ')) : NaN;

    // Empty value, or an expiry in the past, both mean "delete this".
    if (value === '' || (Number.isFinite(expiresMs) && expiresMs < nowMs)) {
      revoked.add(name);
    }
  }

  return [...revoked];
}

/**
 * Ask YouTube whether the jar is actually signed in, and grab the Data Sync ID.
 *
 * This matters because youtubei.js infers `logged_in` purely from SAPISID being present —
 * an expired or revoked jar still parses, still looks complete, and still makes the library
 * attach SAPISIDHASH auth headers. Sending authentication that doesn't authenticate is a
 * strong bot signal on a datacenter IP, and it also means a PoToken bound to visitor_data
 * is the wrong binding (a logged-in session must bind to the Data Sync ID).
 *
 * @returns {Promise<{ loggedIn: boolean, dataSyncId: string | null, visitorData: string | null,
 *                     reason: string | null, revoked: string[] }>}
 */
export async function validateCookieSession() {
  if (_sessionCache !== undefined) return _sessionCache;

  const jar = inspectCookieJar();

  const header = getCookieHeader();
  if (!header) {
    _sessionCache = {
      loggedIn: false,
      dataSyncId: null,
      visitorData: null,
      reason: jar.verdict === 'missing' ? 'no cookie file' : 'jar has no usable cookies',
      revoked: [],
    };
    return _sessionCache;
  }

  // On-disk problems are decisive: don't spend a round-trip proving what the file already says.
  if (jar.verdict === 'incomplete') {
    console.warn(`[cookies] jar is incomplete — missing ${jar.missing.join(', ')}`);
    console.warn('[cookies] export ALL cookies for youtube.com, including HttpOnly ones');
    _sessionCache = {
      loggedIn: false,
      dataSyncId: null,
      visitorData: null,
      reason: `missing ${jar.missing.join(', ')}`,
      revoked: [],
    };
    return _sessionCache;
  }

  if (jar.verdict === 'expired') {
    console.warn(`[cookies] auth cookies are past their expiry date: ${jar.expired.join(', ')}`);
    console.warn('[cookies] re-export yt-cookies.txt from a browser where you are signed in');
    _sessionCache = {
      loggedIn: false,
      dataSyncId: null,
      visitorData: null,
      reason: `expired on disk: ${jar.expired.join(', ')}`,
      revoked: [],
    };
    return _sessionCache;
  }

  try {
    const res = await fetch('https://www.youtube.com/', {
      headers: { Cookie: header, 'User-Agent': VALIDATE_UA },
    });

    if (!res.ok) {
      console.warn(`[cookies] validation request failed: HTTP ${res.status}`);
      _sessionCache = {
        loggedIn: false,
        dataSyncId: null,
        visitorData: null,
        reason: `validation HTTP ${res.status}`,
        revoked: [],
      };
      return _sessionCache;
    }

    const revoked = detectRevokedCookies(res);
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

    let reason = null;

    if (loggedIn && dataSyncId) {
      console.log('[cookies] session validated: signed in');
      if (jar.soonest) {
        console.log(`[cookies] next cookie expiry: ${jar.soonest.name} on ${jar.soonest.date}`);
      }
    } else if (loggedIn) {
      reason = 'signed in but no Data Sync ID';
      console.warn(`[cookies] ${reason}`);
    } else if (revoked.length) {
      // The decisive case: file looks fine, Google disagrees.
      reason = `revoked server-side (YouTube cleared ${revoked.join(', ')})`;
      console.warn(`[cookies] jar was REVOKED by YouTube — it cleared ${revoked.join(', ')}`);
      console.warn('[cookies] the cookies are not expired on disk; the account session itself was invalidated');
      console.warn('[cookies] cause: signing out in the source browser, a password change, or Google');
      console.warn('[cookies]        rejecting the session because it is being replayed from a datacenter IP');
      console.warn('[cookies] fix: re-export from a private window, then close it WITHOUT signing out');
    } else {
      reason = 'not signed in';
      console.warn('[cookies] jar is NOT signed in — YouTube returned a logged-out page');
      console.warn('[cookies] re-export yt-cookies.txt from a browser where you are signed in');
    }

    _sessionCache = {
      loggedIn: loggedIn && Boolean(dataSyncId),
      dataSyncId,
      visitorData,
      reason,
      revoked,
    };
    return _sessionCache;
  } catch (err) {
    console.warn(`[cookies] could not validate session: ${err.message}`);
    // Network failure is not proof the jar is bad; assume usable and let InnerTube decide.
    _sessionCache = {
      loggedIn: true,
      dataSyncId: null,
      visitorData: null,
      reason: null,
      revoked: [],
    };
    return _sessionCache;
  }
}

/**
 * One-shot startup report on the cookie jar.
 *
 * The old behaviour buried the single most consequential fact — that YouTube playback will
 * fall back to anonymous and fail on anything gated — inside two warn lines among ~40 other
 * startup lines. This states it plainly and, with YOUTUBE_REQUIRE_COOKIES=true, refuses to
 * start rather than serving a bot that cannot play most tracks.
 *
 * @returns {Promise<boolean>} whether the jar is usable
 */
export async function reportCookieStatus() {
  const jar = inspectCookieJar();
  const session = await validateCookieSession();

  const require = /^(1|true|yes)$/i.test(process.env.YOUTUBE_REQUIRE_COOKIES?.trim() ?? '');

  if (session.loggedIn) {
    console.log(`[cookies] PREFLIGHT OK — signed-in jar, ${jar.total} cookies`);
    return true;
  }

  const lines = [
    '[cookies] PREFLIGHT FAILED — the YouTube cookie jar is not usable',
    `[cookies]   reason: ${session.reason ?? 'unknown'}`,
    `[cookies]   file:   ${getCookieFilePath() ?? '<none>'}`,
    `[cookies]   jar:    ${jar.total} cookies, verdict=${jar.verdict}`,
    '[cookies]   effect: all YouTube requests fall back to anonymous. Age-gated and',
    '[cookies]           label-owned videos will fail with LOGIN_REQUIRED / bot check.',
  ];

  if (require) {
    lines.push('[cookies]   YOUTUBE_REQUIRE_COOKIES=true → refusing to start.');
    for (const line of lines) console.error(line);
    return false;
  }

  lines.push('[cookies]   set YOUTUBE_REQUIRE_COOKIES=true to make this fatal instead.');
  for (const line of lines) console.warn(line);
  return false;
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
  _entriesCache = undefined;
  _sessionCache = undefined;
}
