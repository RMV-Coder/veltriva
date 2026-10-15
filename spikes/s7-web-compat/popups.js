'use strict';
// S7 check 4: popups.
//   A  window.open during page load, no user gesture: is setWindowOpenHandler called? (handler denies)
//   B  same page, handler allows via createWindow hosting options.webContents in a second BaseWindow:
//      does the child keep window.opener, does postMessage reach the opener, do child prefs stay hardened,
//      what happens on window.close() in the child, and the same for a cross-site (a.test -> b.test) popup.
//   C  real mouse clicks (sendInputEvent) on target=_blank / ctrl / middle / shift / window.open button:
//      which disposition is reported, and is options.webContents provided to createWindow?

const { app, BaseWindow, WebContentsView, session } = require('electron');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');
const lib = require('./lib');

lib.setup('popups', { failSafeMs: 120_000 });

const plain = (details) => JSON.parse(JSON.stringify(details));
/** executeJavaScript on a contents that never loaded anything can hang; bound every probe. */
const within = (promise, ms, fallback) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

app.whenReady().then(async () => {
  const rows = [];
  const fixture = await startFixtureServer();
  const ses = session.fromPartition(h.TAB_PREFS.partition);
  // Nothing in this spike needs a permission; deny + log anyway.
  const permLog = [];
  lib.installDenyHandlers(ses, permLog);

  const win = h.createWindow({ width: 700, height: 500, title: 'S7 popups (opener)' });
  win.setPosition(20, 20);
  const view = h.createTabView(win);
  const wc = view.webContents;
  await wc.loadURL('about:blank');
  const visibilityState = await lib.stabilizeWindow(win, wc);

  // ---------- handler behaviour is switched per phase ----------
  const calls = []; // every setWindowOpenHandler invocation
  const hosted = []; // popups we host
  let behaviour = 'deny';
  let hostFresh = false; // when options.webContents is absent, create a fresh contents ourselves

  function hostPopup(options, details) {
    const popupWin = new BaseWindow({ width: 480, height: 360, title: 'S7 popup', x: 740, y: 20 });
    popupWin.setAlwaysOnTop(true);
    let popupView;
    if (options.webContents) {
      popupView = new WebContentsView({ webContents: options.webContents });
    } else {
      popupView = new WebContentsView({ webPreferences: { ...h.TAB_PREFS } });
      hostFresh = true;
    }
    popupView.setBounds({ x: 0, y: 0, width: 464, height: 320 });
    popupWin.contentView.addChildView(popupView);
    const record = { win: popupWin, view: popupView, url: details.url, destroyedAt: null, closedWindow: false };
    popupView.webContents.once('destroyed', () => { record.destroyedAt = Date.now(); });
    popupWin.once('closed', () => { record.closedWindow = true; });
    hosted.push(record);
    return popupView.webContents;
  }

  wc.setWindowOpenHandler((details) => {
    const entry = { at: Date.now(), details: plain(details), behaviour, createWindowCalled: false, optionsHadWebContents: null, optionKeys: null };
    calls.push(entry);
    if (behaviour === 'deny') return { action: 'deny' };
    return {
      action: 'allow',
      // B3 checks whether this can restore safeDialogs on the popup (it is not inherited from the opener).
      ...(behaviour === 'host-override' ? { overrideBrowserWindowOptions: { webPreferences: { safeDialogs: true } } } : {}),
      createWindow: (options) => {
        entry.createWindowCalled = true;
        entry.optionsHadWebContents = Boolean(options.webContents);
        entry.optionKeys = Object.keys(options);
        return hostPopup(options, details);
      },
    };
  });

  // ---------- A: no user gesture, handler denies ----------
  const loadEvents = [];
  wc.on('dom-ready', () => loadEvents.push({ e: 'dom-ready', at: Date.now() }));
  wc.on('did-finish-load', () => loadEvents.push({ e: 'did-finish-load', at: Date.now() }));
  behaviour = 'deny';
  loadEvents.length = 0;
  await wc.loadURL(fixture.url('/popup.html?onload=1', 'a.test'));
  await h.sleep(500);
  // userGesture=false on purpose: a gesture-flagged probe would itself activate the frame.
  const gestureState = await wc.executeJavaScript('JSON.stringify({ onloadResult: window.__onloadResult, userActivationIsActive: navigator.userActivation.isActive, userActivationHasBeenActive: navigator.userActivation.hasBeenActive })');
  h.record(rows, 'A: handler invoked for window.open during load with no gesture', {
    invocations: calls.length,
    handlerBeforeDomReady: calls[0] && loadEvents.length ? calls[0].at <= loadEvents.find((l) => l.e === 'dom-ready').at : null,
    details: calls[0]?.details,
    page: JSON.parse(gestureState),
  }, calls.length === 1, 'true = no built-in popup blocker; the handler still sees it');

  // ---------- B: allow + createWindow hosting options.webContents ----------
  behaviour = 'host';
  const beforeB = calls.length;
  await wc.loadURL(fixture.url('/popup.html?onload=1', 'a.test'));
  await h.pollUntil(() => hosted.length > 0, { timeoutMs: 8000 });
  await h.sleep(1500);
  const child = hosted[0]?.view.webContents;
  const childInfo = child && {
    url: child.getURL(),
    sameSession: child.session === ses,
    lastWebPreferences: (({ sandbox, contextIsolation, nodeIntegration, webSecurity, safeDialogs, partition }) => ({ sandbox, contextIsolation, nodeIntegration, webSecurity, safeDialogs, partition }))(child.getLastWebPreferences()),
    // Which of the opener's hardened TAB_PREFS did the pre-created popup contents NOT inherit?
    prefsNotInherited: Object.fromEntries(Object.entries(h.TAB_PREFS).filter(([k, v]) => k !== 'partition' && child.getLastWebPreferences()[k] !== v).map(([k, v]) => [k, { expected: v, got: child.getLastWebPreferences()[k] }])),
    openerPrefs: (({ sandbox, contextIsolation, safeDialogs }) => ({ sandbox, contextIsolation, safeDialogs }))(wc.getLastWebPreferences()),
    page: await child.executeJavaScript('JSON.stringify({ hasOpener: Boolean(window.opener), status: document.getElementById("status").textContent, requireType: typeof require, processType: typeof process, name: window.name })', true).then(JSON.parse, (e) => `error ${e.message}`),
  };
  const openerMessages = await wc.executeJavaScript('JSON.stringify({ messages: window.__messages, onloadResult: window.__onloadResult })', true).then(JSON.parse);
  h.record(rows, 'B: same-site popup hosted via createWindow keeps window.opener and postMessage reaches opener', {
    call: calls[beforeB] && { ...calls[beforeB], at: undefined },
    child: childInfo,
    opener: openerMessages,
  }, Boolean(childInfo?.page?.hasOpener) && openerMessages.messages.length === 1);

  // child calls window.close(): what happens to the hosted contents/window?
  const closeBefore = hosted[0].destroyedAt;
  await child.executeJavaScript('window.close()', true).catch(() => {});
  await h.sleep(1000);
  h.record(rows, 'B: window.close() inside the hosted popup', {
    webContentsDestroyed: child.isDestroyed(),
    hostWindowStillOpen: !hosted[0].win.isDestroyed(),
  }, null, 'the host window must be closed by the browser; Electron does not close it for us');
  if (!hosted[0].win.isDestroyed()) hosted[0].win.close();

  // B2: cross-site popup (a.test opens b.test), typical for OAuth
  hosted.length = 0;
  await wc.loadURL(fixture.url('/popup.html', 'a.test'));
  const crossUrl = fixture.url('/popup-child.html', 'b.test');
  const callsBefore = calls.length;
  await wc.executeJavaScript(`window.__crossResult = String(Boolean(window.open(${JSON.stringify(crossUrl)}, 'idp', 'width=400,height=300')))`, true);
  await h.pollUntil(() => hosted.length > 0, { timeoutMs: 8000 });
  await h.sleep(1500);
  const cross = hosted[0]?.view.webContents;
  const crossInfo = cross && {
    url: cross.getURL(),
    openerProcessId: wc.getOSProcessId(),
    childProcessId: cross.getOSProcessId(),
    page: await cross.executeJavaScript('JSON.stringify({ hasOpener: Boolean(window.opener), status: document.getElementById("status").textContent })', true).then(JSON.parse, (e) => `error ${e.message}`),
  };
  const crossMessages = await wc.executeJavaScript('JSON.stringify(window.__messages)', true).then(JSON.parse);
  h.record(rows, 'B2: cross-site popup (a.test -> b.test) keeps window.opener; message reaches opener', {
    call: calls[callsBefore]?.details,
    child: crossInfo,
    openerMessages: crossMessages,
  }, Boolean(crossInfo?.page?.hasOpener) && crossMessages.length === 1);
  hosted.forEach((p) => { if (!p.win.isDestroyed()) p.win.close(); });
  hosted.length = 0;

  // B3: does overrideBrowserWindowOptions restore safeDialogs on a pre-created popup?
  behaviour = 'host-override';
  hosted.length = 0;
  await wc.loadURL(fixture.url('/popup.html', 'a.test'));
  const b3Before = calls.length;
  await wc.executeJavaScript("window.openPopup()", true);
  await h.pollUntil(() => hosted.length > 0, { timeoutMs: 8000 });
  await h.sleep(800);
  const b3Child = hosted[0]?.view.webContents;
  h.record(rows, 'B3: safeDialogs on popup when handler returns overrideBrowserWindowOptions.webPreferences.safeDialogs=true', {
    optionsWebPreferences: calls[b3Before]?.optionKeys,
    popupSafeDialogs: b3Child?.getLastWebPreferences().safeDialogs,
    openerSafeDialogs: wc.getLastWebPreferences().safeDialogs,
  }, null);
  hosted.forEach((p) => { if (!p.win.isDestroyed()) p.win.close(); });
  hosted.length = 0;
  behaviour = 'host';

  // ---------- C: real clicks ----------
  await wc.loadURL(fixture.url('/popup.html', 'a.test'));
  await h.sleep(300);
  wc.focus();

  async function realClick(selector, { button = 'left', modifiers = [] } = {}) {
    const rect = await wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`, true);
    wc.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y, modifiers });
    wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button, clickCount: 1, modifiers });
    wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button, clickCount: 1, modifiers });
  }

  const variants = [
    { label: 'left click on target=_blank link', selector: '#blank', input: {} },
    { label: 'ctrl+left click on target=_blank link', selector: '#blank', input: { modifiers: ['control'] } },
    { label: 'shift+left click on target=_blank link', selector: '#blank', input: { modifiers: ['shift'] } },
    { label: 'middle click on target=_blank link', selector: '#blank', input: { button: 'middle' } },
    { label: 'left click on button that calls window.open (user gesture, features=width/height)', selector: '#open', input: {} },
  ];
  const clickResults = [];
  for (const variant of variants) {
    console.log('[popups] variant:', variant.label);
    hosted.length = 0;
    hostFresh = false;
    const before = calls.length;
    await realClick(variant.selector, variant.input);
    console.log('[popups]  clicked');
    await h.pollUntil(() => calls.length > before, { timeoutMs: 3000 });
    console.log('[popups]  handler calls:', calls.length - before);
    await h.sleep(1200);
    const call = calls[before];
    const popupContents = hosted[0]?.view.webContents;
    clickResults.push({
      label: variant.label,
      handlerInvoked: Boolean(call),
      disposition: call?.details.disposition,
      url: call?.details.url,
      frameName: call?.details.frameName,
      features: call?.details.features,
      referrer: call?.details.referrer,
      createWindowCalled: call?.createWindowCalled,
      optionsHadWebContents: call?.optionsHadWebContents,
      hostedUrlAfter1s: popupContents && !popupContents.isDestroyed() ? popupContents.getURL() : null,
      hasOpener: popupContents && !popupContents.isDestroyed() ? await within(popupContents.executeJavaScript('Boolean(window.opener)').catch(() => 'n/a'), 2000, 'no-response (nothing loaded)') : null,
      freshContentsCreatedByUs: hostFresh,
    });
    hosted.forEach((p) => { if (!p.win.isDestroyed()) p.win.close(); });
  }
  for (const r of clickResults) h.record(rows, `C: ${r.label}`, r, null);

  h.record(rows, 'permission requests seen during popup tests', permLog, null);

  h.writeResults(__dirname, 'popups', { visibilityState, rows });
  hosted.forEach((p) => { if (!p.win.isDestroyed()) p.win.close(); });
  lib.releaseWindow(win);
  h.destroyView(win, view);
  win.close();
  await fixture.close();
  app.exit(0);
});
