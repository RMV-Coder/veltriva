# ADR-0001: Build on Electron with `BaseWindow` + `WebContentsView`

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | D1 |
| **Validated by** | Spikes S1 (view lifecycle) and S7 (web compatibility) |
| **Details** | Technical assessment §1.2, §2.1, §2.5 |

## Context

Veltriva is a Windows-first browser for people who keep dozens of tabs open. It has to:

- embed many Chromium pages in one window;
- control their lifecycle (unload, restore);
- be built and maintained by one developer whose strongest skills are TypeScript and React.

A future macOS or Linux port should keep the same engine.

## Decision

Build on **Electron**, tracking the newest stable major. 45.0.0 was still in beta when Phase 1 began on 2026-10-16, so Milestone 1.1 pinned 44.7.2 (Chromium 152). 45.0.0 went stable on 2026-10-21, and Phase 4 Step 0 moved to it under the upgrade policy below, inside its 4 weeks.

**Pin history.** The version is pinned exactly (`.npmrc` has `save-exact`, and install scripts never run implicitly), and every downloaded Electron zip is checked against the release's `SHASUMS256.txt`.

- **44.7.2** (Milestone 1.1, 2026-10-16): Chromium 152.0.7977.149, Node 24.21.0.
- **44.9.0** (Phase 1 wrap-up, 2026-10-17): Chromium 152.0.7977.167, Node 24.22.0. This skipped 44.8.0, which shipped the day before with the Chromium update and backported Chromium and V8 fixes. `electron-v44.9.0-win32-x64.zip` has SHA-256 `88e08039d0ef359bab9f674e8051fa103bd8628ea7c5a5e1daaa610a8a0c6931`, matching `SHASUMS256.txt` and the npm package's `checksums.json`. 44.9.0's electron/electron#55048 changes how windows opened from links are created; ADR-0002 item 9 records what was re-measured and pinned. 45.0.0 stable had not shipped yet (45.0.0-beta.5), so the 4-week clock for 45 hasn't started.
- **44.9.1** (Phase 2 Step 0, 2026-10-20): Chromium 152.0.7977.167, Node 24.22.0 and V8 15.2.124.43, all unchanged from 44.9.0; `NODE_MODULE_VERSION` 149, N-API 10. `electron-v44.9.1-win32-x64.zip` has SHA-256 `41bd7900bd42d0f49110a81617876137041fbbf473466920248ddb076349ef91`, matching `SHASUMS256.txt` from the GitHub release and the npm package's `checksums.json`. The published release notes are empty, so the six commits from v44.9.0 were read instead. Only electron/electron#55127 changes runtime behavior. It adds nine public-key hashes that Chrome distributes through CRLSet, which Electron doesn't consume, to Chromium's compiled-in SPKI blocklist. It also applies the same list to Node's TLS in the main and utility processes. A chain through one of those keys now fails as `ERR_CERT_REVOKED`, which Veltriva's certificate-error page already covers (error codes −200 to −299), and Veltriva's main process makes no Node TLS connections: favicons use `session.fetch`, which goes through Chromium's network stack. The other commits are build-only (PGO profiles; Node's GN arguments moved from a patch into `build/args/all.gn`, with the same values), Node test re-enables and docs. 45.0.0 stable still hadn't shipped (45.0.0-beta.5).
- **45.0.0** (Phase 4 Step 0, 2026-10-23; stable since 2026-10-21, the newest 45.x and npm `latest`):
  - **Versions:** Chromium 156.0.8078.48, Node 24.22.0 (unchanged) and V8 15.6.75.19. `NODE_MODULE_VERSION` moved from 149 to 150; N-API stays 10.
  - **The zip:** `electron-v45.0.0-win32-x64.zip` has SHA-256 `ae53887a23bb640369c93dbd38c408a2af5c0deb86f2fa76c6c244cb444b7f47`, matching `SHASUMS256.txt` from the GitHub release and the npm package's `checksums.json`.
  - **better-sqlite3 13.0.3** is N-API, so nothing is rebuilt. Its pinned binary still matches, and it loads and runs FTS5 in Electron's main thread and in a `worker_threads` worker.
  - **What the release notes change for Veltriva.** The 45.0.0 notes and `docs/breaking-changes.md` were read for everything Veltriva uses. 44.9.2 and 44.9.3 added only backported Chromium fixes, so every "also in 44" item was already in 44.9.1. Only these items are 45's own:
    - **Sandboxed preloads lose Buffer, setImmediate, and the events, timers and url modules** (#54048). The shell preload uses only `contextBridge` and `ipcRenderer`, and its bundle needs none of them.
    - **Screen capture is reported as `display-capture`, not `media`** (#52824). The broker allows neither display capture nor `display-capture`, so screen sharing stays refused. Before 45, a screen request reached the broker as `media` with a `video` media type.
    - **ASAR file descriptors work only through `fs`** (#52833). Nothing in Veltriva opens an archived file by descriptor. The data worker's script loads from app.asar, and the native binary is unpacked.
    - **A `window.open()` child whose sandbox differs from its opener's gets its own process** (#52472). Every Veltriva page is sandboxed, so nothing changes. The popup specs, which pin electron/electron#55048's order (ADR-0002 item 9), all pass.
    - **`executeJavaScript(…, true)` now gives browser-side user activation** (#54959). The popup and external-protocol specs that use it as their "no gesture" case still pass: the gesture rule reads main's `input-event`, never Chromium's activation.
    - **The synchronous `safeStorage` methods are deprecated** (removed in 46). Veltriva doesn't use `safeStorage`.
  - **Fixes that touch Veltriva:**
    - `process.nextTick` in protocol and webRequest handlers (#54301);
    - a crash closing detached DevTools (#54538);
    - native-call cost on `BaseWindow`, `WebContents` and `View` (#54359).
  - **Unchanged by 45:**
    - **Both popup gaps of ADR-0002 item 9 remain.** A click in a cross-site frame still reaches no `input-event`, and a popup's refused `requestFullscreen()` still never settles. Their `test.fail` specs still fail as expected.
  - **Build tools:** electron-vite 6.0.0 has no table entry for 45, so it targets `chrome152` and `node24.18`. Both are older than 45's engines, so the output stays compatible. electron-builder 26.17.0 packages it.
  - **Checks:** typecheck, lint and format; unit 7,352/7,352; full E2E 427/428. The one failure was a test-harness artifact, now fixed (ADR-0008 item 4: attaching Playwright clears a page's selection). Lifecycle, `package:dir` and a packaged launch on an existing database are recorded in the Phase 4 plan.

Every web page is a `WebContentsView` inside a single `BaseWindow`. We don't use `BrowserView` (deprecated since Electron 30), `<webview>`, or iframes for browsing.

**Upgrade policy:**

- Move to each new Electron major within 4 weeks of its release, after native-module and E2E checks pass on a branch.
- Once Veltriva has public users, ship each Electron security patch release within 7 days.

## Consequences

**Positive**

- TypeScript end to end, and Chromium on every OS.
- The lifecycle hooks this product depends on exist:
  - exporting and restoring navigation history (34.2+);
  - intercepting `beforeunload` on close;
  - media and capture events;
  - per-process metrics;
  - isolated-world scripting;
  - the DevTools Protocol.

**Negative (accepted)**

- Electron is Chromium's engine *without* Chrome's browser layer. We build tabs, history, permission UI, popup policy, downloads and discarding ourselves.
- We own the Chromium patch cadence, through the upgrade policy above and the update path in ADR-0007.
- Electron's defaults are unsafe for a browser. With no handlers installed it grants every permission, launches external apps without prompts, auto-selects client certificates, and has no popup blocker. ADR-0002 overrides each one.
- Stock Electron has no Widevine DRM and no Safe Browsing. Both are documented as known limitations.
- The installer is large.

## Alternatives considered

- **Tauri 2 + WebView2.** Microsoft patches the runtime, and WebView2 has real suspend APIs. Rejected because:
  - multi-webview still needs Tauri's `unstable` flag;
  - every WebView2-specific feature needs Rust and COM interop;
  - macOS and Linux builds would run on WebKit, not Chromium.
- **CEF (C++ or CefSharp).** Maximum control. Rejected for build weight and language fit.
- **A Chrome extension.** Users wouldn't need to switch browsers. Rejected because it can't own the tab strip, the address bar or the lifecycle model. We keep `src/core` free of Electron imports so a companion extension stays possible.
