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

Build on **Electron**, tracking the newest stable major. That's 44.7.2 today (Chromium 152). 45.0.0 is scheduled for 2026-10-20, but it was still in beta when Phase 1 began on 2026-10-16, so Milestone 1.1 pins 44.7.2. The move to 45 follows the upgrade policy below.

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
