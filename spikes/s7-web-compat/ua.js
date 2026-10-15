'use strict';
// S7 check 1: user agent and client hints.
//   electron s7-web-compat/ua.js default    Electron's defaults
//   electron s7-web-compat/ua.js fallback   cleaned UA via app.userAgentFallback (before ready)
//   electron s7-web-compat/ua.js session    cleaned UA via session.setUserAgent (after ready)
// Add --named to call app.setName('Veltriva') first, so the UA also carries an app-name token like a packaged app.
// Records what the app, the page's JS and a server (our own, on 127.0.0.1) each see.

const { app, session } = require('electron');
const h = require('../shared/harness');
const lib = require('./lib');

const mode = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'default';
const named = process.argv.includes('--named');
const tag = named ? `${mode}-named` : mode;
lib.setup(`ua-${tag}`, { failSafeMs: 90_000 });
if (named) app.setName('Veltriva');

const defaultUA = app.userAgentFallback;
const cleanedUA = lib.cleanUserAgent(defaultUA);
if (mode === 'fallback') app.userAgentFallback = cleanedUA; // must run before ready

// Executed in the page (main world). Collects everything a site could look at.
const PAGE_PROBE = `(async () => {
  const uad = navigator.userAgentData;
  let high = null;
  try {
    high = uad ? await uad.getHighEntropyValues(['brands', 'fullVersionList', 'platform', 'platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion', 'wow64']) : null;
  } catch (e) { high = 'error: ' + e.message; }
  let worker = null;
  try {
    const src = 'postMessage({ ua: navigator.userAgent, brands: navigator.userAgentData && navigator.userAgentData.brands })';
    const w = new Worker(URL.createObjectURL(new Blob([src])));
    worker = await new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); setTimeout(() => resolve('timeout'), 3000); });
    w.terminate();
  } catch (e) { worker = 'error: ' + e.message; }
  // Media/DRM support matters for the manual YouTube check.
  const v = document.createElement('video');
  let widevine;
  try {
    await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]);
    widevine = 'available';
  } catch (e) { widevine = 'unavailable: ' + e.name; }
  const media = {
    canPlayType: {
      h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
      vp9: v.canPlayType('video/webm; codecs="vp9"'),
      av1: v.canPlayType('video/mp4; codecs="av01.0.05M.08"'),
      aac: v.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
      opus: v.canPlayType('audio/webm; codecs="opus"'),
    },
    mse: {
      h264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'),
      vp9: MediaSource.isTypeSupported('video/webm; codecs="vp9"'),
      av1: MediaSource.isTypeSupported('video/mp4; codecs="av01.0.05M.08"'),
    },
    widevine,
  };
  let fetched = null;
  try { fetched = await (await fetch('/echo.json')).json(); } catch (e) { fetched = 'error: ' + e.message; }
  return {
    userAgent: navigator.userAgent,
    appVersion: navigator.appVersion,
    vendor: navigator.vendor,
    platform: navigator.platform,
    webdriver: navigator.webdriver,
    languages: navigator.languages,
    brands: uad ? uad.brands : null,
    mobile: uad ? uad.mobile : null,
    uadPlatform: uad ? uad.platform : null,
    highEntropy: high,
    workerView: worker,
    globals: {
      chrome: typeof window.chrome,
      process: typeof window.process,
      require: typeof window.require,
      module: typeof window.module,
      Buffer: typeof window.Buffer,
      electron: typeof window.electron,
    },
    media,
    pluginNames: Array.from(navigator.plugins).map((p) => p.name),
    fetchedHeaders: fetched,
  };
})()`;

app.whenReady().then(async () => {
  const rows = [];
  const server = await lib.startHeaderServer();
  const ses = session.fromPartition(h.TAB_PREFS.partition);
  if (mode === 'session') ses.setUserAgent(cleanedUA);

  const beforeSend = [];
  ses.webRequest.onBeforeSendHeaders({ urls: [`${server.url('/')}*`] }, (details, cb) => {
    const hdr = details.requestHeaders;
    beforeSend.push({ url: details.url.replace(server.url(''), ''), ua: hdr['User-Agent'], chKeys: Object.keys(hdr).filter((k) => /^sec-ch/i.test(k)) });
    cb({ requestHeaders: hdr });
  });

  const win = h.createWindow({ width: 800, height: 500 });
  const view = h.createTabView(win);
  const wc = view.webContents;
  await wc.loadURL('about:blank');
  const visibilityState = await lib.stabilizeWindow(win, wc);

  await wc.loadURL(server.url('/echo'));
  const firstNav = lib.pickUaHeaders(server.requests.find((r) => r.path === '/echo').headers);
  await wc.loadURL(server.url('/echo')); // second navigation: Accept-CH is now honoured
  const page = await wc.executeJavaScript(PAGE_PROBE, true);
  const echoNavs = server.requests.filter((r) => r.path === '/echo');
  const secondNav = lib.pickUaHeaders(echoNavs[1].headers);
  const fetchHeaders = lib.pickUaHeaders(server.requests.filter((r) => r.path === '/echo.json').at(-1).headers);

  const app_ = {
    mode: tag,
    visibilityState,
    appName: app.getName(),
    appVersion: app.getVersion(),
    'app.userAgentFallback': app.userAgentFallback,
    'webContents.getUserAgent()': wc.getUserAgent(),
    'session.getUserAgent()': ses.getUserAgent(),
  };
  // Walk every observed value and list where "electron" (or the app name) still appears.
  const hits = [];
  const walk = (value, where) => {
    if (typeof value === 'string') {
      if (/electron/i.test(value)) hits.push(`electron @ ${where}`);
      if (named && /veltriva/i.test(value)) hits.push(`app-name @ ${where}`);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`);
    }
  };
  walk({ page: { ...page, globals: undefined }, firstNav, secondNav, fetchHeaders, webContentsUA: wc.getUserAgent() }, '');
  const leftovers = { hits, globals: page.globals };
  const uaVisibleEverywhere = new Set([wc.getUserAgent(), page.userAgent, page.workerView?.ua, firstNav['user-agent'], secondNav['user-agent'], fetchHeaders['user-agent']]);

  h.record(rows, 'app-side UA values', app_, null);
  h.record(rows, 'page-visible values (navigator + userAgentData + worker + globals)', page, null);
  h.record(rows, 'server-received UA / Sec-CH headers, 1st navigation', firstNav, null);
  h.record(rows, 'server-received headers, 2nd navigation (after Accept-CH)', secondNav, null);
  h.record(rows, 'server-received headers, fetch() from page', fetchHeaders, null);
  h.record(rows, 'webRequest.onBeforeSendHeaders view', beforeSend.slice(0, 4), null);
  h.record(rows, 'UA identical in app / JS / worker / HTTP', { distinct: uaVisibleEverywhere.size }, uaVisibleEverywhere.size === 1);
  h.record(rows, 'any "electron" substring left anywhere (UA, brands, hints, globals)', leftovers, null);

  h.writeResults(__dirname, `ua-${tag}`, { mode: tag, defaultUA, cleanedUA, visibilityState, rows });
  lib.releaseWindow(win);
  h.destroyView(win, view);
  win.close();
  await server.close();
  app.exit(0);
});
