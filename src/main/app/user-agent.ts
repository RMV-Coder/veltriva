// A user agent without Electron's fingerprints (ADR-0002 §4, spike S7). Electron's default is
//   ... (KHTML, like Gecko) VeltrivaBrowser/0.0.0 Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36
// i.e. an app token (the product name without spaces, plus the version) before `Chrome/`, and an
// `Electron/x.y.z` token. Both go; what's left is the Chrome user agent for the same Chromium.
// Apply it to `app.userAgentFallback` before `ready`, which covers every session and worker.

const APP_TOKENS_BEFORE_CHROME = /\(KHTML, like Gecko\) .*? (?=Chrome\/)/;
const ELECTRON_TOKEN = / Electron\/\S+/g;

export function cleanUserAgent(userAgent: string): string {
  return userAgent
    .replace(APP_TOKENS_BEFORE_CHROME, '(KHTML, like Gecko) ')
    .replace(ELECTRON_TOKEN, '');
}
