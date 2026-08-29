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
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_BIN = join(projectRoot, 'vendor', 'warp-plus');
const CACHE_DIR = join(projectRoot, '.cache', 'warp');

/** Where warp-plus listens. Loopback only — never expose this port. */
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8086;

/**
 * Startup budget per attempt.
 *
 * warp-plus gives the WireGuard handshake 15s (app/wg.go waitHandshake), then runs a tunnel
 * connectivity test with a 5s deadline (app/wg.go usermodeTunTest). In practice the process
 * does NOT reliably exit after those attempts — observed retrying for 50s+ — so this timeout
 * is the real backstop, not a formality.
 */
const READY_TIMEOUT_MS = 40_000;
const READY_POLL_MS = 500;

/**
 * Once the tunnel test has failed this many times, the endpoint is not going to start working.
 * warp-plus loops the test with no backoff, so this count accrues in a couple of seconds and
 * lets an attempt be abandoned in ~10s instead of waiting out READY_TIMEOUT_MS.
 */
const TEST_FAILURE_GIVE_UP = 60;

/** How long to wait for the exit-IP probe before giving up on it (non-fatal). */
const PROBE_TIMEOUT_MS = 15_000;

let _proc = null;
let _proxyUrl = null;
let _startPromise = null;
let _exitInfo = null;

/**
 * The warp-plus command, or null when it is not available.
 *
 * WARP_BIN is normally a plain path. It may also include leading arguments, matching how
 * YTDLP_CMD works elsewhere in this project (e.g. "python -m yt_dlp") — useful for running
 * warp-plus under a wrapper. The whole string is tried as a path first, so a path containing
 * spaces still works and is not mistaken for a command plus arguments.
 *
 * @returns {{ bin: string, pre: string[] } | null}
 */
function resolveBin() {
  const override = process.env.WARP_BIN?.trim();

  if (override) {
    if (existsSync(override)) return { bin: override, pre: [] };

    const [bin, ...pre] = override.split(/\s+/);
    return existsSync(bin) ? { bin, pre } : null;
  }

  return existsSync(DEFAULT_BIN) ? { bin: DEFAULT_BIN, pre: [] } : null;
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

/**
 * Resolves once something accepts TCP on the bind port; rejects early if the child dies or if
 * the tunnel test has clearly given up.
 *
 * The bind port is a reliable readiness signal because warp-plus only calls net.Listen AFTER
 * its tunnel connectivity test passes (wiresocks/proxy.go StartProxy, reached from
 * app/app.go runWarp only once usermodeTunTest returns nil). While the test is failing,
 * nothing is listening — so "port open" cannot be confused with "still retrying".
 *
 * @param {() => string|null} abortReason returns non-null once waiting is pointless
 */
function waitForPort(p, deadline, abortReason) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const abort = abortReason();
      if (abort) return reject(new Error(abort));

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
 * Tries the default endpoint selection first, then falls back to `--scan`, which UDP-probes
 * Cloudflare's WARP ranges and keeps only responsive endpoints. The default picks an endpoint
 * IP/port at random from ~54 ports across several /24s, so a single dead or rate-limited pick
 * fails the whole startup; scanning costs ~15s but survives that.
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

  const cmd = resolveBin();
  if (!cmd) {
    if (process.platform === 'linux') {
      console.warn(`[warp] binary not found at ${process.env.WARP_BIN?.trim() || DEFAULT_BIN}`);
      console.warn('[warp] run "node scripts/setup-warp.mjs" to vendor it — continuing without WARP');
    } else {
      console.log('[warp] no binary for this platform — continuing without WARP');
    }
    return null;
  }

  _startPromise = (async () => {
    try {
      // A pinned endpoint means the user knows which one works; don't second-guess it.
      const pinned = process.env.WARP_ENDPOINT?.trim();

      /*
       * Attempt ladder, cheapest and most likely first.
       *
       * The endpoint-related failure modes, and what each attempt does about them:
       *   - random endpoint is dead/rate-limited  → --scan finds a responsive one
       *   - the whole plain-WARP path is filtered → --gool tunnels WARP inside WARP, which
       *     changes both the handshake target and the exit region
       *
       * --gool is last because it is slower and doubles the crypto, but it is the only option
       * that survives an endpoint range being wholesale unusable. It is skipped when the user
       * already asked for it via WARP_GOOL, since then every attempt has it.
       */
      const goolForced = /^(1|true|yes|on)$/i.test(process.env.WARP_GOOL?.trim() ?? '');

      const attempts = pinned
        ? [{ label: `endpoint ${pinned}`, extra: ['--endpoint', pinned] }]
        : [
            { label: 'default endpoint', extra: [] },
            { label: 'endpoint scan', extra: ['--scan', '--rtt', '1s'] },
            ...(goolForced ? [] : [{ label: 'gool (warp-in-warp)', extra: ['--gool'] }]),
          ];

      let purgedCache = false;

      for (let i = 0; i < attempts.length; i++) {
        const { url, failure } = await tryStart(cmd, attempts[i]);
        if (url) {
          _proxyUrl = url;
          return url;
        }

        /*
         * Registration failure is not about endpoints, so walking the rest of the ladder is
         * pointless — every rung would fail identically for the same reason. A stale cached
         * identity is one cause we can actually fix, so purge it and retry the same attempt
         * once; if that also fails, Cloudflare is refusing this IP and WARP is unavailable.
         */
        if (failure === 'register') {
          if (!purgedCache && existsSync(CACHE_DIR)) {
            console.warn('[warp] discarding cached WARP identity and re-registering once...');
            purgedCache = true;
            try {
              rmSync(CACHE_DIR, { recursive: true, force: true });
            } catch (err) {
              console.warn(`[warp] could not clear ${CACHE_DIR}: ${err.message}`);
            }
            i--; // retry the same rung with a clean cache
            continue;
          }

          console.warn('[warp] skipping remaining attempts — registration failure is not endpoint-related');
          break;
        }
      }

      console.warn('[warp] all startup attempts failed — yt-dlp will use the host IP');
      console.warn('[warp] this host cannot reach Cloudflare WARP; residential proxies via YTDLP_PROXIES are the remaining option');
      return null;
    } finally {
      _startPromise = null;
    }
  })();

  return _startPromise;
}

/**
 * One warp-plus startup attempt.
 *
 * Cleans up the child process on every failure path so attempts don't stack up.
 *
 * @returns {Promise<{ url: string|null, failure: 'register'|'tunnel'|'handshake'|'other'|null }>}
 */
async function tryStart({ bin, pre }, { label, extra }) {
  const p = port();
  const args = [
    '--bind', `${HOST}:${p}`,
    '--cache-dir', CACHE_DIR,
    '-4', // IPv6 egress is unreliable on most container hosts
    ...extra,
  ];

  // A WARP+ license raises the bandwidth quota. Optional; free WARP works without it.
  const license = process.env.WARP_LICENSE_KEY?.trim();
  if (license) args.push('--key', license);

  // gool chains WARP through a second WARP hop, which changes the apparent exit region.
  // Slower, but a different exit range — worth trying if the plain exit is blocked.
  // Skipped when this attempt already passes --gool, to avoid duplicating the flag.
  if (
    /^(1|true|yes|on)$/i.test(process.env.WARP_GOOL?.trim() ?? '') &&
    !extra.includes('--gool')
  ) {
    args.push('--gool');
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`[warp] starting warp-plus on ${HOST}:${p} (${label})...`);

  const proc = spawn(bin, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  _proc = proc;

  /*
   * Log relay.
   *
   * warp-plus retries its tunnel connectivity test in a tight loop with no backoff — an
   * unreachable endpoint yields hundreds of identical `connection test failed` lines in a
   * couple of seconds. Relaying those verbatim buried the actual startup in ~400 lines of
   * noise. We count repeats instead and emit one summary, and we track which failure mode
   * happened so the final message can name a cause.
   *
   * The counts are also a control signal: see TEST_FAILURE_GIVE_UP.
   */
  const seen = new Map();
  let sawHandshakeTimeout = false;
  let sawTestFailure = false;
  let sawRegistrationFailure = false;
  let scanPingErrors = 0;

  const relay = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const t = line.trim();
      if (!t) continue;

      if (/connection test failed/i.test(t)) {
        sawTestFailure = true;
        seen.set('test', (seen.get('test') ?? 0) + 1);
        continue;
      }
      if (/context deadline exceeded|waiting on handshake/i.test(t)) {
        sawHandshakeTimeout = true;
        seen.set('handshake', (seen.get('handshake') ?? 0) + 1);
        continue;
      }
      /*
       * Registration failure: warp-plus could not obtain a WARP identity from Cloudflare's
       * API, so there is no key material and it exits before any tunnel work. Distinct from
       * the handshake and tunnel-test failures — nothing about endpoints or UDP is involved.
       */
      if (/couldn't load primary warp identity/i.test(t) || /API request failed with status/i.test(t)) {
        sawRegistrationFailure = true;
        seen.set('register', (seen.get('register') ?? 0) + 1);
        continue;
      }
      // Scanner probes many endpoints and most don't answer; individual misses are expected.
      if (/subsystem=scanner/i.test(t) && /ping error/i.test(t)) {
        scanPingErrors++;
        continue;
      }
      // "failed to load identity" on a cold cache is normal — it registers immediately after.
      if (/failed to load identity/i.test(t)) continue;

      if (/error|fail|fatal|panic/i.test(t)) console.warn(`[warp] ${t.slice(0, 200)}`);
    }
  };
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);

  let exited = null;
  proc.on('exit', (code, signal) => {
    exited = signal ? `signal ${signal}` : `code ${code}`;
    // An exit after startup means the tunnel is gone; stop advertising the proxy so callers
    // fall back to direct rather than dialling a dead port.
    if (_proxyUrl) {
      console.warn(`[warp] warp-plus exited (${exited}) — falling back to direct egress`);
      _proxyUrl = null;
      _exitInfo = null;
    }
    if (_proc === proc) _proc = null;
  });
  proc.on('error', (err) => {
    exited = `spawn error: ${err.message}`;
    console.warn(`[warp] failed to spawn: ${err.message}`);
  });

  const summarise = () => {
    const tests = seen.get('test') ?? 0;
    const handshakes = seen.get('handshake') ?? 0;
    if (tests) console.warn(`[warp] tunnel connectivity test failed (${tests} attempts)`);
    if (handshakes) console.warn(`[warp] WireGuard handshake never completed (${handshakes} polls)`);
    if (scanPingErrors) console.warn(`[warp] scanner found no responsive endpoint (${scanPingErrors} probes failed)`);

    if (sawRegistrationFailure) {
      console.warn('[warp] cause: Cloudflare refused to issue a WARP identity (API 400)');
      console.warn('[warp] this is account registration, not networking — the tunnel was never attempted');
      console.warn('[warp] usually means this IP is rate-limited by the WARP registration API,');
      console.warn('[warp] or the cached identity in .cache/warp is stale — delete it to re-register');
    } else if (sawHandshakeTimeout && !sawTestFailure) {
      console.warn('[warp] cause: no WireGuard handshake — outbound UDP is blocked by this host');
      console.warn('[warp] a host that blocks outbound UDP cannot run WARP at all; use YTDLP_PROXIES instead');
    } else if (sawTestFailure) {
      console.warn('[warp] cause: handshake completed but no traffic flowed through the tunnel');
      console.warn('[warp] the endpoint answers UDP but drops tunnelled packets — dead, rate-limited, or MTU-filtered');
    }
  };

  /**
   * Reason to stop waiting, or null to keep waiting.
   *
   * Three early exits, all about not burning the full timeout on a lost cause:
   *   - registration was refused, so there is no identity and nothing will ever bind
   *   - the child died (it can also keep running and never bind, hence the third case)
   *   - the tunnel test has failed enough times that it clearly will not recover
   */
  const abortReason = () => {
    if (sawRegistrationFailure) return 'Cloudflare refused to issue a WARP identity';
    if (exited) return `warp-plus exited before binding (${exited})`;
    if ((seen.get('test') ?? 0) >= TEST_FAILURE_GIVE_UP) {
      return `tunnel unusable after ${seen.get('test')} failed connectivity tests`;
    }
    return null;
  };

  try {
    await waitForPort(p, Date.now() + READY_TIMEOUT_MS, abortReason);

    const url = `socks5://${HOST}:${p}`;

    // Confirm the tunnel actually carries traffic before declaring success.
    try {
      _exitInfo = await probeExit(p);
      if (_exitInfo.warp === 'off') {
        console.warn(`[warp] proxy is up but WARP is OFF (exit ip ${_exitInfo.ip ?? 'unknown'})`);
        console.warn('[warp] traffic would leave via the host IP anyway — not using it');
        killProc(proc);
        return { url: null, failure: 'tunnel' };
      }
      console.log(`[warp] ready: ${url} (exit ip ${_exitInfo.ip ?? 'unknown'}, warp=${_exitInfo.warp ?? 'unknown'})`);
    } catch (err) {
      // The probe is a nicety. A listening SOCKS port that failed one HTTP GET is still
      // worth handing to yt-dlp, which will report its own errors.
      console.warn(`[warp] exit-IP probe failed: ${err.message}`);
      console.log(`[warp] ready: ${url} (unverified)`);
    }

    return { url, failure: null };
  } catch (err) {
    console.warn(`[warp] ${label} failed: ${err.message}`);
    summarise();
    killProc(proc);

    // Classify so the caller can decide whether walking the rest of the ladder is worthwhile.
    const failure = sawRegistrationFailure
      ? 'register'
      : sawTestFailure
        ? 'tunnel'
        : sawHandshakeTimeout
          ? 'handshake'
          : 'other';

    return { url: null, failure };
  }
}

/** The WARP proxy URL if it is running, else null. Cheap; safe to call per request. */
export function getWarpProxy() {
  return _proxyUrl;
}

/** What Cloudflare reported for our exit, or null when unknown. */
export function getWarpExitInfo() {
  return _exitInfo;
}

/**
 * SIGTERM then SIGKILL a warp-plus child. wireguard-go can sit in teardown, so don't let it
 * outlive us — a stale process would hold the bind port and break the next attempt.
 */
function killProc(proc) {
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch {}
  const t = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
  }, 3000);
  if (typeof t.unref === 'function') t.unref();
}

/** Terminate warp-plus. Idempotent. */
export function stopWarp() {
  _proxyUrl = null;
  _exitInfo = null;

  const proc = _proc;
  _proc = null;
  killProc(proc);
}
