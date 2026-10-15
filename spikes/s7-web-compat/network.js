'use strict';
// S7 check 6: what does Electron contact on its own, and can the spellcheck dictionary URL be redirected?
//   electron s7-web-compat/network.js default   fresh profile, spellcheck on, ~20 s of netlog
//   electron s7-web-compat/network.js dict      fresh profile, setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:<port>/dict/'),
//                                               then switches the spellchecker to fr + de to force a dictionary fetch
//   electron s7-web-compat/network.js fr-blocked  like default, but every non-loopback host name fails to resolve
//                                               (nothing leaves the machine) and the languages are switched to fr + de, so
//                                               the netlog still shows WHERE Electron would fetch dictionaries from
// The tab only ever loads the local fixture server (form.html). Any external host in the netlog is Electron's own.
// In 'default' mode this lets Electron do whatever it does by default (including a real dictionary download,
// which is exactly what is being measured). 'dict' mode must not need the internet for the dictionary.

const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');
const lib = require('./lib');
const { summarizeNetLog } = require('./netlog-hosts');

const mode = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'default';
const userData = lib.setup(`network-${mode}`, { failSafeMs: 120_000 });
const NETLOG_MS = 20_000;
if (mode === 'fr-blocked') {
  // Only loopback resolves; everything else fails at the resolver, before any packet is sent. No proxy either.
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
  app.commandLine.appendSwitch('no-proxy-server');
}
const netlogFile = (name) => path.join(lib.SPIKE_DIR, `netlog-${mode}-${name}.json`);

// Whole-process capture from the very start of the browser process (covers pre-ready traffic), as a cross-check
// of the two session.netLog captures started once the app is ready.
app.commandLine.appendSwitch('log-net-log', netlogFile('cmdline'));
app.commandLine.appendSwitch('net-log-capture-mode', 'Default');

async function typeText(wc, text) {
  for (const ch of text) {
    const key = ch === ' ' ? 'Space' : ch;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key });
    await h.sleep(30);
  }
}

app.whenReady().then(async () => {
  const rows = [];
  const startedAt = Date.now();
  const fixture = await startFixtureServer();
  const defaultSession = session.defaultSession;
  const tabSession = session.fromPartition(h.TAB_PREFS.partition);

  if (mode === 'dict') {
    const dictUrl = `http://127.0.0.1:${fixture.port}/dict/`;
    defaultSession.setSpellCheckerDictionaryDownloadURL(dictUrl);
    tabSession.setSpellCheckerDictionaryDownloadURL(dictUrl);
  }

  await defaultSession.netLog.startLogging(netlogFile('default-session'), { captureMode: 'default' });
  await tabSession.netLog.startLogging(netlogFile('tab-session'), { captureMode: 'default' });

  const spellBefore = {
    enabledDefault: defaultSession.isSpellCheckerEnabled(),
    enabledTab: tabSession.isSpellCheckerEnabled(),
    languagesDefaultSession: defaultSession.getSpellCheckerLanguages(),
    languagesTabSession: tabSession.getSpellCheckerLanguages(),
    availableLanguages: tabSession.availableSpellCheckerLanguages.length,
    appLocale: app.getLocale(),
  };

  const win = h.createWindow({ width: 700, height: 450, title: 'S7 network' });
  const view = h.createTabView(win);
  const wc = view.webContents;
  let contextMenu = null;
  wc.on('context-menu', (e, params) => {
    contextMenu = { misspelledWord: params.misspelledWord, suggestions: params.dictionarySuggestions };
  });
  await wc.loadURL(fixture.url('/form.html'));
  const visibilityState = await lib.stabilizeWindow(win, wc);

  // Focus the textarea, replace its content and type misspelled words with real key events.
  const rect = await wc.executeJavaScript(`(() => { const a = document.getElementById('area'); a.value = ''; a.focus(); const r = a.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`, true);
  await typeText(wc, 'teh recieve misspeled wrod ');
  const typed = await wc.executeJavaScript(`document.getElementById('area').value`);
  h.record(rows, 'typed text reached the textarea', typed, typed === 'teh recieve misspeled wrod ');

  // Give the spellchecker a moment, then right-click the first word to see whether it is flagged.
  await h.sleep(4000);
  wc.sendInputEvent({ type: 'mouseDown', x: rect.x + 12, y: rect.y + 10, button: 'right', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: rect.x + 12, y: rect.y + 10, button: 'right', clickCount: 1 });
  await h.sleep(1000);
  h.record(rows, 'context-menu on first word (spellcheck verdict)', contextMenu, null, 'null = event never fired for the synthetic right-click');

  // Force the dictionary question: switch to languages that Windows may not provide natively.
  let languageSwitch = null;
  if (mode === 'dict' || mode === 'fr-blocked') {
    const before = fixture.requests.filter((r) => r.path.startsWith('/dict/')).length;
    tabSession.setSpellCheckerLanguages(['fr', 'de']);
    await h.sleep(4000);
    languageSwitch = { languages: tabSession.getSpellCheckerLanguages(), dictRequestsTriggered: fixture.requests.filter((r) => r.path.startsWith('/dict/')).length - before };
    h.record(rows, 'after switching spellcheck languages to fr + de', languageSwitch, null);
  }

  // Hold the capture open for the rest of the window.
  const remaining = NETLOG_MS - (Date.now() - startedAt);
  if (remaining > 0) await h.sleep(remaining);

  await defaultSession.netLog.stopLogging();
  await tabSession.netLog.stopLogging();
  const spellAfter = {
    languagesTabSession: tabSession.getSpellCheckerLanguages(),
    userDataEntries: fs.readdirSync(userData),
    dictionaryFiles: fs.existsSync(path.join(userData, 'Dictionaries')) ? fs.readdirSync(path.join(userData, 'Dictionaries')) : [],
  };
  h.record(rows, 'spellcheck state before / after', { before: spellBefore, after: spellAfter }, null);

  const dictRequests = fixture.requests.filter((r) => r.path.startsWith('/dict/'));
  h.record(rows, 'dictionary requests that reached the local fixture server', dictRequests.map((r) => ({ path: r.path, method: r.method })), mode === 'dict' ? dictRequests.length > 0 : null);

  // The cmdline capture is flushed on exit; give the two session captures to the parser now.
  const summaries = {
    defaultSession: summarizeNetLog(netlogFile('default-session')),
    tabSession: summarizeNetLog(netlogFile('tab-session')),
  };
  for (const [name, s] of Object.entries(summaries)) {
    h.record(rows, `netlog ${name}: non-local hosts`, { events: s.eventCount, localHosts: s.localHosts, external: s.externalHosts.map(({ host, count, events, sampleUrl }) => ({ host, count, events, sampleUrl })) }, null);
  }

  h.writeResults(__dirname, `network-${mode}`, { mode, visibilityState, spellBefore, languageSwitch, spellAfter, summaries, dictRequests, rows });
  lib.releaseWindow(win);
  h.destroyView(win, view);
  win.close();
  await fixture.close();
  app.exit(0);
});

// After exit the cmdline netlog is complete; the runner script (or you) can parse it with netlog-hosts.js.
