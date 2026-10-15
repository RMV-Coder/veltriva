'use strict';
// S6 test app: one BaseWindow, one trusted "shell" WebContentsView and two tab WebContentsViews
// (different sites). Exposes globalThis.__veltrivaTest so Playwright's electronApp.evaluate()
// can inspect and manipulate views from the main process. Launched by run.js, not by hand.

const { app, session, BaseWindow, WebContentsView } = require('electron');
const path = require('node:path');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');

h.prepareApp(__dirname);
h.failSafe(120_000, 's6-app');

const SHELL_HEIGHT = 72;

app.whenReady().then(async () => {
  // Deny every permission in both sessions used here (the default one hosts the shell).
  for (const ses of [session.defaultSession, session.fromPartition(h.TAB_PREFS.partition)]) {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  }

  const fixture = await startFixtureServer();
  const win = h.createWindow({ width: 900, height: 600, title: 'Veltriva S6' });

  const [width, height] = win.getContentSize();
  const shellBounds = { x: 0, y: 0, width, height: SHELL_HEIGHT };
  const tabBounds = { x: 0, y: SHELL_HEIGHT, width, height: height - SHELL_HEIGHT };

  // --- shell view (trusted UI, default session, local file) ---
  const shell = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  shell.setBounds(shellBounds);
  win.contentView.addChildView(shell);

  // --- tab registry ---
  /** @type {Map<number, {id:number, label:string, view:WebContentsView, destroyed:boolean}>} */
  const tabs = new Map();
  let nextId = 1;

  function addTab({ label, url, visible = true, attach = true }) {
    const id = nextId++;
    const view = new WebContentsView({ webPreferences: { ...h.TAB_PREFS } });
    view.setBounds(tabBounds);
    if (attach) win.contentView.addChildView(view);
    view.setVisible(visible);
    const record = { id, label, view, destroyed: false };
    view.webContents.once('destroyed', () => {
      record.destroyed = true;
    });
    tabs.set(id, record);
    if (url) view.webContents.loadURL(url).catch(() => {});
    return record;
  }

  function get(id) {
    const record = tabs.get(id);
    if (!record) throw new Error(`unknown tab ${id}`);
    return record;
  }

  function describe(record) {
    const { id, label, view, destroyed } = record;
    const wc = view.webContents;
    if (destroyed || wc.isDestroyed()) return { id, label, destroyed: true };
    return {
      id,
      label,
      destroyed: false,
      webContentsId: wc.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      attached: win.contentView.children.includes(view),
      visible: view.getVisible(),
      targetId: wc.getOrCreateDevToolsTargetId(),
    };
  }

  globalThis.__veltrivaTest = {
    /** Snapshot of every tab ever created, destroyed ones included (with destroyed: true). */
    tabs: () => [...tabs.values()].map(describe),
    shell: () => ({
      webContentsId: shell.webContents.id,
      url: shell.webContents.getURL(),
      title: shell.webContents.getTitle(),
      targetId: shell.webContents.getOrCreateDevToolsTargetId(),
    }),
    /** Detach only: removeChildView, keep the WebContents alive. */
    detach(id) {
      win.contentView.removeChildView(get(id).view);
    },
    attach(id) {
      win.contentView.addChildView(get(id).view);
    },
    /** The ADR-0002 rule: detach, close, drop references. */
    destroy(id) {
      const { view } = get(id);
      // Same steps as h.destroyView(), but reports whether removeChildView() rejected a view that was already detached.
      let removeChildViewError = null;
      try {
        win.contentView.removeChildView(view);
      } catch (error) {
        removeChildViewError = String(error.message);
      }
      if (!view.webContents.isDestroyed()) view.webContents.close();
      return { removeChildViewError };
    },
    /** Show exactly one tab, hide the others. */
    activate(id) {
      for (const record of tabs.values()) {
        if (!record.destroyed && !record.view.webContents.isDestroyed()) record.view.setVisible(record.id === id);
      }
    },
    /** Creates a tab after launch. Without `url` the view is attached but never navigated. */
    createTab({ label = 'late', url, visible = true, attach = true } = {}) {
      return addTab({ label, url, visible, attach }).id;
    },
    /** True while the tab's view is still a child of the window (a destroyed WebContents can leave its view behind). */
    isChild: (id) => win.contentView.children.includes(get(id).view),
    load(id, url) {
      return get(id).view.webContents.loadURL(url);
    },
    /** Resolves once the tab has finished its current load. */
    waitLoaded: (id) =>
      new Promise((resolve) => {
        const wc = get(id).view.webContents;
        if (!wc.isLoading() && wc.getURL()) return resolve(true);
        wc.once('did-finish-load', () => resolve(true));
      }),
    /** Reads straight from the page via the main process, as an independent cross-check of Playwright. */
    executeIn: (id, code) => get(id).view.webContents.executeJavaScript(code),
    executeInShell: (code) => shell.webContents.executeJavaScript(code),
    fixtureUrl: (p, host) => fixture.url(p, host),
    mainInfo: () => ({
      processType: process.type,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      argv: process.argv,
      baseWindows: BaseWindow.getAllWindows().length,
      hasDisableRendererBackgrounding: app.commandLine.hasSwitch('disable-renderer-backgrounding'),
      hasDisableBackgroundingOccluded: app.commandLine.hasSwitch('disable-backgrounding-occluded-windows'),
      hasRemoteDebuggingPort: app.commandLine.hasSwitch('remote-debugging-port'),
      isReadyFlag: app.isReady(),
    }),
  };

  // Initial layout: tab A visible and tab B hidden, both attached, like a browser with 2 tabs.
  const shellLoaded = shell.webContents.loadFile(path.join(__dirname, 'shell.html'));
  const tabA = addTab({ label: 'A', url: fixture.url('/form.html', 'a.test'), visible: true });
  const tabB = addTab({ label: 'B', url: fixture.url('/timers.html', 'b.test'), visible: false });
  await shellLoaded;
  await Promise.all([globalThis.__veltrivaTest.waitLoaded(tabA.id), globalThis.__veltrivaTest.waitLoaded(tabB.id)]);

  console.log('S6_APP_READY');

  if (process.env.S6_CONTROL === '1') await runControl(win);
});

/**
 * Control experiment without Playwright or any inspector flag: does a tab view that is hidden with
 * setVisible(false), or detached with removeChildView, look hidden to the page itself?
 * Samples timers.html (tab B) in three states and writes results/control-no-playwright.json.
 */
async function runControl(win) {
  const tab = globalThis.__veltrivaTest;
  const read = () => tab.executeIn(2, '({ vis: document.visibilityState, t: window.__t.intervalTicks, r: window.__t.rafTicks })');
  const sample = async () => {
    const a = await read();
    await h.sleep(1300);
    const b = await read();
    return { visibilityState: b.vis, intervalTicksPer1300ms: b.t - a.t, rafTicksPer1300ms: b.r - a.r };
  };
  // Keep the window on top so other spikes' windows cannot occlude it (native occlusion would hide the views too).
  win.setAlwaysOnTop(true);
  win.focus();
  await h.sleep(1000);
  const out = { setVisibleFalseAttached: await sample() };
  tab.activate(2); // B visible, A hidden
  out.visibleAttached = await sample();
  tab.activate(1); // back to A visible, B hidden
  tab.detach(2);
  out.detached = await sample();
  h.writeResults(__dirname, 'control-no-playwright', out);
  app.exit(0);
}
