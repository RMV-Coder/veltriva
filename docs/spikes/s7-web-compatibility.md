# S7: Web compatibility and Electron defaults

| | |
|---|---|
| **Question** | Does stock Electron behave well enough on the web (user agent, PDF, downloads, popups, external protocols, background traffic) for the policies in assessment §3.7 and §6.4–6.6 and ADR-0002, and what must change? |
| **Status** | Automated checks done; manual checks pending (Google sign-in, OAuth popup, YouTube, real-world PDF) |
| **Result** | The unsafe defaults behave as the assessment says. Four findings contradict its wording: a "http(s) and about:blank only" subframe guard **breaks the PDF viewer**, Mark-of-the-Web carries only `ZoneId=3` plus `HostUrl=about:internet`, hosted popups lose `safeDialogs`, and Windows already spellchecks en-US natively. Downloads survive closing the tab |
| **Environment** | Windows 11 10.0.26200, Electron 44.7.2 (Chromium 152), Node 24.13 |
| **Code** | [spikes/s7-web-compat](../../spikes/s7-web-compat) |

## What we tested

Everything ran unattended against local servers on `127.0.0.1`. The `*.test` host names are mapped to loopback by the shared harness, so `a.test` and `b.test` are different sites on one server. The windows used for rendering checks were small (at most 800×520) and kept always on top so occlusion tracking could not blank them. Each result file records `visibilityState`; it was `visible` every time. Each scenario got a fresh profile under `spikes/s7-web-compat/user-data/<name>/`.

| # | Check | Script |
|---|---|---|
| 1 | User agent, client hints, and what a page, a worker and a server each see, before and after cleaning the UA | `ua.js` |
| 2 | Built-in PDF viewer in a `TAB_PREFS` view, including an ADR-0002-shaped navigation guard | `pdf.js` |
| 3 | Downloads, Mark-of-the-Web, and closing the originating tab mid-download | `downloads.js`, `downloads-https.js` |
| 4 | Popups: handler without a gesture, `createWindow` hosting, real clicks | `popups.js` |
| 5 | External protocols, with deny-all permission handlers installed first | `protocols.js` |
| 6 | Background traffic (netlog) and spellcheck dictionaries | `network.js`, `netlog-hosts.js` |
| 7 | A hand-run browser for the manual checks, plus an automated smoke test of it | `manual-browser.js`, `manual-browser-selftest.js` |

Safety measures: check 5 installs the deny handlers on both sessions before any web contents exists, and a `tasklist` diff is the evidence that nothing launched. The `dl.example.com` name used in check 3 is mapped to loopback with proxies disabled, so nothing leaves the machine. The "default URL" half of check 6 blocks name resolution for every non-loopback host, so Electron's attempt is visible in the netlog but sends no packet. The one run that lets Electron talk to the network freely (`network.js default`) only loads local pages; any external host it shows is Electron's own.

## Results

"Observed" means a script measured it. "Inferred" is reasoning from observations or documentation.

| Check | Observed | Verdict |
|---|---|---|
| **UA defaults** | `webContents.getUserAgent()`, `app.userAgentFallback`, `session.getUserAgent()`, `navigator.userAgent`, the UA seen inside a dedicated worker, and the HTTP `User-Agent` header are one identical string: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36`. With `app.setName('Veltriva')` it also carries `Veltriva/<version>` before `Chrome/` (an unnamed dev run has no app token) | Confirmed: `Electron/x.y.z` leaks everywhere |
| **Client hints, defaults** | `navigator.userAgentData.brands` is `Not?A_Brand 24` and `Chromium 152`, **never "Electron"** (and no "Google Chrome"). `getHighEntropyValues` gives `platform Windows`, `platformVersion 19.0.0`, `architecture x86`, `bitness 64`, full version list `Chromium 152.0.7977.149`. The server saw `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` on `fetch()` but **on no navigation request**, and the extra hints requested through `Accept-CH` were never sent | Surprise: client hints do not leak Electron, but they are incomplete |
| **Cleaned UA, via `app.userAgentFallback` (before ready)** | `…Chrome/152.0.7977.149 Safari/537.36` in the app, the page, the worker and the header. A walk over every observed value found zero "electron" or app-name substrings (`hits: []`) | Works; global, covers every session |
| **Cleaned UA, via `session.setUserAgent`** | Same clean result for the page, worker and header of that session, but `app.userAgentFallback` stays dirty, so other sessions still send the Electron token | Works, but per session only |
| **Other JS-visible Electron traces** | `window.chrome` is an object; `process`, `require`, `module`, `Buffer` are undefined; `navigator.webdriver` is false; `navigator.plugins` lists the standard five PDF-viewer plugin names; `navigator.vendor` is `Google Inc.`. H.264, VP9, AV1, AAC and Opus all report support; **Widevine is unavailable** (`NotSupportedError`) | Nothing Electron-specific remains once the UA is cleaned |
| **PDF viewer** | `did-finish-load` fires. The frame tree has the PDF URL, a `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html` frame and an embedded frame, in three processes. `capturePage()` of the PDF shows the viewer **and** the white document page (55.6% pure-white pixels, versus 0% for `about:blank`; the screenshot was inspected by eye). The tab navigates normally afterwards | Works |
| **PDF with a guard allowing only http(s) and `about:blank`** | `will-frame-navigate` fires for a `chrome-extension://mhjf…/<uuid>` subframe, and blocking it leaves the viewer toolbar but **no document page** (0.01% white). Allowing just the `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/` prefix restores the page (55.0% white) | Gap in §6.4 as written. Pixel "non-blank" alone would have passed the broken case |
| **Mark-of-the-Web** | 11 downloads (`sample.txt` and `fake-installer.exe`; page link from `127.0.0.1`, `a.test` and a public-looking name; `webContents.downloadURL`; `session.downloadURL`; and over HTTPS) all got a `Zone.Identifier` stream containing `[ZoneTransfer]`, `ZoneId=3`, `HostUrl=about:internet`. **No `ReferrerUrl` and no real source URL**, in any variant. `.exe` is treated like `.txt` | Partly as expected: zone mark present, origin detail absent |
| **Antivirus hand-off (Attachment Execution Services)** | Not observable from a script | Not verified |
| **No `setSavePath`** | Not run on purpose (a save dialog would block). Electron's own typings say: if the path is not set, "Electron will use the original routine to determine the save path; this usually prompts a save dialog" | Documented, matches the assessment |
| **Tab closed mid-download** | A 5 s, 10 KB streaming download kept going and finished in all four variants: tab closed with `removeChildView` then `webContents.close()` (link-started and `webContents.downloadURL`-started), the renderer killed with `forcefullyCrashRenderer()`, and a session-level download beside an unrelated closed tab. State stayed `progressing`, then `completed`; 10 240 of 10 240 bytes on disk; the server never saw a hang-up | No cancel protection needed |
| **`will-download` details** | Fires on the session. The third argument (web contents) is absent for `session.downloadURL`. `item.getInitiatorOrigin()` returns the page origin for page-started downloads and `""` for session-started ones | Useful for attributing downloads |
| **Popup handler, no gesture** | `window.open` during page load (before `dom-ready`; `navigator.userActivation.hasBeenActive` was `false`) still invoked `setWindowOpenHandler`. `details` has only `url`, `frameName`, `features`, `disposition` (`new-window`), `referrer`. No gesture flag, no opener id, no initiator | Confirmed: no popup blocker, and the handler cannot tell |
| **Hosted popup (`createWindow`)** | `options.webContents` was provided (option keys: `webContents`, `show`, `width`, `height`, `webPreferences`). The child saw `window.opener`, and its `postMessage` reached the opener's `window.__messages`. Cross-site (`a.test` opening `b.test`) also kept the opener, in a different OS process | Works for OAuth-style popups |
| **Hosted popup preferences** | `sandbox`, `contextIsolation`, `nodeIntegration` (off) and `webSecurity` carried over, with the same session. **`safeDialogs` did not** (`false` against the opener's `true`), and returning `overrideBrowserWindowOptions.webPreferences.safeDialogs = true` did not fix it | Gap |
| **`window.close()` in a hosted popup** | The popup's web contents is destroyed; the host `BaseWindow` stays open and empty | We must close the host window ourselves |
| **Clicks on `target=_blank`** | Left click: `disposition foreground-tab`, `options.webContents` provided, but `window.opener` is `null` (noopener by default). Ctrl+click and middle click: `background-tab`, **no pre-created contents**. Shift+click: `new-window`, no pre-created contents. A returned fresh `WebContents` is not navigated by Electron (URL stayed empty). A button calling `window.open(url, name, 'width=…')`: `new-window`, pre-created contents, opener present | Matches §3.7; adds the noopener and disposition detail |
| **External protocols** | With deny handlers, `mailto:test@example.com` and `veltriva-spike-unregistered:hello` each raised a permission request `openExternal` with `details` keys `externalURL`, `requestingUrl`, `isMainFrame`. It was raised **with and without** a user gesture, and the details do not say which. An iframe navigation was reported with `isMainFrame: true` and the top page as `requestingUrl`. `window.open('custom:…')` went to the window-open handler (`foreground-tab`) instead. The page stayed put and the process list showed no new process | Confirmed; nothing launched |
| **Background traffic, 20 s, fresh profile** | No external HTTP(S) request. The only non-local names were `wpad` (12 DNS-resolver events, Windows proxy auto-detect) and a UDP connect to `2001:4860:4860::8888` (Chromium's IPv6 reachability probe). Same result in the two session netlogs and in a whole-process `--log-net-log` capture | §6.6 mostly holds, with two caveats |
| **Spellcheck, en-US** | A misspelled word was flagged (`teh`, with suggestions `the, ten, tea, tee`). **No dictionary was downloaded**: no `Dictionaries` folder, no CDN host in the netlog | Surprise: no download on this machine (inferred: Windows' own spellchecker) |
| **Spellcheck, languages Windows lacks (`fr`, `de`)** | Default: Electron requests `https://redirector.gvt1.com/edgedl/chrome/dict/fr-fr-3-0.bdic` (observed as an attempt with name resolution blocked). With `setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:<port>/dict/')`, the requests `GET /dict/fr-fr-3-0.bdic` and `GET /dict/de-de-3-0.bdic` reached the local server (404 is fine) | Confirmed: the override works |
| **Manual browser self-test** | Cleaned UA, notifications and geolocation denied, and a `window.open` popup kept `window.opener` and delivered `postMessage` | Ready for the manual checks |

## What this means for the design

**Keep**

- **Clean the UA with `app.userAgentFallback` before `ready`** (§3.7). It is global, so the shell, workers and `net` requests all agree. Also call `session.setUserAgent` on the tab partition as a belt-and-braces measure. The regex must strip both `Electron/x.y.z` and the `<app>/<version>` token; unit-test it and check the app token on a **packaged** build, where it exists.
- **`createWindow` popups** (§3.7, ADR-0002). Opener, `postMessage` and cross-site popups all work. Classify by `disposition`: `foreground-tab` and `background-tab` become tabs we create (the left-click contents has no opener anyway), `new-window` with features becomes a popup window hosting `options.webContents`.
- **Gesture tracking built from main-process input events.** The window-open handler and the `openExternal` request carry no gesture signal, so ADR-0002's design is necessary, not optional.
- **The protocol guard** on `openExternal`, with `externalURL` parsed and validated before any `shell.openExternal`. Add a scheme check to the window-open handler too, because `window.open('custom:…')` arrives there and not as `openExternal`.
- **Chromium writes Mark-of-the-Web**, and the dangerous-type confirmation stays on top of it.
- **Self-hosting spellcheck dictionaries** (§6.6), applied to every session before any language is set.

**Change**

1. **§6.4 navigation rules: allow the PDF viewer.** "Tab: `http(s)`, `about:blank`" is wrong for subframes. Allow `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/` in `will-frame-navigate` (and test that `will-navigate` and `will-redirect` need nothing similar). Add a PDF case to the E2E suite that checks the white page area, not just "non-blank". Treat the extension ID as a value to re-verify on each Electron upgrade (inferred stable; observed on Chromium 152 only).
2. **§3.7 and §6.4 Downloads: describe MOTW accurately.** The stream is `ZoneId=3` and `HostUrl=about:internet`. It marks the file as from the Internet zone, which is what Protected View and SmartScreen key on (inferred), but it records no source or referrer. Do not promise provenance. If provenance matters later, writing our own richer stream, or calling Attachment Execution Services, is a post-MVP option. The AV hand-off remains unverified.
3. **§3.7 Downloads: always call `setSavePath`.** Register the `will-download` handler on every session that can start one (tab partition, default session, popups share the tab session), including `session.downloadURL`.
4. **No download-cancel protection is needed** for closing, discarding or crashing a tab: downloads belong to the session, not the tab. Key the downloads list by session, not by tab, and use `getInitiatorOrigin()` for attribution. Quitting the app with active downloads is untested (see below).
5. **ADR-0002 hardening list: `safeDialogs` is not inherited by hosted popups.** `sandbox`, `contextIsolation`, `nodeIntegration` and `webSecurity` are, but dialog-spam protection is lost in popups, and the obvious fix did not work. Either accept this for popup windows (they are separate, closable windows with a visible URL bar) or find another way; list it as a known gap.
6. **Popup host windows need lifecycle code:** close the host `BaseWindow` when the popup's web contents is destroyed (`window.close()` in an OAuth popup), and close the web contents when the host window closes.
7. **§3.7 Google row: reword.** Electron's client-hint brands never contained "Electron", so there is nothing to scrub there. What differs from Chrome is that the brand list has no "Google Chrome", navigation requests carry no `Sec-CH-UA*`, and `Accept-CH` is ignored. Whether Google's sign-in cares is still the manual check; the per-site override stays a documented last resort.
8. **§6.6 privacy posture: add two disclosures.** The `wpad` lookup (Windows proxy auto-detect) and the IPv6 reachability probe happen on a bare Electron. Neither is an HTTP request. Dropping WPAD means forcing direct connections, which breaks proxy users, so document it instead.
9. **§1.2 and §6.6 spellcheck wording.** "Downloaded on first use from a Chromium CDN" is true only for languages Windows does not provide. en-US spellchecked with no download. Self-hosting is still right, because the first non-OS language (we tried French and German) goes to `redirector.gvt1.com`.

## Manual checks (not yet run)

I did not visit any of these sites or enter any credentials. You run them. Start the hand-run browser from `C:/GitHub/Veltriva/spikes`:

```bash
./node_modules/.bin/electron s7-web-compat/manual-browser.js <url>
```

Its terminal prints the cleaned UA, every denied permission, every popup it hosts, and fullscreen enter/leave. Ctrl+Shift+I opens DevTools for the tab. The profile persists in `spikes/s7-web-compat/user-data/manual/`. Use a throwaway account if you can, and **delete that folder afterwards**.

**M1. Google sign-in**

1. Run it with `https://accounts.google.com`.
2. In DevTools, run `navigator.userAgent` and confirm there is no `Electron`.
3. Enter the throwaway account's email, press Next, enter the password, press Next.
4. Record: does it show "Couldn't sign you in: This browser or app may not be secure"? Does it reach the account page, a 2-step prompt, or something else? Copy any error text.
5. If it is blocked, stop there; do not try workarounds yet. The result decides whether the per-site UA override in §3.7 is needed.

**M2. "Sign in with GitHub" popup flow**

1. Open a site whose "Sign in with GitHub" opens a **small popup window** instead of redirecting the whole page (Firebase `signInWithPopup` demos are a common example). Click it.
2. Record: does a 520×600 window open with the URL in its title, and does the terminal log `popup opened … (pre-created contents: true …)`?
3. Authorize with a throwaway GitHub account. Record: does the popup close itself and does the original page become signed in (that proves `window.opener` and `postMessage` survive a real cross-site flow)?
4. If the page stays signed out, check the popup's DevTools for `window.opener` and look for a `Cross-Origin-Opener-Policy` header on the callback page; that would be the site's choice, not ours.
5. Also try a normal in-page login on `https://github.com/login` and note any difference.

**M3. YouTube**

1. Open any normal public video at `https://www.youtube.com`.
2. Record: does it play with sound, can you select 1080p, and does seeking work?
3. Click the fullscreen button. Expect the window to go fullscreen with the toolbar hidden and the terminal to log `page entered HTML fullscreen`. Press Esc: it should return and log `page left HTML fullscreen`.
4. Note any "browser not supported" banner. Paid or DRM content will not play (Widevine is unavailable); that is expected and out of scope.

**M4. A real-world PDF**

1. Open a PDF hosted on the web that you trust, one with many pages and embedded fonts or images (for example a long academic paper or a manual).
2. Record: does it render, can you scroll, zoom, select and copy text, and open the thumbnail sidebar?
3. Press the viewer's print button and cancel the dialog. Press its download button: with no download handler in the hand-run browser a native Save As dialog should appear (documented default); cancel it.
4. Note render time for a 50+ page file and anything that looks off.

## Caveats and follow-ups

- **One machine.** Windows 11 Home, an unpackaged `electron.exe` run. The assessment asks for MOTW on a real build, so repeat check 3 on the packaged installer (ADR-0007), with Defender active, and look for any scan or SmartScreen prompt when running the saved `.exe`.
- **HTTPS MOTW check** used a throwaway self-signed certificate accepted by a test-only `setCertificateVerifyProc`. It is likely to match a real HTTPS download, but is not proven.
- **Not tested:** quitting the app with an active download; `setSavePath` omitted (cited, not run); non-Windows-supported spellcheck languages beyond `fr` and `de`; whether `ReferrerUrl` ever appears (none of 11 variants produced it).
- **Spellcheck result depends on the Windows language packs installed.** On a machine without en-US support the default would download. The `fr-blocked` and `dict` runs show the behaviour for such languages.
- **Network capture is 20 seconds** on a fresh profile with no update checker, no crash reporter and no external pages. It does not prove silence over hours. Re-run with a longer capture once the app has an updater.
- **Popup tests use synthetic input** (`sendInputEvent`). Chromium treated the clicks as real (the popups opened and dispositions were reported), but this is not the same as an OS-level click.
- **The UA regex** was exercised on a dev run, which has no app-name token unless `--named` is used. Re-test on a packaged build.
- **Client hints:** the missing `Sec-CH-UA*` on navigations is observed, and its cause (probably no client-hints delegate in the embedder) is inferred. Whether any site penalises it is unknown until M1 and M3 run.
- **A `window-management` permission check** was logged three times during the popup tests (inferred: `window.open` with features). Our deny result did not stop the popups. Watch it if a future change turns that check into a hard block.
- **`manual-browser.js` fullscreen handling and the Ctrl+Shift+I shortcut are untested.** The self-test covers the UA, permissions and popups only, because exercising fullscreen would take over the real screen. M3 is its first real run.
- **Cleanup:** scenario profiles, downloads, netlogs and the throwaway certificate live in `spikes/s7-web-compat/user-data/`, `downloads/` and `netlog-*.json`, all gitignored.

## How to reproduce

From Git Bash, with deps already installed (no `npm install`):

```bash
cd C:/GitHub/Veltriva/spikes
timeout 180 ./node_modules/.bin/electron s7-web-compat/ua.js default            # also: fallback, session, and each with --named
timeout 180 ./node_modules/.bin/electron s7-web-compat/pdf.js                    # S7_DUMP_DIR=<dir> saves PNG captures
timeout 180 ./node_modules/.bin/electron s7-web-compat/downloads.js
timeout 180 ./node_modules/.bin/electron s7-web-compat/downloads-https.js        # needs openssl on PATH (Git for Windows has it)
timeout 180 ./node_modules/.bin/electron s7-web-compat/popups.js
timeout 180 ./node_modules/.bin/electron s7-web-compat/protocols.js
timeout 180 ./node_modules/.bin/electron s7-web-compat/network.js default        # also: dict, fr-blocked (about 25 s each)
timeout 180 ./node_modules/.bin/electron s7-web-compat/manual-browser-selftest.js
node s7-web-compat/netlog-hosts.js s7-web-compat/netlog-default-cmdline.json     # re-parse a netlog
```

Each script exits on its own with code 0 (1 if a check fails) and writes a small JSON file to `spikes/s7-web-compat/results/`. `network.js default` lets Electron reach the network as it normally would, but only local pages are loaded. The hand-run browser is separate; see the manual checks above.
