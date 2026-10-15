'use strict';
// A minimal Electron browser for the user to run BY HAND (S7 manual checks). Not run by the spike automation.
//
//   cd C:/GitHub/Veltriva/spikes
//   ./node_modules/.bin/electron s7-web-compat/manual-browser.js [url]
//
// What it does (and nothing more):
//   * cleaned user agent (no "Electron/x.y.z", no app-name token) via app.userAgentFallback + session.setUserAgent
//   * deny-by-default permissions; only fullscreen, clipboard-sanitized-write and pointerLock are allowed;
//     openExternal (mailto:, zoommtg:, ...) is always denied and logged to this terminal
//   * window.open popups are hosted with createWindow so window.opener / postMessage keep working (OAuth);
//     plain target=_blank / ctrl / middle clicks load in the main tab
//   * HTML fullscreen (YouTube) is handed to the window by hand, because WebContentsView does not do it for us
//   * Ctrl+Shift+I opens DevTools for the tab, so you can look at navigator.userAgent yourself
// The profile is persistent and lives in spikes/s7-web-compat/user-data/manual (gitignored). Delete that folder
// when you are done, especially after signing in anywhere. The page content never gets a preload or any IPC.

const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron');
const path = require('node:path');
const h = require('../shared/harness');
const lib = require('./lib');

const startUrl = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'about:blank';
// Long fail-safe: this is interactive. S7_MANUAL_PROFILE lets the automated self-test use a throwaway profile.
lib.setup(process.env.S7_MANUAL_PROFILE ?? 'manual', { failSafeMs: 8 * 60 * 60 * 1000, fresh: Boolean(process.env.S7_MANUAL_PROFILE) });

const PARTITION = 'persist:manual-browsing';
const TOOLBAR_HEIGHT = 44;
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

// Must happen before ready. Strips Electron/x.y.z and the app-name token.
app.userAgentFallback = lib.cleanUserAgent(app.userAgentFallback);

const log = (...args) => console.log('[manual-browser]', ...args);

function hardenSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allow = ALLOWED_PERMISSIONS.has(permission);
    log(`permission request: ${permission} ${details?.externalURL ?? details?.requestingUrl ?? ''} -> ${allow ? 'allowed' : 'DENIED'}`);
    callback(allow);
  });
  ses.setPermissionCheckHandler((wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((request, callback) => callback({})); // no screen sharing
  ses.on('select-client-certificate', (event, wc, url, list, callback) => {
    event.preventDefault();
    log(`client certificate requested by ${url}: declined`);
    callback(); // no certificate
  });
}

app.whenReady().then(() => {
  const tabSession = session.fromPartition(PARTITION);
  tabSession.setUserAgent(lib.cleanUserAgent(tabSession.getUserAgent())); // also covers workers and service workers
  hardenSession(tabSession);
  hardenSession(session.defaultSession); // the toolbar page lives here and needs nothing

  const win = new BaseWindow({ width: 900, height: 600, title: 'S7 manual browser' });

  const toolbar = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'manual-toolbar-preload.js') },
  });
  toolbar.webContents.loadFile(path.join(__dirname, 'manual-toolbar.html'));
  toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  toolbar.webContents.on('will-navigate', (event) => event.preventDefault());

  const tab = new WebContentsView({ webPreferences: { ...h.TAB_PREFS, partition: PARTITION } });
  const wc = tab.webContents;
  win.contentView.addChildView(toolbar);
  win.contentView.addChildView(tab);

  let fullscreenByPage = false;
  function layout() {
    const [width, height] = win.getContentSize();
    if (fullscreenByPage) {
      tab.setBounds({ x: 0, y: 0, width, height });
    } else {
      toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
      tab.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
    }
  }
  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  layout();

  // --- HTML fullscreen (e.g. YouTube's fullscreen button): the embedder has to make the window fullscreen ---
  wc.on('enter-html-full-screen', () => {
    log('page entered HTML fullscreen');
    fullscreenByPage = true;
    toolbar.setVisible(false);
    win.setFullScreen(true);
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    log('page left HTML fullscreen');
    fullscreenByPage = false;
    toolbar.setVisible(true);
    win.setFullScreen(false);
    layout();
  });

  // --- navigation + toolbar ---
  const sendUrl = () => { if (!toolbar.webContents.isDestroyed()) toolbar.webContents.send('nav:url', wc.getURL()); };
  wc.on('did-navigate', sendUrl);
  wc.on('did-navigate-in-page', sendUrl);
  wc.on('page-title-updated', (e, title) => win.setTitle(`${title} - S7 manual browser`));
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) log(`load failed (${code} ${desc}): ${url}`); });
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') wc.openDevTools({ mode: 'detach' });
  });

  const fromToolbar = (event) => event.sender === toolbar.webContents; // ignore IPC from anywhere else
  ipcMain.on('nav:go', (event, value) => {
    if (!fromToolbar(event)) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
    if (!/^(https?:|about:blank$)/i.test(url)) return log(`refusing to navigate to non-web URL: ${url}`);
    wc.loadURL(url).catch(() => {});
  });
  ipcMain.on('nav:back', (event) => { if (fromToolbar(event)) wc.navigationHistory.goBack(); });
  ipcMain.on('nav:forward', (event) => { if (fromToolbar(event)) wc.navigationHistory.goForward(); });
  ipcMain.on('nav:reload', (event) => { if (fromToolbar(event)) wc.reload(); });

  // --- popups: window.open keeps window.opener; plain tab-ish opens load in the main tab ---
  function hostPopup(options, details) {
    const popupWin = new BaseWindow({ width: 520, height: 600, title: details.url });
    const popupView = options.webContents
      ? new WebContentsView({ webContents: options.webContents }) // pre-created by Chromium, so window.opener survives
      : new WebContentsView({ webPreferences: { ...h.TAB_PREFS, partition: PARTITION } });
    popupWin.contentView.addChildView(popupView);
    const fit = () => { const [w, hgt] = popupWin.getContentSize(); popupView.setBounds({ x: 0, y: 0, width: w, height: hgt }); };
    popupWin.on('resize', fit);
    fit();
    const popup = popupView.webContents;
    // Always-visible URL: show it in the window title.
    const retitle = () => { if (!popupWin.isDestroyed() && !popup.isDestroyed()) popupWin.setTitle(popup.getURL()); };
    popup.on('did-navigate', retitle);
    popup.on('did-navigate-in-page', retitle);
    // window.close() from the page destroys the contents; Electron leaves the empty host window to us.
    popup.once('destroyed', () => { if (!popupWin.isDestroyed()) popupWin.close(); });
    popupWin.once('closed', () => { if (!popup.isDestroyed()) popup.close(); });
    if (!options.webContents) popup.loadURL(details.url).catch(() => {});
    log(`popup opened: ${details.url} (pre-created contents: ${Boolean(options.webContents)}, features: "${details.features}")`);
    return popup;
  }

  const popupPolicy = (details) => {
    if (!/^https?:/i.test(details.url)) {
      log(`window.open of non-web URL blocked: ${details.url}`);
      return { action: 'deny' };
    }
    const featurePopup = details.disposition === 'new-window' || details.features !== '';
    if (featurePopup) return { action: 'allow', createWindow: (options) => hostPopup(options, details) };
    log(`${details.disposition}: loading in the main tab: ${details.url}`);
    wc.loadURL(details.url).catch(() => {});
    return { action: 'deny' };
  };
  wc.setWindowOpenHandler(popupPolicy);
  // Popups themselves can open further popups; give them the same policy.
  app.on('web-contents-created', (event, created) => {
    if (created !== wc && created !== toolbar.webContents) created.setWindowOpenHandler(popupPolicy);
  });

  log('cleaned UA: ' + wc.getUserAgent());
  log('Ctrl+Shift+I opens DevTools. Denied permissions and external-protocol attempts are logged here.');
  log(`profile: ${app.getPath('userData')} (delete it when finished)`);
  if (startUrl !== 'about:blank') wc.loadURL(startUrl).catch(() => {});
  else wc.loadURL('about:blank');

  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
