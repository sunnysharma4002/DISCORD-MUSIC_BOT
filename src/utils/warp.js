// Cloudflare WARP egress for yt-dlp.
//
// THE PROBLEM: YouTube answers "Sign in to confirm you're not a bot" for requests from
// datacenter IP ranges, regardless of cookies or PoToken. Nothing in-process fixes that —
// the block is on the source address.
//
// THE APPROACH: route yt-dlp through Cloudflare WARP. WARP exit addresses are shared with
// the consumer 1.1.1.1 app's user base, so they are datacenter-owned but carry ordinary
// consumer traffic. YouTube cannot blanket-block them the way it blocks a hosting provider's
// ranges. This is not guaranteed to work — WARP ranges do get rate-limited — but it is free
// and costs one process.
//
// WHY warp-plus: the official cloudflare-warp client needs a TUN device and CAP_NET_ADMIN,
// which managed container hosts do not grant. warp-plus is a userspace wireguard-go build
// that exposes a SOCKS5 port instead, so it needs no privileges at all. yt-dlp speaks SOCKS5
// natively via --proxy.
//
// The binary is vendored by scripts/setup-warp.mjs. Everything here degrades to "no proxy"
// when it is absent, so nothing breaks on Windows or when setup was skipped.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_BIN = join(projectRoot, 'vendor', 'warp-plus');
const CACHE_DIR = join(projectRoot, '.cache', 'warp');

/** Where warp-plus listens. Loopback only — never expose this port. */
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8086;

/** warp-plus registers with Cloudflare on first run; that can take a while on a cold cache. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;

/** How long to wait for the exit-IP probe before giving up on it (non-fatal). */
const PROBE_TIMEOUT_MS = 15_000;

let _proc = null;
let _proxyUrl = null;
let _startPromise = null;
let _exitInfo = null;

/** Absolute path to the warp-plus binary, or null when it is not vendored. */
function resolveBin() {
  const override = process.env.WARP_BIN?.trim();
  const candidate = override || DEFAULT_BIN;
  return existsSync(candidate) ? candidate : null;
}

function port() {
  const raw = Number(process.env.WARP_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT;
}

/**
 * Whether to run WARP at all.
 *
 * Default is "on when possible": enabled if the binary exists. WARP_ENABLED=false opts out
 * explicitly; WARP_ENABLED=true makes a missing binary a loud warning rather than silence.
 */
function isEnabled() {
  const raw = process.env.WARP_ENABLED?.trim();
  if (raw && /^(0|false|no|off)$/i.test(raw)) return false;
  return true;
}

/* SOCKS5 client --------------------------------------------------------- */
//
// Just enough of RFC 1928 to confirm the proxy is really proxying. A TCP connect to the bind
// port only proves something is listening; it does not prove WARP finished its WireGuard
// handshake. Completing a CONNECT and reading a real HTTP response does.

/**
 * Open a TCP tunnel through the SOCKS5 proxy to `host:targetPort`.
 * @returns {Promise<net.Socket>} a socket with the tunnel established
 */
function socks5Connect(proxyPort, host, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: HOST, port: proxyPort });
    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    const fail = (msg) => {
      sock.destroy();
      reject(new Error(msg));
    };

    const timer = setTimeout(() => fail(`SOCKS5 handshake timed out in stage "${stage}"`), timeoutMs);

    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    sock.on('connect', () => {
      // VER=5, NMETHODS=1, METHOD=0 (no auth)
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail(`bad SOCKS version in greeting reply: ${buf[0]}`);
        if (buf[1] !== 0x00) return fail(`proxy demands auth method ${buf[1]}, expected none`);
        buf = buf.subarray(2);
        stage = 'connect';

        // VER=5, CMD=1 (CONNECT), RSV=0, ATYP=3 (domain name)
        const name = Buffer.from(host, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]);
        sock.write(req);
        return;
      }

      if (stage === 'connect') {
        if (buf.length < 5) return;
        if (buf[1] !== 0x00) return fail(`SOCKS5 CONNECT rejected with code ${buf[1]}`);

        // Reply length varies by bound-address type; skip past it before handing over.
        const atyp = buf[3];
        let addrLen;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) addrLen = 1 + buf[4];
        else return fail(`unknown SOCKS5 address type ${atyp}`);

        const total = 4 + addrLen + 2;
        if (buf.length < total) return;

        const leftover = buf.subarray(total);
        clearTimeout(timer);
        sock.removeAllListeners('data');
        sock.removeAllListeners('error');
        if (leftover.length) sock.unshift(leftover);
        resolve(sock);
      }
    });
  });
}

/**
 * Ask Cloudflare what it sees, through the tunnel.
 *
 * `/cdn-cgi/trace` answers with `ip=` and `warp=on|off|plus`. `warp=off` means traffic went out
 * without the WireGuard tunnel — the proxy is up but useless, which is worth knowing at startup
 * rather than discovering as a stream failure later.
 *
 * @returns {Promise<{ ip: string | null, warp: string | null }>}
 */
async function probeExit(proxyPort) {
  const sock = await socks5Connect(proxyPort, 'connectivity.cloudflareclient.com', 80, PROBE_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let body = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('trace request timed out'));
    }, PROBE_TIMEOUT_MS);

    sock.on('data', (c) => { body += c.toString('utf8'); });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('end', () => {
      clearTimeout(timer);
      const ip = body.match(/^ip=(.+)$/m)?.[1]?.trim() ?? null;
      const warp = body.match(/^warp=(.+)$/m)?.[1]?.trim() ?? null;
      resolve({ ip, warp });
    });

    sock.write(
      'GET /cdn-cgi/trace HTTP/1.1\r\n' +
      'Host: connectivity.cloudflareclient.com\r\n' +
      'User-Agent: discord-music-bot\r\n' +
      'Connection: close\r\n\r\n',
    );
  });
}

/** Resolves once something accepts TCP on the bind port. */
function waitForPort(p, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        return reject(new Error(`warp-plus did not open ${HOST}:${p} within ${READY_TIMEOUT_MS}ms`));
      }

      const sock = net.createConnection({ host: HOST, port: p });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        setTimeout(attempt, READY_POLL_MS);
      });
    };
    attempt();
  });
}

/* Lifecycle ------------------------------------------------------------- */

/**
 * Start warp-plus and wait until it is usable.
 *
 * Safe to call more than once; concurrent callers share one startup. Never throws — on any
 * failure it logs and returns null, and the rest of the bot carries on using the host IP.
 *
 * @returns {Promise<string|null>} proxy URL for yt-dlp --proxy, or null
 */
export async function startWarp() {
  if (_proxyUrl) return _proxyUrl;
  if (_startPromise) return _startPromise;

  if (!isEnabled()) {
    console.log('[warp] disabled via WARP_ENABLED — yt-dlp will use the host IP');
    return null;
  }

  const bin = resolveBin();
  if (!bin) {
    if (process.platform === 'linux') {
      console.warn(`[warp] binary not found at ${process.env.WARP_BIN?.trim() || DEFAULT_BIN}`);
      console.warn('[warp] run "node scripts/setup-warp.mjs" to vendor it — continuing without WARP');
    } else {
      console.log('[warp] no binary for this platform — continuing without WARP');
    }
    return null;
  }

  _startPromise = (async () => {
    const p = port();
    const args = [
      '--bind', `${HOST}:${p}`,
      '--cache-dir', CACHE_DIR,
      '-4', // IPv6 egress is unreliable on most container hosts
    ];

    // A WARP+ license raises the bandwidth quota. Optional; free WARP works without it.
    const license = process.env.WARP_LICENSE_KEY?.trim();
    if (license) args.push('--key', license);

    // gool chains WARP through a second WARP hop, which changes the apparent exit region.
    // Slower, but a different exit range — worth trying if the plain exit is blocked.
    if (/^(1|true|yes|on)$/i.test(process.env.WARP_GOOL?.trim() ?? '')) args.push('--gool');

    mkdirSync(CACHE_DIR, { recursive: true });

    console.log(`[warp] starting warp-plus on ${HOST}:${p}...`);

    _proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // warp-plus is chatty; surface only what explains a failure.
    const relay = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/error|fail|fatal|panic/i.test(t)) console.warn(`[warp] ${t.slice(0, 200)}`);
      }
    };
    _proc.stdout.on('data', relay);
    _proc.stderr.on('data', relay);

    let exited = null;
    _proc.on('exit', (code, signal) => {
      exited = signal ? `signal ${signal}` : `code ${code}`;
      // An exit after startup means the tunnel is gone; stop advertising the proxy so callers
      // fall back to direct rather than dialling a dead port.
      if (_proxyUrl) {
        console.warn(`[warp] warp-plus exited (${exited}) — falling back to direct egress`);
        _proxyUrl = null;
        _exitInfo = null;
      }
      _proc = null;
    });
    _proc.on('error', (err) => {
      console.warn(`[warp] failed to spawn: ${err.message}`);
    });

    try {
      await waitForPort(p, Date.now() + READY_TIMEOUT_MS);
      if (exited) throw new Error(`warp-plus exited during startup (${exited})`);

      const url = `socks5://${HOST}:${p}`;

      // Confirm the tunnel actually carries traffic before declaring success.
      try {
        _exitInfo = await probeExit(p);
        if (_exitInfo.warp === 'off') {
          console.warn(`[warp] proxy is up but WARP is OFF (exit ip ${_exitInfo.ip ?? 'unknown'})`);
          console.warn('[warp] traffic would leave via the host IP anyway — not using it');
          stopWarp();
          return null;
        }
        console.log(`[warp] ready: ${url} (exit ip ${_exitInfo.ip ?? 'unknown'}, warp=${_exitInfo.warp ?? 'unknown'})`);
      } catch (err) {
        // The probe is a nicety. A listening SOCKS port that failed one HTTP GET is still
        // worth handing to yt-dlp, which will report its own errors.
        console.warn(`[warp] exit-IP probe failed: ${err.message}`);
        console.log(`[warp] ready: ${url} (unverified)`);
      }

      _proxyUrl = url;
      return _proxyUrl;
    } catch (err) {
      console.warn(`[warp] startup failed: ${err.message}`);
      console.warn('[warp] continuing without WARP — yt-dlp will use the host IP');
      stopWarp();
      return null;
    } finally {
      _startPromise = null;
    }
  })();

  return _startPromise;
}

/** The WARP proxy URL if it is running, else null. Cheap; safe to call per request. */
export function getWarpProxy() {
  return _proxyUrl;
}

/** What Cloudflare reported for our exit, or null when unknown. */
export function getWarpExitInfo() {
  return _exitInfo;
}

/** Terminate warp-plus. Idempotent. */
export function stopWarp() {
  _proxyUrl = null;
  _exitInfo = null;

  if (!_proc) return;
  const proc = _proc;
  _proc = null;

  try { proc.kill('SIGTERM'); } catch {}
  // wireguard-go can sit in teardown; don't let it outlive us.
  const t = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
  }, 3000);
  if (typeof t.unref === 'function') t.unref();
}
