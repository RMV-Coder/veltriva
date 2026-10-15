'use strict';
// Automated smoke test of manual-browser.js (the user still runs the real checks by hand).
// Starts the local fixture server, boots the manual browser on popup.html with a throwaway profile, and checks:
// cleaned UA, deny-by-default permissions, and that a window.open popup keeps window.opener.
// Touches only local fixtures; never launches anything external.

process.env.S7_MANUAL_PROFILE = 'manual-selftest';

const { app, BaseWindow, webContents } = require('electron');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');

(async () => {
  const fixture = await startFixtureServer();
  process.argv[2] = fixture.url('/popup.html', 'a.test'); // manual-browser.js reads its start URL from argv[2]
  require('./manual-browser');

  await app.whenReady();
  const rows = [];
  await h.sleep(2500);
  BaseWindow.getAllWindows().forEach((w) => w.setAlwaysOnTop(true));
  const tab = webContents.getAllWebContents().find((w) => w.getURL().includes('/popup.html'));
  if (!tab) throw new Error('tab not found');

  const ua = await tab.executeJavaScript('navigator.userAgent');
  h.record(rows, 'manual browser: navigator.userAgent has no Electron token', ua, !/electron/i.test(ua));

  const perms = await tab.executeJavaScript(`(async () => ({
    notification: await Notification.requestPermission(),
    geolocation: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve('denied code ' + e.code), { timeout: 4000 })),
  }))()`, true);
  h.record(rows, 'manual browser: notifications and geolocation are denied', perms, perms.notification !== 'granted' && String(perms.geolocation).startsWith('denied'));

  const before = webContents.getAllWebContents().length;
  tab.focus();
  const rect = await tab.executeJavaScript(`(() => { const r = document.getElementById('open').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  tab.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
  tab.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  tab.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await h.sleep(2000);
  const popup = webContents.getAllWebContents().find((w) => w.getURL().includes('/popup-child.html'));
  const popupInfo = popup && (await popup.executeJavaScript('JSON.stringify({ hasOpener: Boolean(window.opener), text: document.getElementById("status").textContent })').then(JSON.parse));
  const messages = await tab.executeJavaScript('window.__messages');
  h.record(rows, 'manual browser: window.open popup keeps window.opener and postMessage arrives', { contentsBefore: before, popupInfo, messages }, Boolean(popupInfo?.hasOpener) && messages.length === 1);

  h.writeResults(__dirname, 'manual-browser-selftest', { rows });
  await fixture.close();
  app.exit(rows.every((r) => r.pass !== false) ? 0 : 1);
})().catch((err) => { console.error(err); app.exit(1); });
