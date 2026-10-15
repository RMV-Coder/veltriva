'use strict';
// Shared helpers for the S7 scripts: per-scenario profile setup, a tiny header-capturing
// HTTP server (127.0.0.1 only), and the "clean user agent" function under test.

const { app } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const h = require('../shared/harness');

const SPIKE_DIR = __dirname;
const DOWNLOADS_DIR = path.join(SPIKE_DIR, 'downloads');

/**
 * Call at the very top of a script (before app is ready). Gives the scenario its own,
 * freshly-wiped profile under spikes/s7-web-compat/user-data/<name> and arms the fail-safe.
 */
function setup(name, { failSafeMs = 150_000, fresh = true, extraHostMaps = [], noProxy = false } = {}) {
  h.prepareApp(SPIKE_DIR); // *.test -> 127.0.0.1 and a profile inside the spike folder
  if (extraHostMaps.length) {
    // Re-issue the switch with more rules (names still resolve to loopback only; nothing leaves the machine).
    app.commandLine.appendSwitch('host-resolver-rules', ['MAP *.test 127.0.0.1', ...extraHostMaps.map((host) => `MAP ${host} 127.0.0.1`)].join(', '));
  }
  if (noProxy) app.commandLine.appendSwitch('no-proxy-server'); // a system proxy would otherwise see mapped names
  const dir = path.join(SPIKE_DIR, 'user-data', name);
  if (fresh) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);
  h.failSafe(failSafeMs, name);
  return dir;
}

/**
 * Strips the `Electron/x.y.z` token and the app-name token (`<name>/<version>`, which sits
 * right before `Chrome/`) from Electron's default user agent.
 */
function cleanUserAgent(ua) {
  return ua
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/\s+[^\s/()]+\/[^\s/()]+(?=\s+Chrome\/)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The user-visible values of a header map that matter for UA fingerprinting. */
function pickUaHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'user-agent' || k.startsWith('sec-ch-') || k === 'accept-language') out[k] = v;
  }
  return out;
}

const ACCEPT_CH = [
  'Sec-CH-UA-Full-Version-List',
  'Sec-CH-UA-Platform-Version',
  'Sec-CH-UA-Arch',
  'Sec-CH-UA-Bitness',
  'Sec-CH-UA-Model',
  'Sec-CH-UA-WoW64',
].join(', ');

/**
 * A tiny HTTP server of our own. Routes:
 *   /echo            HTML page; records the request headers; asks for high-entropy client hints (Accept-CH)
 *   /echo.json       the same headers as JSON (what a page can `fetch`)
 *   /links.html      page with links to the fixture-server downloads and to /slow-download
 *   /slow-download   attachment that streams for ?ms=5000 in ?chunks=10 pieces (records whether the client hung up)
 *   anything else    404 (so `/dict/...` requests are simply logged)
 * `requests` has every request; `slowDownloads` has one entry per /slow-download with the outcome.
 */
function startHeaderServer({ fixtureOrigin } = {}) {
  const requests = [];
  const slowDownloads = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const entry = { at: Date.now(), method: req.method, path: url.pathname + url.search, headers: { ...req.headers } };
    requests.push(entry);
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
      res.end(body);
    };
    switch (url.pathname) {
      case '/echo':
        return send(
          200,
          'text/html; charset=utf-8',
          '<!doctype html><meta charset="utf-8"><title>echo</title><h1>header echo</h1><pre id="h"></pre>',
          { 'Accept-CH': ACCEPT_CH },
        );
      case '/echo.json':
        return send(200, 'application/json', JSON.stringify(entry.headers), { 'Accept-CH': ACCEPT_CH });
      case '/links.html': {
        const f = fixtureOrigin ?? '';
        return send(
          200,
          'text/html; charset=utf-8',
          `<!doctype html><meta charset="utf-8"><title>links</title>
<a id="txt" href="${f}/download/sample.txt">sample.txt</a>
<a id="exe" href="${f}/download/fake-installer.exe">fake-installer.exe</a>
<a id="slow" href="/slow-download?ms=${url.searchParams.get('ms') ?? 5000}">slow</a>`,
        );
      }
      case '/slow-download': {
        const ms = Number(url.searchParams.get('ms') ?? 5000);
        const chunks = Number(url.searchParams.get('chunks') ?? 10);
        const chunk = Buffer.alloc(1024, 0x41);
        const outcome = { startedAt: Date.now(), ms, chunks, chunksSent: 0, clientHungUp: false, completed: false, endedAt: null };
        slowDownloads.push(outcome);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="slow.bin"',
          'Content-Length': String(chunk.length * chunks),
          'Cache-Control': 'no-store',
        });
        const timer = setInterval(() => {
          if (outcome.chunksSent >= chunks) return;
          res.write(chunk);
          outcome.chunksSent += 1;
          if (outcome.chunksSent === chunks) {
            clearInterval(timer);
            res.end();
            outcome.completed = true;
            outcome.endedAt = Date.now();
          }
        }, ms / chunks);
        res.on('close', () => {
          if (!outcome.completed) {
            outcome.clientHungUp = true;
            outcome.endedAt = Date.now();
            clearInterval(timer);
          }
        });
        return;
      }
      default:
        return send(404, 'text/plain', 'not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: (p = '/') => `http://127.0.0.1:${port}${p}`,
        requests,
        slowDownloads,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

/**
 * Chromium on Windows marks a window 'hidden' when other windows fully cover it, which stalls
 * rendering and can blank capturePage(). Keep the small spike window on top for the test,
 * give it a moment, and return the page's visibility so reports can show the conditions.
 */
async function stabilizeWindow(win, wc) {
  win.setAlwaysOnTop(true);
  await h.sleep(1000);
  if (!wc) return null;
  const read = () => wc.executeJavaScript('document.visibilityState', true).catch(() => 'unknown');
  // Occlusion state can lag the window being shown; wait (up to 5 s) for 'visible'.
  await h.pollUntil(async () => (await read()) === 'visible', { timeoutMs: 5000, intervalMs: 250 });
  return read();
}

function releaseWindow(win) {
  if (!win.isDestroyed()) win.setAlwaysOnTop(false);
}

/** Deny-everything permission handlers that also log what was asked (SAFE: nothing is ever granted). */
function installDenyHandlers(ses, log) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    log.push({ kind: 'request', permission, requestingUrl: details?.requestingUrl, externalURL: details?.externalURL, isMainFrame: details?.isMainFrame });
    callback(false);
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    log.push({ kind: 'check', permission, origin, requestingUrl: details?.requestingUrl });
    return false;
  });
}

module.exports = { SPIKE_DIR, DOWNLOADS_DIR, setup, cleanUserAgent, pickUaHeaders, startHeaderServer, installDenyHandlers, stabilizeWindow, releaseWindow };
