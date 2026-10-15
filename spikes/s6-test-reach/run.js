'use strict';
// S6 driver: can Playwright (playwright-core) reach the shell view and every tab WebContentsView
// of a BaseWindow-based Electron app? Plain Node script:
//   cd C:/GitHub/Veltriva/spikes && timeout 300 node s6-test-reach/run.js
//
// Phases: (1) 10 full launch -> checks -> close cycles, (2) ELECTRON_RUN_AS_NODE=1 launch,
// (3) one launch without executablePath (Playwright's own loader injected).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');

const electronExe = require('electron'); // spikes/node_modules/electron exports the binary path
const APP_MAIN = path.join(__dirname, 'app-main.js');
const RESULTS_DIR = path.join(__dirname, 'results');
const CYCLES = Number(process.env.S6_CYCLES ?? 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();
const round = (n) => Math.round(n);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);

/** Environment passed to Playwright. ADR-0008 item 4: the test environment clears ELECTRON_RUN_AS_NODE. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('ELECTRON_RUN_AS_NODE' in extra)) delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function pollUntil(fn, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = now() + timeoutMs;
  let value;
  while (now() < deadline) {
    value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return value;
}

/** Resolves with the value, or with { timedOut: true } after ms. Never rejects. */
async function within(ms, promise) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Classifies a Playwright Page by URL: shell (file://), tab A (a.test), tab B (b.test), or other. */
function kindOf(url) {
  if (url.startsWith('file://') && url.endsWith('/shell.html')) return 'shell';
  if (url.includes('//a.test:')) return url.includes('/form.html') ? 'A' : 'a-other';
  if (url.includes('//b.test:')) return url.includes('late=') ? 'late' : 'B';
  return `other(${url})`;
}

function makeRecorder(rows, verbose) {
  return (name, observed, pass, note) => {
    rows.push({ name, observed, pass, ...(note ? { note } : {}) });
    if (verbose) {
      const tag = pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL';
      console.log(`  ${tag}  ${name}  ${JSON.stringify(observed)}${note ? `  (${note})` : ''}`);
    }
    return pass;
  };
}

async function closeApp(electronApp) {
  const t0 = now();
  const result = await within(20_000, electronApp.close());
  let forcedKill = false;
  if (result.timedOut || result.error) {
    forcedKill = true;
    try {
      electronApp.process().kill();
    } catch {
      /* already gone */
    }
  }
  return { closeMs: round(now() - t0), forcedKill, closeError: result.error ? firstLine(result.error) : undefined };
}

/** One full launch -> checks -> close cycle. */
async function runCycle(index, { verbose }) {
  const rows = [];
  const obs = {};
  const timings = {};
  const rec = makeRecorder(rows, verbose);
  const tCycle = now();
  let electronApp;
  let proc;
  let closeInfo = {};

  try {
    // ---- launch ----
    const tLaunch = now();
    electronApp = await _electron.launch({
      executablePath: electronExe,
      args: [APP_MAIN],
      env: cleanEnv(),
      timeout: 30_000,
    });
    timings.launchMs = round(now() - tLaunch);
    const context = electronApp.context();
    proc = electronApp.process(); // must be read before close(): the accessor throws afterwards

    // Listeners registered after launch() resolves: only see pages created from now on.
    const windowEvents = [];
    const pageEvents = [];
    electronApp.on('window', (page) => windowEvents.push({ at: now(), url: page.url() }));
    context.on('page', (page) => pageEvents.push({ at: now(), url: page.url() }));
    const consoleLines = [];
    electronApp.on('console', (msg) => consoleLines.push(msg.text()));

    // ---- (a) which web contents are Pages? ----
    obs.windowsAtLaunchResolve = electronApp.windows().length;
    const tFirst = now();
    const first = await within(15_000, electronApp.firstWindow({ timeout: 15_000 }));
    obs.firstWindowKind = first.value ? kindOf(first.value.url()) : 'none';
    rec('a. firstWindow() resolves right after launch', { kind: obs.firstWindowKind, ms: round(now() - tFirst) }, Boolean(first.value),
      'which page it returns is an implementation detail (first in CDP discovery order)');

    const three = await pollUntil(() => electronApp.windows().length === 3, { timeoutMs: 10_000 });
    timings.threePagesMs = round(now() - tLaunch);
    const windows = electronApp.windows();
    const ctxPages = context.pages();
    rec('a. windows() lists shell + 2 tabs', { count: windows.length, atLaunchResolve: obs.windowsAtLaunchResolve }, Boolean(three));
    rec('a. context().pages() == windows()', { ctxCount: ctxPages.length, sameSet: windows.length === ctxPages.length && windows.every((w) => ctxPages.includes(w)) },
      windows.length === ctxPages.length && windows.every((w) => ctxPages.includes(w)));
    rec('a. no window events for pre-existing pages (listener added after launch)', { windowEvents: windowEvents.length, pageEvents: pageEvents.length },
      null,
      'pages that exist when launch() resolves are only reachable through windows()');

    const byKind = {};
    const described = [];
    for (const page of windows) {
      const kind = kindOf(page.url());
      byKind[kind] = page;
      described.push({ kind, url: page.url(), title: await page.title() });
    }
    obs.windowsOrder = windows.map((p) => kindOf(p.url())).join(',');
    const titles = Object.fromEntries(described.map((d) => [d.kind, d.title]));
    const distinct = ['shell', 'A', 'B'].every((k) => byKind[k]);
    rec('a. pages are distinguishable by url + title', { described, order: obs.windowsOrder }, distinct && titles.shell === 'Veltriva Shell' && titles.A === 'form' && titles.B === 'timers');
    const { shell: shellPage, A: pageA, B: pageB } = byKind;
    if (!distinct) throw new Error(`cannot continue, pages: ${obs.windowsOrder}`);

    // Page <-> tab identity through the CDP target id (public API: newCDPSession + Target.getTargetInfo).
    const registryTabs = await electronApp.evaluate(() => globalThis.__veltrivaTest.tabs());
    const registryShell = await electronApp.evaluate(() => globalThis.__veltrivaTest.shell());
    const targetIdOf = async (page) => {
      const cdp = await context.newCDPSession(page);
      try {
        return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
      } finally {
        await cdp.detach().catch(() => {});
      }
    };
    const ids = { shell: await targetIdOf(shellPage), A: await targetIdOf(pageA), B: await targetIdOf(pageB) };
    const idMatches = {
      shell: ids.shell === registryShell.targetId,
      A: ids.A === registryTabs.find((t) => t.label === 'A').targetId,
      B: ids.B === registryTabs.find((t) => t.label === 'B').targetId,
    };
    rec('a. Page -> registry tab mapping via CDP targetId', idMatches, Object.values(idMatches).every(Boolean),
      'robust alternative to matching on url');

    const owners = {};
    for (const [kind, page] of Object.entries({ shell: shellPage, A: pageA, B: pageB })) {
      const handle = await electronApp.browserWindow(page);
      owners[kind] = await handle.evaluate((w) => (w === null ? null : { ctor: w.constructor.name, title: w.getTitle() }));
    }
    rec('a. electronApp.browserWindow(page) for views inside a BaseWindow', owners,
      Object.values(owners).every((o) => o && o.ctor === 'BaseWindow' && o.title === 'Veltriva S6'),
      'returns the owning BaseWindow (not null, not a BrowserWindow) for the shell and for both tabs');

    // ---- (b) interact with page content ----
    await shellPage.locator('#ping').click({ timeout: 5_000 });
    await shellPage.locator('#ping').click({ timeout: 5_000 });
    const pings = await shellPage.locator('#count').textContent();
    rec('b. shell: click button, read DOM', { count: pings, role: await shellPage.evaluate(() => window.__shell.role) }, pings === '2');

    await pageA.fill('#text', 'hello veltriva');
    await pageA.check('#chk');
    await pageA.locator('#reactish').pressSequentially('abc');
    const viaPlaywright = {
      text: await pageA.inputValue('#text'),
      chk: await pageA.isChecked('#chk'),
      reactish: await pageA.inputValue('#reactish'),
    };
    const viaMain = await electronApp.evaluate(
      (_e, id) => globalThis.__veltrivaTest.executeIn(id, `({ text: document.getElementById('text').value, chk: document.getElementById('chk').checked, reactish: document.getElementById('reactish').value })`),
      registryTabs.find((t) => t.label === 'A').id,
    );
    rec('b. tab A: fill / check / type, confirmed from the main process', { viaPlaywright, viaMain },
      viaPlaywright.text === 'hello veltriva' && viaPlaywright.chk && viaPlaywright.reactish === 'abc' && JSON.stringify(viaPlaywright) === JSON.stringify(viaMain));

    const tick1 = await pageB.evaluate(() => window.__t.intervalTicks);
    await sleep(1_300);
    const tick2 = await pageB.evaluate(() => window.__t.intervalTicks);
    const raf = await pageB.evaluate(() => window.__t.rafTicks);
    obs.hiddenTimerDelta1300ms = tick2 - tick1;
    obs.hiddenRafTicks = raf;
    rec('b. tab B (hidden view): read window.__t', { tick1, tick2, delta: tick2 - tick1, rafTicks: raf, visibility: await pageB.evaluate(() => document.visibilityState) }, typeof tick1 === 'number' && tick2 > tick1,
      'setVisible(false) tab is still evaluable; delta over 1.3 s shows timer throttling (100 ms interval; S1 covers throttling in depth)');
    rec('b. tab A visibilityState', await pageA.evaluate(() => document.visibilityState), null);

    const shotShell = await within(8_000, shellPage.screenshot({ timeout: 6_000 }));
    const shotA = await within(8_000, pageA.screenshot({ timeout: 6_000 }));
    rec('b. screenshot of shell and visible tab', { shell: shotShell.value?.length ?? (shotShell.timedOut ? 'timeout' : firstLine(shotShell.error)), A: shotA.value?.length ?? (shotA.timedOut ? 'timeout' : firstLine(shotA.error)) },
      Boolean(shotShell.value?.length > 1000 && shotA.value?.length > 1000));

    // Actionability on a tab hidden with setVisible(false).
    const tHidden = now();
    const hiddenClick = await within(4_000, pageB.locator('h1').click({ timeout: 2_000 }));
    rec('b. click() on element of tab B hidden with setVisible(false)', hiddenClick.error ? firstLine(hiddenClick.error) : hiddenClick.timedOut ? 'driver timeout' : 'ok', null, `${round(now() - tHidden)} ms`);
    obs.setVisibleFalseClick = hiddenClick.error ? 'error' : hiddenClick.timedOut ? 'timeout' : 'ok';
    obs.setVisibleFalseVisibility = await pageB.evaluate(() => document.visibilityState);

    // Workaround probe: try to switch the focus emulation off from a second CDP session, sample, switch it back on.
    const cdpB = await context.newCDPSession(pageB);
    const sampleB = async () => {
      const read = () => pageB.evaluate(() => ({ vis: document.visibilityState, t: window.__t.intervalTicks, r: window.__t.rafTicks }));
      const a = await read();
      await sleep(1_300);
      const b = await read();
      return { visibilityState: b.vis, intervalTicksPer1300ms: b.t - a.t, rafTicksPer1300ms: b.r - a.r };
    };
    await cdpB.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const focusOff = await sampleB();
    await cdpB.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const focusOn = await sampleB();
    await cdpB.detach().catch(() => {});
    obs.focusEmulationOffVisibility = focusOff.visibilityState;
    rec('b. tab B: setFocusEmulationEnabled(false) from a second CDP session', { focusOff, focusOnAgain: focusOn }, null,
      "does not undo Playwright's own per-page emulation, so it is not a workaround");

    // ---- (c) main process through electronApp.evaluate ----
    const typeofHook = await electronApp.evaluate(() => typeof globalThis.__veltrivaTest);
    const mainInfo = await electronApp.evaluate(() => globalThis.__veltrivaTest.mainInfo());
    const sum = await electronApp.evaluate((_e, n) => n + 1, 41);
    const windowsInMain = await electronApp.evaluate(({ BaseWindow, BrowserWindow }) => ({ base: BaseWindow.getAllWindows().length, browser: BrowserWindow.getAllWindows().length }));
    const mainEnv = await electronApp.evaluate(({ app }) => ({ typeofDocument: typeof document, typeofRequire: typeof require, typeofProcess: typeof process, ready: app.isReady() }));
    const awaited = await electronApp.evaluate((_e, id) => globalThis.__veltrivaTest.waitLoaded(id), registryTabs[0].id);
    await electronApp.evaluate(() => console.log('s6-main-console-line'));
    await pollUntil(() => consoleLines.includes('s6-main-console-line'), { timeoutMs: 2_000 });
    rec('c. electronApp.evaluate reaches globalThis.__veltrivaTest', { typeofHook, processType: mainInfo.processType, electron: mainInfo.electron, chrome: mainInfo.chrome, tabs: registryTabs.length },
      typeofHook === 'object' && mainInfo.processType === 'browser' && registryTabs.length === 2);
    rec('c. arguments, promises, electron module in evaluate', { sum, awaitedPromise: awaited, windowsInMain, mainEnv }, sum === 42 && awaited === true && windowsInMain.base === 1 && windowsInMain.browser === 0);
    rec('c. main-process console.log arrives as electronApp "console" event', consoleLines, consoleLines.includes('s6-main-console-line'));
    obs.argv = mainInfo.argv.slice(1);
    obs.mainSwitches = { disableRendererBackgrounding: mainInfo.hasDisableRendererBackgrounding, disableBackgroundingOccluded: mainInfo.hasDisableBackgroundingOccluded };

    // ---- (d) detached vs destroyed ----
    const idB = registryTabs.find((t) => t.label === 'B').id;
    await electronApp.evaluate((_e, id) => globalThis.__veltrivaTest.detach(id), idB);
    const detachedTab = (await electronApp.evaluate(() => globalThis.__veltrivaTest.tabs())).find((t) => t.id === idB);
    const stillListed = electronApp.windows().includes(pageB);
    const [tickD1, rafD1] = await pageB.evaluate(() => [window.__t.intervalTicks, window.__t.rafTicks]);
    await sleep(1_300);
    const [tickD2, rafD2] = await pageB.evaluate(() => [window.__t.intervalTicks, window.__t.rafTicks]);
    obs.detachedTimerDelta1300ms = tickD2 - tickD1;
    obs.detachedRafDelta1300ms = rafD2 - rafD1;
    const detachedVisibility = await pageB.evaluate(() => document.visibilityState);
    const detachedShot = await within(4_000, pageB.screenshot({ timeout: 2_000 }));
    const detachedClick = await within(3_000, pageB.locator('h1').click({ timeout: 1_500 }));
    obs.detachedVisibility = detachedVisibility;
    obs.detachedClick = detachedClick.error ? 'error' : detachedClick.timedOut ? 'timeout' : 'ok';
    rec('d. detached (removeChildView) tab: still in windows(), not closed', { attached: detachedTab.attached, stillListed, isClosed: pageB.isClosed(), url: pageB.url(), title: await pageB.title(), count: electronApp.windows().length },
      detachedTab.attached === false && stillListed && !pageB.isClosed() && electronApp.windows().length === 3);
    rec('d. detached tab: page.evaluate works, timers advance (rAF delta shows whether frames are produced)', { tickD1, tickD2, delta: tickD2 - tickD1, rafDelta: rafD2 - rafD1, visibility: detachedVisibility }, typeof tickD1 === 'number' && tickD2 > tickD1);
    rec('d. detached tab: screenshot', detachedShot.value ? `${detachedShot.value.length} bytes` : detachedShot.timedOut ? 'timeout' : firstLine(detachedShot.error), null);
    rec('d. detached tab: click() on its h1', detachedClick.error ? firstLine(detachedClick.error) : detachedClick.timedOut ? 'driver timeout' : 'ok', null);

    await electronApp.evaluate((_e, id) => globalThis.__veltrivaTest.attach(id), idB);
    const reattached = await pageB.evaluate(() => window.__t.intervalTicks);
    const reattachedClick = await within(8_000, pageB.locator('h1').click({ timeout: 5_000 }));
    rec('d. re-attached tab: same Page, evaluable, click() works', { sameListed: electronApp.windows().includes(pageB), tick: reattached, visibility: await pageB.evaluate(() => document.visibilityState), click: reattachedClick.error ? firstLine(reattachedClick.error) : reattachedClick.timedOut ? 'timeout' : 'ok' },
      electronApp.windows().includes(pageB) && reattached >= tickD2 && !reattachedClick.error && !reattachedClick.timedOut);
    await electronApp.evaluate((_e, id) => globalThis.__veltrivaTest.detach(id), idB);

    const closeWait = new Promise((resolve) => {
      const t = now();
      pageB.once('close', () => resolve(now() - t));
    });
    const tDestroy = now();
    const destroyResult = await electronApp.evaluate((_e, id) => globalThis.__veltrivaTest.destroy(id), idB);
    const closedAfter = await within(8_000, closeWait);
    const afterDestroy = (await electronApp.evaluate(() => globalThis.__veltrivaTest.tabs())).find((t) => t.id === idB);
    const evalAfterClose = await within(4_000, pageB.evaluate(() => 1));
    rec('d. destroyed (webContents.close()) tab: Page emits close and leaves windows()',
      { removeChildViewOnDetachedView: destroyResult.removeChildViewError ?? 'no error', closeEventMs: closedAfter.value === undefined ? 'none' : round(closedAfter.value), isClosed: pageB.isClosed(), windows: electronApp.windows().length, contextPages: context.pages().length, registryDestroyed: afterDestroy.destroyed },
      closedAfter.value !== undefined && pageB.isClosed() && electronApp.windows().length === 2 && context.pages().length === 2 && afterDestroy.destroyed === true);
    rec('d. evaluate on the closed Page rejects', evalAfterClose.error ? firstLine(evalAfterClose.error) : evalAfterClose.timedOut ? 'timeout' : 'resolved', Boolean(evalAfterClose.error));
    rec('d. other pages unaffected by destroy', { Atext: await pageA.inputValue('#text'), shellCount: await shellPage.locator('#count').textContent() }, (await pageA.inputValue('#text')) === 'hello veltriva');
    obs.destroyMs = round(now() - tDestroy);

    // ---- (e) tab created after launch ----
    windowEvents.length = 0;
    pageEvents.length = 0;
    const blankId = await electronApp.evaluate(() => globalThis.__veltrivaTest.createTab({ label: 'late-blank' }));
    await sleep(1_500);
    rec('e. new attached view that never navigated: Page reported?', { windowEvents: windowEvents.length, pageEvents: pageEvents.length, windows: electronApp.windows().length }, null,
      'Playwright docs: "window" is issued for windows that are created and loaded');
    obs.blankViewReported = windowEvents.length > 0;

    const tLoad = now();
    const lateUrl = await electronApp.evaluate(() => globalThis.__veltrivaTest.fixtureUrl('/timers.html?late=1', 'b.test'));
    await electronApp.evaluate((_e, { id, url }) => globalThis.__veltrivaTest.load(id, url), { id: blankId, url: lateUrl });
    const latePage = await pollUntil(() => electronApp.windows().find((p) => p.url() === lateUrl), { timeoutMs: 8_000 });
    const lateMs = round(now() - tLoad);
    rec('e. same view after loadURL(): exactly one new Page, usable',
      { windowEvents: windowEvents.map((e) => e.url), pageEvents: pageEvents.length, ms: lateMs, windows: electronApp.windows().length, title: latePage ? await latePage.title() : null, ticks: latePage ? await latePage.evaluate(() => window.__t.intervalTicks) : null },
      Boolean(latePage) && windowEvents.length === 1 && pageEvents.length === 1 && electronApp.windows().length === 3);

    const directBefore = windowEvents.length;
    const tDirect = now();
    const directUrl = await electronApp.evaluate(() => globalThis.__veltrivaTest.fixtureUrl('/form.html?late=2', 'a.test'));
    const directEvent = electronApp.waitForEvent('window', { timeout: 8_000 }).then((page) => page, (error) => ({ error: firstLine(error) }));
    await electronApp.evaluate((_e, url) => globalThis.__veltrivaTest.createTab({ label: 'late-direct', url }), directUrl);
    const directPage = await directEvent;
    const directOk = !directPage.error;
    if (directOk) await directPage.waitForLoadState('load', { timeout: 8_000 });
    const directTitle = directOk ? await directPage.title() : directPage.error;
    rec('e. createTab(url) after launch: waitForEvent("window") yields a usable Page',
      { ms: round(now() - tDirect), url: directOk ? directPage.url() : null, title: directTitle, eventsDuringWait: windowEvents.length - directBefore, windows: electronApp.windows().length },
      directOk && electronApp.windows().length === 4 && directTitle === 'form');
    if (directOk) await directPage.fill('#text', 'late tab ok');
    rec('e. interact with a tab created after launch', directOk ? await directPage.inputValue('#text') : null, directOk ? (await directPage.inputValue('#text')) === 'late tab ok' : false);

    // Closing a tab Page from the test side goes through webContents.close() and skips removeChildView().
    const closeProbe = new Promise((resolve) => latePage.once('close', () => resolve(true)));
    await latePage.close();
    const closedEvent = await within(5_000, closeProbe);
    const lateRegistry = (await electronApp.evaluate(() => globalThis.__veltrivaTest.tabs())).find((t) => t.id === blankId);
    const stillChild = await electronApp.evaluate((_e, id) => globalThis.__veltrivaTest.isChild(id), blankId);
    rec('e. page.close() on a tab Page closes its WebContents; the view is no longer a window child',
      { closeEvent: closedEvent.value === true, windows: electronApp.windows().length, registryDestroyed: lateRegistry.destroyed, viewStillChildOfWindow: stillChild },
      closedEvent.value === true && lateRegistry.destroyed === true,
      'Playwright closes via webContents.close() (no removeChildView, no TabManager bookkeeping); Electron drops the dead view from contentView by itself');
    obs.pageCloseLeavesViewAsChild = stillChild;

    // A tab whose view was navigated but never attached to the window.
    const orphanUrl = await electronApp.evaluate(() => globalThis.__veltrivaTest.fixtureUrl('/timers.html?orphan=1', 'b.test'));
    const orphanEvent = electronApp.waitForEvent('window', { timeout: 5_000 }).then((page) => page, (error) => ({ error: firstLine(error) }));
    await electronApp.evaluate((_e, url) => globalThis.__veltrivaTest.createTab({ label: 'orphan', url, attach: false }), orphanUrl);
    const orphanPage = await orphanEvent;
    rec('e. view that navigated but was never attached to the window',
      orphanPage.error ? orphanPage.error : { reported: true, url: orphanPage.url(), ticks: await orphanPage.evaluate(() => window.__t.intervalTicks).catch((e) => firstLine(e)) },
      null);
    obs.unattachedViewReported = !orphanPage.error;
  } catch (error) {
    rec('cycle aborted by exception', firstLine(error), false);
    if (verbose) console.error(error);
  } finally {
    if (electronApp) closeInfo = await closeApp(electronApp);
  }
  const exitCode = proc?.exitCode ?? null;
  timings.closeMs = closeInfo.closeMs;
  timings.totalMs = round(now() - tCycle);
  const failed = rows.filter((r) => r.pass === false).map((r) => r.name);
  return { index, ok: failed.length === 0 && !closeInfo.forcedKill, failed, forcedKill: Boolean(closeInfo.forcedKill), closeError: closeInfo.closeError, exitCode, timings, obs, rows };
}

/** Raw spawn of the Electron binary with ELECTRON_RUN_AS_NODE=1 and Playwright's launch flags. */
function rawRunAsNode() {
  return new Promise((resolve) => {
    const child = spawn(electronExe, ['--inspect=0', '--remote-debugging-port=0', APP_MAIN], {
      env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }),
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const killer = setTimeout(() => child.kill(), 10_000);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ exitCode: code, signal, output: out.trim().split('\n').slice(0, 6).map((l) => l.trim()) });
    });
  });
}

async function runAsNodePhase() {
  const t0 = now();
  // Playwright 1.64.1 leaves some launch-watcher promises without a rejection handler; capture what escapes.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(firstLine(reason));
  process.on('unhandledRejection', onUnhandled);
  let outcome;
  let app;
  try {
    app = await _electron.launch({ executablePath: electronExe, args: [APP_MAIN], env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }), timeout: 15_000 });
    outcome = { launched: true, windows: app.windows().length };
  } catch (error) {
    outcome = { launched: false, error: String(error?.message ?? error).split('\n').slice(0, 12).map((l) => l.trim()).filter(Boolean) };
  } finally {
    if (app) await closeApp(app);
  }
  await sleep(500);
  process.off('unhandledRejection', onUnhandled);
  return { playwright: outcome, unhandledRejectionsEscapingLaunch: unhandled, ms: round(now() - t0), raw: await rawRunAsNode() };
}

/** One launch without executablePath: Playwright resolves electron itself and injects `-r loader.js`. */
async function runLoaderModePhase() {
  let app;
  try {
    app = await _electron.launch({ args: [APP_MAIN], env: cleanEnv(), timeout: 30_000 });
    await pollUntil(() => app.windows().length === 3, { timeoutMs: 10_000 });
    const mainInfo = await app.evaluate(() => globalThis.__veltrivaTest.mainInfo());
    const kinds = app.windows().map((p) => kindOf(p.url()));
    return { launched: true, windows: kinds, argv: mainInfo.argv.slice(1), switches: { disableRendererBackgrounding: mainInfo.hasDisableRendererBackgrounding, disableBackgroundingOccluded: mainInfo.hasDisableBackgroundingOccluded } };
  } catch (error) {
    return { launched: false, error: firstLine(error) };
  } finally {
    if (app) await closeApp(app);
  }
}

/** Control: the same app started by plain spawn (no Playwright, no inspector flags) samples tab B in three states. */
function runControlPhase() {
  return new Promise((resolve) => {
    const file = path.join(RESULTS_DIR, 'control-no-playwright.json');
    fs.rmSync(file, { force: true });
    const child = spawn(electronExe, [APP_MAIN], { env: cleanEnv({ S6_CONTROL: '1' }), windowsHide: true, stdio: 'ignore' });
    const killer = setTimeout(() => child.kill(), 40_000);
    child.on('exit', (code) => {
      clearTimeout(killer);
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete data.generatedAt;
      } catch {
        /* missing file means the control failed */
      }
      resolve({ exitCode: code, results: data });
    });
  });
}

/** Minimal raw CDP client over Node's built-in WebSocket (no Playwright involved). */
function rawCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    };
    ws.onerror = () => reject(new Error(`websocket error for ${wsUrl}`));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((done) => {
            const id = ++nextId;
            pending.set(id, done);
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

/**
 * Bisect for the visibility difference: start the app with only --remote-debugging-port, talk to tab B
 * through raw CDP, and toggle Emulation.setFocusEmulationEnabled (the command Playwright sends to every page).
 */
async function runFocusEmulationBisect() {
  const child = spawn(electronExe, ['--remote-debugging-port=0', APP_MAIN], { env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const endpoint = await pollUntil(() => stderr.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//)?.[1], { timeoutMs: 20_000 });
    if (!endpoint) throw new Error('no DevTools endpoint');
    const target = await pollUntil(async () => (await (await fetch(`http://${endpoint}/json/list`)).json()).find((t) => t.url.includes('timers.html') && t.type === 'page'), { timeoutMs: 20_000 });
    if (!target) throw new Error('tab B target not found');
    await sleep(1_500); // let the app finish its own setup (tab B is attached and hidden with setVisible(false))
    const cdp = await rawCdp(target.webSocketDebuggerUrl);
    const sample = async (label) => {
      const read = async () => (await cdp.send('Runtime.evaluate', { expression: '({ vis: document.visibilityState, t: window.__t.intervalTicks, r: window.__t.rafTicks })', returnByValue: true })).result.result.value;
      const a = await read();
      await sleep(1_300);
      const b = await read();
      return { step: label, visibilityState: b.vis, intervalTicksPer1300ms: b.t - a.t, rafTicksPer1300ms: b.r - a.r };
    };
    const steps = [];
    steps.push(await sample('raw CDP session attached, nothing enabled'));
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    steps.push(await sample('after Emulation.setFocusEmulationEnabled(true)'));
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    steps.push(await sample('after Emulation.setFocusEmulationEnabled(false)'));
    cdp.close();
    const browser = await rawCdp((await (await fetch(`http://${endpoint}/json/version`)).json()).webSocketDebuggerUrl);
    void browser.send('Browser.close'); // the browser may close the socket without answering
    return { steps };
  } catch (error) {
    return { error: firstLine(error), stderr: stderr.split('\n').slice(0, 4) };
  } finally {
    const done = await within(8_000, exited);
    if (done.timedOut) child.kill();
  }
}

/** Counts electron.exe processes whose command line mentions this spike (renderers carry --user-data-dir). */
function leftoverElectronProcesses() {
  try {
    const ps = "(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*s6-test-reach*' } | Measure-Object).Count";
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim());
  } catch (error) {
    return `unknown: ${firstLine(error)}`;
  }
}

function summarize(cycles) {
  const timingKeys = ['launchMs', 'threePagesMs', 'closeMs', 'totalMs'];
  const timings = {};
  for (const key of timingKeys) {
    const xs = cycles.map((c) => c.timings[key]).filter((x) => typeof x === 'number');
    timings[key] = xs.length ? { median: round(median(xs)), min: Math.min(...xs), max: Math.max(...xs), n: xs.length } : null;
  }
  const tally = (key) => cycles.reduce((acc, c) => ((acc[c.obs[key]] = (acc[c.obs[key]] ?? 0) + 1), acc), {});
  const perCheck = {};
  for (const c of cycles) for (const r of c.rows) {
    const entry = (perCheck[r.name] ??= { pass: 0, fail: 0, info: 0 });
    entry[r.pass === null ? 'info' : r.pass ? 'pass' : 'fail'] += 1;
  }
  return {
    cycles: cycles.length,
    okCycles: cycles.filter((c) => c.ok).length,
    failedCycles: cycles.filter((c) => !c.ok).map((c) => ({ index: c.index, failed: c.failed, forcedKill: c.forcedKill, closeError: c.closeError })),
    nonZeroExitCodes: cycles.filter((c) => c.exitCode !== 0).map((c) => ({ index: c.index, exitCode: c.exitCode })),
    timings,
    tallies: {
      firstWindowKind: tally('firstWindowKind'),
      windowsOrder: tally('windowsOrder'),
      windowsAtLaunchResolve: tally('windowsAtLaunchResolve'),
      setVisibleFalseVisibility: tally('setVisibleFalseVisibility'),
      setVisibleFalseClick: tally('setVisibleFalseClick'),
      focusEmulationOffVisibility: tally('focusEmulationOffVisibility'),
      detachedVisibility: tally('detachedVisibility'),
      detachedClick: tally('detachedClick'),
      blankViewReported: tally('blankViewReported'),
      pageCloseLeavesViewAsChild: tally('pageCloseLeavesViewAsChild'),
      unattachedViewReported: tally('unattachedViewReported'),
    },
    perCheck,
  };
}

(async () => {
  // Development shortcut: S6_ONLY=bisect|control|runAsNode|loader runs a single extra phase and exits.
  const only = { bisect: runFocusEmulationBisect, control: runControlPhase, runAsNode: runAsNodePhase, loader: runLoaderModePhase }[process.env.S6_ONLY];
  if (only) {
    console.log(JSON.stringify(await only(), null, 2));
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  const cycles = [];
  for (let i = 1; i <= CYCLES; i++) {
    console.log(`\n=== cycle ${i}/${CYCLES} ===`);
    const cycle = await runCycle(i, { verbose: i === 1 });
    cycles.push(cycle);
    console.log(`cycle ${i}: ${cycle.ok ? 'OK' : `FAILED ${JSON.stringify(cycle.failed)}`}  launch=${cycle.timings.launchMs}ms  3 pages=${cycle.timings.threePagesMs}ms  close=${cycle.timings.closeMs}ms  total=${cycle.timings.totalMs}ms  exit=${cycle.exitCode}`);
  }

  console.log('\n=== ELECTRON_RUN_AS_NODE=1 ===');
  const runAsNode = await runAsNodePhase();
  console.log(JSON.stringify(runAsNode, null, 2));

  console.log('\n=== launch without executablePath (Playwright loader) ===');
  const loaderMode = await runLoaderModePhase();
  console.log(JSON.stringify(loaderMode, null, 2));

  console.log('\n=== control without Playwright ===');
  const control = await runControlPhase();
  console.log(JSON.stringify(control, null, 2));

  console.log('\n=== raw CDP bisect: Emulation.setFocusEmulationEnabled ===');
  const bisect = await runFocusEmulationBisect();
  console.log(JSON.stringify(bisect, null, 2));

  await sleep(1500);
  const leftover = leftoverElectronProcesses();
  console.log(`\nleftover electron.exe processes mentioning s6-test-reach: ${leftover}`);

  const summary = summarize(cycles);
  console.log('\n=== summary ===');
  console.log(JSON.stringify({ ...summary, perCheck: undefined }, null, 2));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, 's6-test-reach.json');
  fs.writeFileSync(file, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    startedAt,
    versions: {
      playwrightCore: require('playwright-core/package.json').version,
      electron: require('electron/package.json').version,
      node: process.versions.node,
      os: `${process.platform} ${os.release()}`,
      cpu: os.cpus()[0]?.model,
    },
    note: 'Timings are indicative: other spikes may have been running Electron concurrently.',
    summary,
    firstCycleRows: cycles[0]?.rows,
    runAsNode,
    loaderMode,
    controlWithoutPlaywright: control,
    focusEmulationBisect: bisect,
    leftoverProcesses: leftover,
    cycles: cycles.map(({ rows, ...rest }) => rest),
  }, null, 2)}\n`);
  console.log(`results written: ${file}`);
  process.exit(summary.okCycles === summary.cycles ? 0 : 1);
})().catch((error) => {
  console.error('run.js fatal:', error);
  process.exit(2);
});
