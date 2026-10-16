# ADR-0002: Trust zones, window composition and web policy

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | D1 (platform) and D8 (single window) |
| **Validated by** | Spikes S1 (view lifecycle), S3 (unload behavior), [S7](../spikes/s7-web-compatibility.md) (web compatibility: defaults confirmed; PDF, popup, download and user-agent details added). S7's manual checks are pending |
| **Details** | Technical assessment §3.1–3.3, §3.7, Part 6 |

## Context

A browser loads hostile content by definition. Electron's defaults assume trusted content:

- With no handlers installed, it **grants every permission request and check**.
- It hands unknown URL schemes to the OS **with no prompt**.
- It **auto-selects the first client certificate**.
- It **blocks no popups**.
- A view's web contents is **never destroyed automatically**.

## Decision

1. **Four trust zones.**

   | Zone | Trust | Notes |
   |---|---|---|
   | Main process | Trusted | Authoritative and privileged |
   | Data worker | Trusted | Owns SQLite |
   | Shell UI renderer | Trusted code, untrusted data | `app://shell` on its own session; sandboxed; CSP; a preload exposing a typed command API |
   | Tab renderers | Untrusted | Partition `persist:browsing`; sandboxed; context isolation; **no preload and no IPC channel** |

2. **Window composition.**
   - One `BaseWindow`, with the native frame in the MVP. The shell view sits underneath, and only the selected tab's view is attached above it.
   - Hidden live tabs are detached; unloaded tabs have no view at all.
   - **Destruction is explicit:** `removeChildView` → `webContents.close()` → drop every reference. Spike S1 measured why. Detaching alone frees nothing. Dropping references releases a renderer only if garbage collection happens to run: after two forced collections, 1 of 4 renderers was still alive.

3. **Internal pages** are rendered by the shell in the content area: the new-tab page, settings, memory, error, crashed-tab and "sleeping" pages. Their `veltriva://` identifiers are never loaded into any web contents, and web pages can't navigate to `veltriva:` or `app:` URLs.

4. **Every unsafe Electron default is overridden:**
   - **Permissions.** Request and check handlers on every session. They work from an allow-list, so anything unlisted is denied. Every session also gets a device-permission handler, a display-media handler and a Bluetooth chooser listener.
   - **External protocols.** `openExternal` is routed through a protocol guard: dangerous schemes are always blocked, and everything else needs a user gesture plus a prompt.
   - **Client certificates.** `select-client-certificate` is always intercepted; the MVP declines.
   - **Popups.** A popup policy approximates Chromium's user-activation rule from main-process input events. Spike S7 confirmed that neither the window-open handler nor `openExternal` carries any gesture signal. Popups are routed by `disposition`:
     - `foreground-tab` and `background-tab` become tabs we create and load ourselves. Ctrl, middle and Shift clicks arrive with no pre-created contents, and left-click `target=_blank` has no opener anyway.
     - `new-window` with features becomes a popup window that hosts `options.webContents`. That keeps `window.opener` and `postMessage` working, even cross-site.
     - The window-open handler also checks the URL scheme, because `window.open('custom:…')` arrives there rather than as `openExternal`.
     - **Popup host windows need lifecycle code.** When the popup page calls `window.close()`, its contents are destroyed but the host `BaseWindow` stays open, so we close it. When the host window closes, we close its contents.
     - **Known gap:** hosted popups don't inherit `safeDialogs`, and overriding the options doesn't fix it.
   - **Every web contents.** A global `web-contents-created` guard assigns each one a role (shell, tab, popup or DevTools) and attaches the matching navigation and window-open policy. The tab navigation guard must allow the built-in PDF viewer's frame, `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`, in `will-frame-navigate`. Blocking it renders PDFs blank (S7). That ID is re-verified on every Electron upgrade, and an E2E test checks that a PDF page actually renders.
   - **Downloads.**
     - A `will-download` handler on every session always calls `setSavePath`.
     - Chromium writes Mark-of-the-Web as `ZoneId=3` with `HostUrl=about:internet`, with no source or referrer recorded.
     - Downloads belong to the session and survive closing, discarding or crashing their tab, so no tab-level protection is needed.
     - Dangerous file types need confirmation, and nothing is auto-opened.
   - **User agent.** Set `app.userAgentFallback` before `ready`, stripping `Electron/x.y.z` and the app-name token. That cleans every session, worker and request header. Client-hint brands never mention Electron, but navigations carry no `Sec-CH-UA*` headers, which may matter for Google sign-in (a pending manual check).
   - **Spellcheck dictionaries.** `setSpellCheckerDictionaryDownloadURL` points at dictionaries we host. On the test machine, en-US used Windows' own spellchecker; other languages default to `redirector.gvt1.com`.

5. **Hardening.**
   - `app.enableSandbox()`.
   - Hardened `webPreferences`: `sandbox`, `contextIsolation`, `webSecurity`, `safeDialogs`, no Node.
   - Electron fuses as listed in ADR-0007.
   - The shell's CSP is sent as a response header by the `app://` handler.

6. **As built in M1.2** (refinements; the code is in `src/main/shell` and `src/main/web`):
   - **The shell session** is the in-memory partition `veltriva-shell`. It keeps no web storage, and clearing browsing data can't touch it.
   - **`app://`** is registered as privileged with `standard`, `secure` and `supportFetchAPI` only: no CORS, no service workers, no CSP bypass. Its handler exists only on the shell session.
     - The handler serves only `GET`.
     - It decodes the path and rejects NUL bytes, backslashes and colons (drive letters and NTFS streams).
     - It resolves the path under the renderer folder and requires the result to stay inside it.
     - It serves only an allow-list of file types.
     - Every response carries the §6.2 CSP and `X-Content-Type-Options: nosniff`.
   - **Development** loads the Vite dev server instead. Its URL must be plain `http` on loopback.
     - A dev CSP is injected through the shell session's `webRequest`. It adds `'unsafe-inline'` for scripts and styles and the dev server's WebSocket.
     - Production builds contain none of this, because `import.meta.env.DEV` is a build-time constant.
   - **Roles.** Every web contents is `shell`, `tab`, `popup`, `devtools` or `unknown`.
     - Creation code claims the role while it constructs the view. Electron 44 emits `web-contents-created` synchronously inside the constructor, and `createViewWithRole` verifies the claim every time.
     - Unclaimed contents of type `remote` are DevTools. Anything else is `unknown` and can't navigate at all.
   - **Tab navigation** also allows `about:srcdoc` in subframes, which is how `<iframe srcdoc>` loads. `data:` and `blob:` frames are denied for now; M1.3 re-checks web compatibility on real sites.
   - **The guard cancels in `will-frame-navigate`.** Electron emits it before `will-navigate`, so a cancelled navigation never reaches `will-navigate`.
   - **The session baseline is deny-all until M1.4.** It covers:
     - permission request and check handlers;
     - the device and display-media handlers (display media is denied with `callback(null)`);
     - Bluetooth pairing;
     - the HID, serial, USB and Bluetooth choosers;
     - downloads, which are cancelled;
     - client certificates, which are declined;
     - HTTP and proxy authentication, which are cancelled.

     Spellcheck dictionary downloads point at the loopback discard port, `http://127.0.0.1:9/`, until we host dictionaries; Windows' own spellchecker still works. The shell itself has spellcheck off.
   - **The user agent** loses everything Electron puts between `(KHTML, like Gecko)` and `Chrome/`, plus the `Electron/x.y.z` token, through `app.userAgentFallback` before `ready`. Electron's app token is the product name without spaces, so for us it's `VeltrivaBrowser/0.0.0`.

## Consequences

- **Positive:** web pages can't reach any Veltriva API by construction, and privileged UI never lives inside the tab system.
- **Positive:** page signals come only from main-process events (`input-event`, `before-mouse-event`, media and fullscreen events) and two small isolated-world scripts. One is an on-demand probe; the other is a passive trusted-input tracker installed after each navigation (ADR-0003). Neither has any channel to main, and page scripts can't see them.
- **Negative:** more code than a typical Electron app. We own the permission broker, protocol guard, popup policy and download manager.
- **Negative:** the shell renderer still parses untrusted data (titles, URLs, favicons). Re-encoding favicons is a planned hardening step (threat T5).

## Alternatives considered

- **Internal pages as privileged tabs** (like `chrome://` pages). Rejected: it puts privileged code inside the untrusted tab system.
- **A preload in web pages** to collect activity and form signals. Rejected: main-process events and isolated-world probes provide those signals without a bridge.
- **Overlay rendering** is decided separately, in ADR-0006.
