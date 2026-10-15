'use strict';
// S7 check 3: downloads, Mark-of-the-Web (Zone.Identifier) and what closing the originating tab does.
//   Part A: sample.txt and fake-installer.exe, saved with item.setSavePath, then read file:Zone.Identifier.
//           Triggered four ways: page link from 127.0.0.1, page link from a.test (maps to 127.0.0.1 but is
//           not a loopback *name*), webContents.downloadURL, session.downloadURL.
//   Part B: a ~5 s streaming download; the originating web contents is closed mid-flight.
// The "no setSavePath" case (Electron shows a save dialog) is NOT run on purpose; see the report.

const { app, session } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');
const lib = require('./lib');

// dl.example.com is mapped to loopback (and proxies are off) so a public-looking host name can be tested without leaving the machine.
lib.setup('downloads', { failSafeMs: 150_000, extraHostMaps: ['dl.example.com'], noProxy: true });

function readMotw(file) {
  try {
    return fs.readFileSync(`${file}:Zone.Identifier`, 'utf8');
  } catch (err) {
    return { absent: true, code: err.code };
  }
}

function parseMotw(text) {
  if (typeof text !== 'string') return text;
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function listStreams(file) {
  try {
    const cmd = `Get-Item -LiteralPath '${file}' -Stream * | Select-Object -ExpandProperty Stream`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 15000 });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return `error: ${err.message.split('\n')[0]}`;
  }
}

app.whenReady().then(async () => {
  const rows = [];
  const fixture = await startFixtureServer();
  const srv = await lib.startHeaderServer({ fixtureOrigin: fixture.url('/').replace(/\/$/, '') });
  fs.rmSync(lib.DOWNLOADS_DIR, { recursive: true, force: true });
  fs.mkdirSync(lib.DOWNLOADS_DIR, { recursive: true });

  const ses = session.fromPartition(h.TAB_PREFS.partition);
  const downloads = []; // one entry per will-download
  let prefix = 'x';
  ses.on('will-download', (event, item, webContents) => {
    const entry = {
      prefix,
      filename: item.getFilename(),
      mime: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      url: item.getURL(),
      urlChain: item.getURLChain(),
      contentDisposition: item.getContentDisposition(),
      initiatorOrigin: item.getInitiatorOrigin?.(),
      hasWebContentsArg: Boolean(webContents),
      stateAtStart: item.getState(),
      states: [],
      finalState: null,
      savePath: null,
    };
    entry.savePath = path.join(lib.DOWNLOADS_DIR, `${prefix}-${entry.filename}`);
    item.setSavePath(entry.savePath); // without this Electron would prompt with a save dialog
    entry.item = item;
    entry.done = new Promise((resolve) => {
      item.on('updated', (e, state) => entry.states.push(`${state}@${item.getReceivedBytes()}`));
      item.once('done', (e, state) => {
        entry.finalState = state;
        entry.doneAt = Date.now();
        resolve(state);
      });
    });
    downloads.push(entry);
  });

  const win = h.createWindow({ width: 800, height: 500, title: 'S7 downloads' });
  const view = h.createTabView(win);
  const wc = view.webContents;
  await wc.loadURL('about:blank');
  await lib.stabilizeWindow(win, wc);

  /** Runs `trigger`, waits for the matching download to finish and reads its Zone.Identifier. */
  async function runDownload(label, trigger) {
    prefix = label;
    const before = downloads.length;
    await trigger();
    const entry = await h.pollUntil(() => downloads.length > before && downloads[before], { timeoutMs: 10000 });
    if (!entry) return { label, error: 'no will-download event' };
    await Promise.race([entry.done, h.sleep(10000)]);
    await h.sleep(300); // let the quarantine/annotation step finish
    const motw = parseMotw(readMotw(entry.savePath));
    return {
      label,
      filename: entry.filename,
      mime: entry.mime,
      totalBytes: entry.totalBytes,
      urlChain: entry.urlChain,
      initiatorOrigin: entry.initiatorOrigin,
      finalState: entry.finalState,
      bytesOnDisk: fs.existsSync(entry.savePath) ? fs.statSync(entry.savePath).size : null,
      streams: listStreams(entry.savePath),
      zoneIdentifier: motw,
    };
  }

  const clickLink = (name) => wc.executeJavaScript(`document.querySelector('a[href="/download/${name}"]').click()`, true);
  const results = [];
  for (const [site, host] of [['loopback', '127.0.0.1'], ['a.test', 'a.test'], ['public-name', 'dl.example.com']]) {
    for (const name of ['sample.txt', 'fake-installer.exe']) {
      await wc.loadURL(fixture.url('/index.html', host));
      results.push(await runDownload(`link-${site}-${name.split('.')[0]}`, () => clickLink(name)));
    }
  }
  results.push(await runDownload('webContents.downloadURL', async () => wc.downloadURL(fixture.url('/download/sample.txt', 'a.test'))));
  results.push(await runDownload('session.downloadURL', async () => ses.downloadURL(fixture.url('/download/sample.txt', 'a.test'))));
  results.push(await runDownload('session.downloadURL-public-name', async () => ses.downloadURL(fixture.url('/download/sample.txt', 'dl.example.com'))));

  for (const r of results) {
    const has = r.zoneIdentifier && !r.zoneIdentifier.absent;
    h.record(rows, `download ${r.label}`, r, null, has ? 'Zone.Identifier present' : 'Zone.Identifier ABSENT');
  }
  h.record(rows, 'will-download delivered a webContents argument', downloads.map((d) => ({ prefix: d.prefix, hasWebContentsArg: d.hasWebContentsArg })), null);

  // ---------- Part B: close the originating web contents mid-download ----------
  const closeResults = [];
  async function closeMidDownload(label, start, how = 'close') {
    prefix = label;
    const before = downloads.length;
    const serverBefore = srv.slowDownloads.length;
    const v = h.createTabView(win);
    await v.webContents.loadURL(srv.url('/links.html?ms=5000'));
    await start(v.webContents);
    const entry = await h.pollUntil(() => downloads.length > before && downloads[before], { timeoutMs: 8000 });
    if (!entry) return { label, error: 'no will-download event' };
    // Wait until bytes are flowing, then pull the tab.
    await h.pollUntil(() => entry.item.getReceivedBytes() > 0, { timeoutMs: 5000, intervalMs: 50 });
    const atClose = { state: entry.item.getState(), received: entry.item.getReceivedBytes(), total: entry.item.getTotalBytes() };
    const closedAt = Date.now();
    if (how === 'crash') v.webContents.forcefullyCrashRenderer();
    else h.destroyView(win, v); // removeChildView -> webContents.close() (ADR-0002 destruction rule)
    const samples = [];
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && entry.finalState === null) {
      samples.push(`${Math.round((Date.now() - closedAt) / 100) / 10}s:${entry.item.getState()}@${entry.item.getReceivedBytes()}`);
      await h.sleep(500);
    }
    await h.sleep(300);
    const server = srv.slowDownloads[serverBefore];
    if (how === 'crash') h.destroyView(win, v);
    return {
      label,
      atClose,
      stateSamples: samples,
      finalState: entry.finalState,
      secondsFromCloseToDone: entry.doneAt ? Math.round((entry.doneAt - closedAt) / 100) / 10 : null,
      bytesOnDisk: fs.existsSync(entry.savePath) ? fs.statSync(entry.savePath).size : null,
      server: server && { chunksSent: server.chunksSent, completed: server.completed, clientHungUp: server.clientHungUp },
    };
  }

  closeResults.push(await closeMidDownload('close-link-originated', (wc2) => wc2.executeJavaScript(`document.getElementById('slow').click()`, true)));
  closeResults.push(await closeMidDownload('close-downloadURL-originated', (wc2) => wc2.downloadURL(srv.url('/slow-download?ms=5000'))));
  // The tab's renderer dies (what a discard/crash looks like) instead of the tab being closed.
  closeResults.push(await closeMidDownload('renderer-crash-link-originated', (wc2) => wc2.executeJavaScript(`document.getElementById('slow').click()`, true), 'crash'));
  // Control: a session-level download is not tied to any tab; closing an unrelated tab must not matter.
  closeResults.push(await closeMidDownload('close-unrelated-tab-session-downloadURL', async () => ses.downloadURL(srv.url('/slow-download?ms=5000'))));

  for (const r of closeResults) {
    h.record(rows, `close tab mid-download: ${r.label}`, r, r.finalState === null ? false : null, r.finalState === 'completed' ? 'download SURVIVED the tab close' : `final state ${r.finalState}`);
  }

  h.writeResults(__dirname, 'downloads', {
    docsNoSetSavePath: "electron.d.ts DownloadItem.setSavePath: 'If user doesn't set the save path via the API, Electron will use the original routine to determine the save path; this usually prompts a save dialog.' Not exercised.",
    results,
    closeResults,
    rows,
  });
  lib.releaseWindow(win);
  win.close();
  await srv.close();
  await fixture.close();
  app.exit(0);
});
