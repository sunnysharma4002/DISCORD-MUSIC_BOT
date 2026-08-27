import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { USER_AGENT, buildURL, getHeaders } from 'bgutils-js/utils';

/**
 * Generates a Proof-of-Origin Token (PoToken) by running Google's BotGuard VM locally.
 *
 * YouTube hands out a scrambled JS challenge; BotGuard evaluates it in a browser-like
 * environment and produces a snapshot that Google exchanges for an integrity token. That
 * token mints the PoToken bound to our visitor_data. This is what stops YouTube answering
 * `LOGIN_REQUIRED / Sign in to confirm you're not a bot` on a datacenter IP.
 *
 * The VM needs real DOM globals, so we back it with jsdom. Both are regular dependencies
 * (bgutils-js, jsdom) — nothing is downloaded at runtime beyond the challenge itself.
 */

/** Public request key used by YouTube's own web player. Not a secret. */
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

/** Tokens are valid ~6h in practice; we refresh well inside that. */
const GENERATE_TIMEOUT_MS = 60_000;

let _domInstalled = false;

/**
 * Installs the minimum browser globals BotGuard touches. Done once per process.
 * We deliberately do NOT overwrite an existing `navigator` (Node 21+ defines its own).
 */
async function installDomGlobals() {
  if (_domInstalled) return;

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT,
  });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.origin = dom.window.origin;

  if (!Reflect.has(globalThis, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
  }

  _domInstalled = true;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Mint a PoToken bound to the given visitor data (or Data Sync ID for logged-in sessions).
 *
 * @param {string} contentBinding visitor_data (URL-decoded) or datasync ID
 * @returns {Promise<string>} web-safe base64 PoToken
 */
export async function generatePoToken(contentBinding) {
  if (!contentBinding) throw new Error('generatePoToken requires a content binding');

  await installDomGlobals();

  const challenge = await withTimeout(
    getChallenge({ requestKey: REQUEST_KEY, fetchFunction: fetch }),
    GENERATE_TIMEOUT_MS,
    'BotGuard challenge fetch',
  );
  if (!challenge) throw new Error('BotGuard returned no challenge');

  const interpreterJs =
    challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreterJs) throw new Error('BotGuard challenge has no interpreter JavaScript');

  // The interpreter is a self-contained IIFE that registers itself on globalThis.
  new Function(interpreterJs)();

  const webPoSignalOutput = [];
  const botguard = await withTimeout(
    BotGuardClient.create({
      globalName: challenge.globalName,
      globalObject: globalThis,
      program: challenge.program,
    }),
    GENERATE_TIMEOUT_MS,
    'BotGuard VM load',
  );

  const snapshot = await withTimeout(
    botguard.snapshot({ webPoSignalOutput }),
    GENERATE_TIMEOUT_MS,
    'BotGuard snapshot',
  );

  const response = await withTimeout(
    fetch(buildURL('GenerateIT', true), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify([REQUEST_KEY, snapshot]),
    }),
    GENERATE_TIMEOUT_MS,
    'GenerateIT request',
  );

  if (!response.ok) {
    throw new Error(`GenerateIT failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const integrityToken = data?.[0];
  if (!integrityToken) throw new Error('GenerateIT returned no integrity token');

  const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  const poToken = await minter.mintAsWebsafeString(contentBinding);

  // Free the VM; it holds timers that would otherwise keep the event loop busy.
  try { await botguard.shutdown(); } catch { /* best effort */ }

  if (!poToken) throw new Error('minter produced an empty PoToken');
  return poToken;
}
