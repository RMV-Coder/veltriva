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
   - **As built (v0.1.0):** nine pages (`src/core/url/internal-pages.ts`): `new-tab`, `network-error`, `certificate-error`, `client-certificate`, `crashed`, `diagnostics`, `settings`, `welcome` and `about`. Five can be typed as `veltriva://…`: newtab, diagnostics, settings, welcome, about. The memory became the palette (an overlay, ADR-0006), and Sleeping and the Archive live in the sidebar, so neither needed a page.

4. **Every unsafe Electron default is overridden:**
   - **Permissions.** Request and check handlers on every session. They work from an allow-list, so anything unlisted is denied. Every session also gets a device-permission handler, a display-media handler and a Bluetooth chooser listener.
   - **External protocols.** `openExternal` is routed through a protocol guard: dangerous schemes are always blocked, and everything else needs a user gesture plus a prompt.
   - **Client certificates.** `select-client-certificate` is always intercepted; the MVP declines.
   - **Popups.** A popup policy approximates Chromium's user-activation rule from main-process input events. Spike S7 confirmed that neither the window-open handler nor `openExternal` carries any gesture signal. Popups are routed by `disposition`:
     - `foreground-tab` and `background-tab` become tabs we create and load ourselves. Ctrl, middle and Shift clicks have no opener, and neither does a left-click `target=_blank`. (Up to Electron 44.8 those three clicks also arrived with no pre-created contents; since 44.9.0 they get one, like every `window.open`. See item 9.)
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
   - **Spellcheck dictionaries.** `setSpellCheckerDictionaryDownloadURL` points at dictionaries we host. On the test machine, en-US used Windows' own spellchecker; other languages default to `redirector.gvt1.com`. (As built: no host exists, so the URL is the loopback discard port; see item 6's notes below.)

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
   - **Tab navigation** also allows `about:srcdoc` in subframes, which is how `<iframe srcdoc>` loads. `data:` and `blob:` frames were denied in M1.2; M1.3a allows them (item 7).
   - **The guard cancels in `will-frame-navigate`.** Electron emits it before `will-navigate`, so a cancelled navigation never reaches `will-navigate`.
   - **The session baseline is deny-all until M1.4.** M1.4a replaces the browsing session's permission handlers with the broker (item 9). It covers:
     - permission request and check handlers;
     - the device and display-media handlers (display media is denied with `callback(null)`);
     - Bluetooth pairing;
     - the HID, serial, USB and Bluetooth choosers;
     - downloads, which are cancelled;
     - client certificates, which are declined;
     - HTTP and proxy authentication, which are cancelled.

     Spellcheck dictionary downloads point at the loopback discard port, `http://127.0.0.1:9/`, until we host dictionaries; Windows' own spellchecker still works. The shell itself has spellcheck off.
   - **The user agent** loses everything Electron puts between `(KHTML, like Gecko)` and `Chrome/`, plus the `Electron/x.y.z` token, through `app.userAgentFallback` before `ready`. Electron's app token is the product name without spaces, so for us it's `VeltrivaBrowser/0.0.0`.

7. **As built in M1.3a** (the code is in `src/main/tabs`, `src/main/navigation`, `src/main/web` and `src/core/url`):
   - **Frames and generated documents.** Tab navigation allows `data:` and `blob:` documents in subframes, as Chrome does. A tab may also show a `blob:` document in place when the blob's origin is a web origin (`blob:https://…`), so the address bar names the site that made it.
     - Top-level `data:` stays blocked for renderer-initiated navigations, as in Chrome: the address bar would show attacker-chosen text.
     - So does an opaque-origin blob (`blob:null/…`, made by a sandboxed or `data:` frame), which would also put content on screen under no site's name.
   - **Permissions.** The browsing session grants `clipboard-sanitized-write` (a site's copy button) without a prompt, as Chrome does. Reading the clipboard stays denied. `fullscreen` follows in M1.3b, with its origin notice (threat T6). Everything else stays denied until the M1.4 broker.
   - **The address bar changes only when a document commits or fails.** Electron 44 emits `did-start-navigation` before `will-frame-navigate`, even for a navigation the guard then cancels (measured). Showing the URL at that point would let a page flash any address. TabManager takes the URL only from `did-navigate`, `did-navigate-in-page` and `did-fail-load`.
     - That holds for typed navigations too: a load that is stopped or aborted leaves the tab's address, page and view as they were. While it loads, the shell keeps showing the text the user submitted. An E2E test found the first version setting the URL when the load started.
     - Chromium itself refuses a renderer-initiated top-level `data:` navigation and an opaque `blob:null/…` one before Electron's `will-frame-navigate` fires (E2E, M1.3a). The guard's rules for them stay as a second line.
   - **Credentials are stripped and the user is told** (threat T7). A committed URL with `user:pass@` shows without them, with a warning beside the security state. A typed address with credentials is loaded without them, and the warning appears with the document it commits, so a pasted `https://paypal.com@evil.example` can't pass for paypal.com. An E2E test found the typed case missing.
   - **Favicons (threat T5).**
     - Main fetches the page's first http(s) or `data:` candidate through the browsing session, with a 10 s timeout and a 64 KB cap enforced while streaming.
     - It accepts only raster formats it recognizes by their magic bytes: PNG, ICO, GIF, JPEG, WebP and BMP. SVG is never accepted.
     - The shell receives a `data:` URL that main built itself, and the IPC contract re-checks its form.
     - Main never decodes the image: only the sandboxed shell renderer does. Stored favicons (M2.2b) keep the same sniffed bytes and their type, and the data worker sniffs them again (ADR-0004 item 10). ESLint bans `nativeImage` in `src/main`. Re-encoding with a memory-safe decoder outside main would go further; that's left for later.
   - **The omnibox opens only local drive paths.** A typed Windows path or `file:` URL opens only as `file:///C:/…`. Network paths (`\\server\share`, `file://server/share`, `file:////server/share`) become searches: Windows would connect over SMB and may send the user's NTLM credentials to that server.
   - **Other apps' schemes do nothing yet.** Until the M1.4 protocol guard can ask, typed `zoommtg:`, `mailto:` and similar input is neither opened nor searched for. A search would send `user:pass@host`, which reads exactly like `xmpp:user@host`, to the search engine.
   - **No default application menu.** Its accelerators would act on the browser itself: Ctrl+W would close the window and Ctrl+R would reload the shell. Browser shortcuts arrive in M1.3b, through `before-input-event`.

8. **As built in M1.3b** (the code is in `src/main/windows`, `src/main/input`, `src/main/menus` and `src/core/url/local-network.ts`):
   - **HTML fullscreen (threat T6).**
     - The browsing session grants `fullscreen`. Chromium still requires a user gesture, and pointer and keyboard lock stay denied.
     - The selected tab fills the window. For 4 s a notice names the page's origin (`originLabel`: the host in punycode, from the committed URL) and says how to leave.
     - The shell draws the notice, raised above the page (ADR-0006 A′). Main raises it only after the shell reports that it shows nothing but the notice, with a 500 ms fallback so the notice can't be skipped.
     - A page can't trap the user. Chromium handles Esc before the page or `before-input-event` see it (measured on Electron 44). Main can also end fullscreen, on F11, on Esc in the shell, or on a tab switch. It does so through an isolated world, so a page that replaced `document.exitFullscreen` doesn't stop it. `window.setFullScreen(false)` doesn't end a page's fullscreen (measured).
     - Only the selected tab may be fullscreen. A tab switch, a close, a crash or a failed load ends it.
     - When it ends, main also takes the window out of fullscreen, unless the user chose fullscreen with F11. Chromium does that itself when a page leaves fullscreen, but not when the page's web contents is destroyed while fullscreen (closing the tab). The E2E suite found the window left fullscreen around the browser UI.
   - **Favicons on local hosts.** Main fetches page-declared favicons as browser-initiated requests, which skip Chromium's local-network-access check, so those requests could reach this machine and the local network.
     - Main refuses favicon URLs on loopback, private and link-local addresses, and on local-only names (single labels, `.local`, `.internal`, `.home.arpa`, `.lan`).
     - The exception is a page whose own host is in the same class.
     - The check parses hosts the way the URL parser does, so `127.1`, hex and decimal IPv4, and IPv4-mapped and NAT64 IPv6 are caught.
     - DNS rebinding remains (threat T5). M6.1 added redirect and resolved-address checks (item 15).
   - **Context-menu actions** work on page-controlled data:
     - "Open link/image in new tab" appears, and runs, only for a URL the tab navigation policy would allow. It is checked again when the action runs, so `javascript:`, `data:` and `file:` links get no such item.
     - Copy actions write the clipboard only on the user's click.
     - "Search for" builds its URL through the validated search template.
     - Page text in a menu label loses controls and bidi formatting, is cut short, and cannot create a Windows access key (`&`).
   - **DevTools for pages** open detached on F12 or "Inspect". The shell's DevTools stay dev-only: Ctrl+Shift+I in `npm run dev` builds.

9. **As built in M1.4a** (the code is in `src/core/permissions`, `src/core/url/external-protocol.ts`, `src/core/input/user-activation.ts`, `src/main/permissions`, `src/main/external`, `src/main/popups`, `src/main/prompts` and `src/main/windows/popup-windows.ts`). Two probes on Electron 44.7.2 settled the design; their findings are marked *measured*.
   - **The permission broker** replaces the deny-all request and check handlers on the browsing session. It works from an allow-list:
     - **Granted without asking:** `clipboard-sanitized-write`, and `fullscreen` in tabs (with its origin notice).
     - **Asked in the toolbar:** camera and microphone (`media`, by `mediaTypes`), `geolocation`, `notifications` and `clipboard-read`. Decisions are remembered per origin, in memory until Phase 2's `permission_decisions` table. Three dismissals of the same question count as a block for the session, as Chrome's embargo does.
     - **Denied:** everything else. That includes the device choosers and `display-capture`, and **pointer lock**: a hidden, captured pointer helps a page pass itself off as the desktop (threat T6), and Veltriva has no notice for it yet.
     - **The check handler** answers from the same rules and decisions, so `navigator.permissions.query` and `Notification.permission` agree with what a request would get.
     - **Embedded pages from other sites never prompt.** Their request arrives with `isMainFrame: false` and the frame's own URL (*measured*). A prompt would appear in the name of the site in the address bar, so they are denied without asking, like requests from insecure origins (a prompt needs `https:`, or `http:` on loopback).
     - **Popup windows never prompt** and get no fullscreen: they have no trusted place for a question or a notice.
   - **Prompts** live in a strip under the toolbar, outside the page area (threat T6), one at a time per tab. They name the site with `originLabel`, from main's record of the URL. A new document, a crash, a failed load or closing the tab dismisses them. A late answer to an old prompt is ignored.
   - **The external-protocol guard** is the only way to open another app.
     - **Always blocked:** `ms-msdt`, `search-ms`, `search`, `ms-officecmd`, `ms-cxh`, `ms-cxh-full`, `ms-appinstaller`, `vbscript`, `javascript`, `jar` and `file`, plus Chrome's own never-launched list (`shell`, `hcp`, `ms-help`, `res` and others).
     - **Everything else** needs a trusted gesture in that page within 5 s, then the user's yes in the toolbar ("site wants to open *App*", with the app name from `app.getApplicationNameForProtocol`, cleaned). A per-site "always allow" skips the question, never the gesture. A page with no site (`about:blank`, `data:`, `file:`) can't ask at all.
     - **Typed input** counts as a gesture; its prompt names no site and offers no "always allow".
     - **The launch** gets only the parsed URL, percent-encoded like Chrome's (spaces, quotes, controls, non-ASCII) and capped at 2046 characters, as Electron's quoted ShellExecute call allows. Test builds record launches instead of making them.
     - **Where requests come from:** a page's navigation to another app's URL fires `will-frame-navigate`, or `will-redirect` for a redirect, with the right frame (*measured*). The guard cancels it there and asks the protocol guard, for the top frame only. Once it is cancelled, no `openExternal` request follows (*measured*). `openExternal` itself is refused as a backstop: S7 found it reports an iframe as the main frame. `window.open('custom:…')` reaches the window-open handler (S7, *measured* again).
   - **Popups.**
     - **The gesture rule.** A popup or new tab needs a trusted mouse-down, tap or key press in that page within the last 5 s, and uses it up: one gesture, one popup. Main sees input through `input-event`, which never fires for a shortcut cancelled in `before-input-event` (*measured*), so browser shortcuts don't count. Without a gesture, the popup is recorded and the toolbar offers "Open pop-up", which opens it as a tab.
     - **Routing.** `foreground-tab` and `background-tab` become TabManager tabs after the opener. A `new-window` with size features, or a form post to a new tab, becomes a popup window. Shift+click, and anything a popup window opens, becomes a tab.
     - **Roles.** The window-open handler claims `popup` just before it returns `allow`. Electron then emits `web-contents-created` for the pre-created contents and calls `createWindow`, all in the same task (*measured*). `createWindow` checks the role, and on a mismatch closes the contents and throws. A claim no contents took is dropped on the next turn of the event loop.
     - **Re-checked on Electron 44.9.0** (Phase 1 wrap-up). electron/electron#55048 removed Electron's separate path for windows opened from links: the internal `-new-window` event, which built a `BrowserWindow` in the default session with default preferences and no pre-created contents. Now Chromium's `OpenURLFromTab` runs the window-open handler from `-will-add-new-contents`, creates the contents in the opener's session with the handler's preferences, and hands it to `-add-new-contents`. So `createWindow` always receives `options.webContents`. A probe with every request allowed (Ctrl, middle and Shift click, left-click `target=_blank`, sized `window.open` with and without `noopener`, form post to `target=_blank`) *measured*, on 44.7.2 and 44.9.0:
       - **44.7.2:** the three link clicks had no pre-created contents, `createWindow` ran before `web-contents-created`, and the window landed in the default session. Everything else had pre-created contents in the opener's session, in the order handler, `web-contents-created`, `createWindow`, in one task.
       - **44.9.0:** all seven have pre-created contents in the opener's session, in that same order, in one task. Only the sized `window.open` without `noopener` keeps an opener.
       - **What it means for Veltriva:** nothing in the routing changes. The three link clicks become tabs, so the handler denies them and Chromium creates no contents (E2E checks that each gesture adds exactly one web contents, the new tab's). `createWindow` no longer has a fallback for a missing pre-created contents, which no longer happens and which Electron would reject anyway (it requires the returned contents to be the one it passed). It throws instead, like a missed claim. E2E pins, on every popup-window route, that the hosted contents is Chromium's (the only new web contents are the popup and its address bar), that it has the `popup` role, that nothing is left `unknown`, and that it shares the opener's session. A popup also outlives its opener tab being closed, not only navigated.
     - **Popup windows** are centered on the browser, whatever position the page asked for. A trusted, read-only address bar sits above the page: `app://shell/popup-bar.html` on the shell's session, with no preload or IPC. Main pushes it a JSON string literal of the committed URL's display text, starting at `about:blank`. So a page that writes into a blank popup can't pass it off as another site. The window title is the site.
     - **Lifecycle.** A popup window closes when its page calls `window.close()` or its renderer dies, and closing the window closes the page. Popups outlive their opener, as in Chrome. Ctrl+W closes a popup window.
     - **Known gap (S7):** hosted popups don't inherit `safeDialogs`, and overriding the options doesn't help. A popup window is a separate, closable window with its own address bar.
     - **Known limitation (found by E2E):** a click inside an embedded page from another site (an out-of-process frame) never reaches `input-event` on the tab's web contents, so a popup that page opens is blocked. The strip still offers "Open pop-up", but as a tab without an opener. Seeing frame input is a follow-up. Still true on Electron 45.0.0 (Phase 4 Step 0), where the popup specs again matched every measurement above, for links opened into tabs and popup windows alike.
     - **Accepted as in Chrome:** `window.open('javascript:…')` opens a blank popup. Blink hands main `about:blank`, and the address bar says `about:blank`.
     - **Known limitation:** a popup page's `requestFullscreen()` is refused, and nothing goes fullscreen, but its promise never settles. Chrome rejects it.

10. **As built in M1.4b** (the code is in `src/core/downloads`, `src/core/net`, `src/main/downloads` and `src/main/auth`):
   - **Downloads.** The browsing session hands every `will-download` to the download manager. It is the only session a page can download from: tabs and popup windows use it, the shell has its own session, and DevTools save files without a download. Every other session, the default one included, keeps the baseline's cancel, so the surface stays small (M1.4b review).
     - **Where it saves:** it always calls `setSavePath` synchronously, so no save dialog ever shows. The file goes to the Downloads folder, under a name the manager chooses:
       - controls and bidi overrides removed, so a right-to-left override can't make an `.exe` pass for a PDF;
       - path separators and forbidden characters replaced;
       - Windows device names prefixed;
       - trailing dots removed, the length capped with the extension kept, and the name made unique like Chrome's (`report (1).pdf`). Uniqueness covers files on disk and downloads in progress.
     - **Dangerous types** are saved as `name.ext.unconfirmed`, which Windows won't run.
       - **Which types:** every type whose Windows danger level is `DANGEROUS` or `ALLOW_ON_USER_GESTURE` in Chromium's `components/safe_browsing/content/resources/download_file_types.asciipb` (`version_id` 69, read 2026-10-17; 168 types).
       - **Plus:** the §6.4 disk images (`iso`, `vhd`, `vhdx`) and `cab`, `psd1`, `appinstaller` and `searchconnector-ms`. That makes 175.
       - **Stricter than Chrome:** Veltriva asks for Keep on all of them, even where Chrome waives the warning after a gesture (`xml`, `eml`, `cer`).
       - **Trailing dots and spaces are ignored**, as Windows ignores them (`Setup.PIF.` is a `.pif`).
       - **Why it matters:** Open hands the file to Windows, so a type missing from the list would run without Keep (M1.4b review). They are renamed on Keep, deleted on Discard, and can't be opened before Keep.
     - **Open and Show in folder** happen only on the user's click, on main's own record of the path, through `shell.openPath` and `shell.showItemInFolder`. The shell sees ids, never paths. Nothing is opened automatically.
     - **Downloads belong to the session,** so they outlive their tab (S7). The list is in memory, newest 100.
     - **Context menus** offer "Save link to Downloads" and "Save image to Downloads", for URLs a tab may open, plus `data:` images. The brief's "Save … as…" labels would promise a dialog the MVP doesn't have.
     - **Alt+click on a link** is downloaded by Blink itself. The download reaches `will-download` directly, not the window-open handler, so the 5 s gesture window doesn't apply (measured by E2E). That is safe: Blink ignores Alt on a synthetic click, so only a real click downloads. The window-open handler's `save-to-disk` route, with the gesture rule, is a backstop.
     - **Show in folder,** like Open, waits for Keep on a dangerous file (found by E2E).
     - **Mark-of-the-Web** comes from Chromium, as S7 measured. From a page on `127.0.0.1` the E2E suite saw `ZoneId=3` with `ReferrerUrl` and `HostUrl` set to the page and file URLs; S7's variants recorded only `HostUrl=about:internet`. It survives Keep's rename.
     - **Test builds** download into the test profile and record Open and Show instead of doing them. They also point Electron's Downloads path there: Chromium creates a temporary file in the Downloads folder during each download, even when the file goes elsewhere (found by E2E).
   - **Certificate errors** keep Electron's default rejection. A failed load with a certificate error (-200 to -299) shows its own page, with no way to proceed.
   - **Client certificates** are always declined. The resulting client-auth failure (-110, -117, -134) shows a page saying the site needs a certificate.
   - **HTTP authentication** asks in the prompt strip, naming the server from main's parse of the URL. The realm is the server's text, cleaned. The credentials go to Chromium once and are never stored or logged.
     - **Who can ask:** only a tab, and only the page's own origin or the origin its main frame is navigating to.
       - A cross-origin image or script can't ask for a password, and neither can a cross-origin iframe's navigation. Chrome lets an iframe ask; Veltriva doesn't (M1.4 brief, decided in the M1.4b review): a password form inside a page from another site is a phishing shape.
       - Chromium flags iframe loads as navigations too, so main tracks each tab's main-frame navigation target itself (`did-start-navigation`, `did-redirect-navigation`). It forgets the target when the frame commits or stops.
     - **Limits:** proxy authentication is cancelled. After three failed tries a server stops getting prompts until a fresh first attempt. An unencrypted connection gets a warning.
11. **Client hints** (after manual check M1; the code is in `src/core/net/client-hints.ts` and `src/main/web/client-hints.ts`). Google's sign-in refused Veltriva ("Couldn't sign you in: This browser or app may not be secure", 2026-10-18, on 44.9.0), as it refuses embedded browsers.
   - **What was different from Chrome** (*measured* on 44.9.0, as S7 found on 44.7.2):
     - A page's own navigation, top-level or in a frame, carries no `Sec-CH-UA*` headers. Chromium adds them to subresources only, because Electron gives it no client-hints delegate.
     - `Accept-CH` is ignored.
     - So every page load says "Chromium 152" in `User-Agent` but carries none of the headers every Chromium 152 sends.
   - **The fix keeps the hints honest** (on its own it wasn't enough; see the retest below). Main adds the missing headers with Chromium's own values, which the shell reads once from `navigator.userAgentData` (validated, and before any web page can be visited). The brands stay what pages see: "Chromium", never "Google Chrome". The user agent stays the cleaned Chromium one (item 4, S7).
     - **Every document request** (top-level or frame) gets each default hint it lacks: `Sec-CH-UA`, `-Mobile`, `-Platform`. They are byte-for-byte what Chromium sends on a `fetch` from the same page (E2E).
     - **An origin that asks with `Accept-CH` on a top-level page** gets the opt-in hints it named on its later requests, subresources included: architecture, bitness, form factors, full version and full version list, model, platform version, WoW64. A frame's `Accept-CH` counts for nothing, and an opt-in is never extended to another origin, as in Chrome.
     - **Opt-ins last until the app quits** (at most 500 origins). Chrome keeps them on disk; that waits for Phase 2.
     - **Only to potentially trustworthy URLs** (https, or http on loopback), and **never replacing a header Chromium set**.
     - **Not done:** `Critical-CH` retries, and delegation to third parties through `Permissions-Policy`. A frame of an opted-in origin gets its hints even if the embedding page's policy would withhold them in Chrome; only the origin that asked receives them.
   - **Retest (2026-10-18, corrected 2026-10-19):** with this fix alone, the user could sign in, but Google still answered the first attempt with "Couldn't sign you in". Its "Try again" button then let the user in, sometimes after a one-time code. An earlier note here said the retest simply passed; it didn't. The client hints stay: they are what Chrome sends.
   - **Then the fallback, a per-site user agent** (assessment §3.7; the user approved it after this retest; the code is in `src/core/net/site-user-agent.ts`, applied by `src/main/web/request-headers.ts`). It does what Min browser has long done (minbrowser/min#868):
     - Requests to `accounts.google.com`, and to no other host, carry **Firefox's user agent** for 64-bit Windows in their `User-Agent` header. That includes the page and its own requests, in tabs and popup windows.
     - **Only that header changes**, as in Min. The client hints and the page's `navigator.userAgent` stay Chromium's. That is inconsistent on purpose: it is the combination known to work, and faking more of Firefox in the page would be deception beyond a user-agent string.
     - **The Firefox version is estimated from the release cadence:** 158 on 2026-10-13, plus one per 4.1 weeks. That keeps it at or just behind the latest release without a list to update (Min's rule).
     - **E2E never contacts Google.** `--host-resolver-rules` maps `accounts.google.com` to a local HTTPS fixture and makes every other name unresolvable.
     - **Retest of the fallback (2026-10-19): passed.** In the packaged build, the user's Google sign-in went straight through, with no warning and no "Try again".

12. **JS dialogs, the file chooser and printing** (Phase 5, M5.0). These were *measured* on Electron 45.0.0, reading the native windows with Windows UI Automation (`docs/plans/mvp-gap-audit.md`).
   - **`alert` and `confirm`** are Electron's own native message boxes.
     - **Modal to the whole window:** the box is owned by the browser window and disables it until answered, so no tab, the toolbar or the sidebar can be used meanwhile.
     - **Background tabs too:** a background tab's dialog appears at once.
     - **No site named:** the box is titled "Veltriva Browser", shows the page's text, and never names the site.
     - **Stopping a page:** from the second dialog on, `safeDialogs` (set on every tab) offers "Prevent this app from creating additional dialogs".
   - **`prompt()`** isn't supported by Electron: it returns `null` at once, with nothing shown.
   - **No hook.** Electron 45 has no API to handle these dialogs itself. A DevTools-protocol session with `Page.enable` gets no `Page.javascriptDialogOpening`, and `Page.handleJavaScriptDialog` answers "No dialog is showing" while the native box is up.
   - **The choice.** Turning dialogs off (`disableDialogs`) would silently break every page's `confirm`. Replacing them would mean a script in every page's own world, which this ADR rules out. So v1.0 keeps the native dialogs, stated as a known limitation (accepted on review, 2026-10-23).
     - **The residual risk** is in the assessment's threat T6. A page's `alert` or `confirm` blocks the window and doesn't name the site. It is bounded: the box takes no input, it never shows a password field, and `safeDialogs` stops a page.
     - **What to watch:** an Electron dialog-handler API. Phase 6 checks each Electron release for one; the change would be small once it exists.
   - **`<input type="file">`** opens Windows' native Open dialog, modal to the window, as in Chrome.
   - **Printing.**
     - **Already worked:** a page's `window.print()` opened Windows' print dialog.
     - **Didn't work:** Ctrl+P did nothing.
     - **M5.0's fix:** Ctrl+P is a page-first accelerator, like Ctrl+F (`src/main/input/page-menu.ts`), and the page's context menu gains "Print…". Both call `webContents.print({ silent: false })`, so the user picks the printer and nothing prints by itself.

13. **Clearing site data and managing stored answers** (Phase 5, M5.2).
   - **Chromium's data for the browsing session** is cleared through `session.clearData` and the cookie store, never the shell's session.
     - **No time range:** Electron's API can't clear cookies, site storage or the cache by time. A time range clears them for all time, and the settings page says so next to each box.
     - **Forgetting a site:** its cookies are matched by their domain on any host of the site. Its storage and cached files are cleared for the site's origins Veltriva knows: those of its deleted pages and tabs, plus the site and `www.`, over http and https. A file it loaded from another server stays cached, and the page says that too.
   - **Stored answers** can be listed, changed and revoked per site: permission decisions (Allow or Block, or removed so the site asks again), an app's "always open", and the client-hint opt-ins. A revoked decision is deleted from `permission_decisions`, along with its dismissal embargo. "Forget this site" can revoke all of the site's own.

14. **The log and what leaves the machine** (Phase 5, M5.3; assessment §6.6).
   - **The log file:** `<profile>/logs/veltriva.log`, one JSON line per warning or error, rotated at 5 MB with 5 files kept (`main/platform/file-logger.ts`).
   - **What it holds:** tab ids and error codes. A field that holds an address (`url`, `address`, or a name ending in `Url`) is written as `[hidden]` unless the user turned **diagnostic logging** on in Settings. Since M6.1, the address-like words of every other string field are hidden too (item 15).
     - The same rule hides it from the console.
     - With logging on, a failed main-frame load and a renderer that died name their page.
   - **"Export diagnostics"** writes what the diagnostics page shows to a JSON file the user chooses (`main/diagnostics/diagnostics-export.ts`).
     - **Never in it:** a page title, or a custom search engine's address (only "custom").
     - **Opt-in:** open tabs' addresses only when the user ticks "Include the addresses of open tabs".
   - **Nothing is sent anywhere.** The export is a file the user saves, and test builds record it instead of showing the dialog.

15. **The security review** (Phase 6, M6.1; [docs/security/security-review.md](../security/security-review.md)). Every item of the assessment's Part 6 and every threat T1–T15 was checked against the code. Four things changed:
   - **Favicon requests follow no redirect blindly** (threat T5). *Measured* on Electron 45: `session.fetch` followed a favicon's 302 to `127.0.0.2`, so a public page could send main into the local network through its own server. With `redirect: 'manual'`, `session.fetch` fails with "Redirect was cancelled" and gives no target (*measured*).
     - **Each hop** is now one `net.request` through the browsing session with `redirect: 'manual'` (`src/main/tabs/favicon-request.ts`), checked again before it is sent, with at most 5 redirects.
     - **What the hop sends:** the session's cookies, as `session.fetch` did (*measured*). An HTTP sign-in request is declined.
   - **Favicon hosts are checked by what they resolve to** (threat T5).
     - **Before each request,** main resolves the host with `session.resolveHost`, the same resolver and cache the request uses. It refuses if any address is local where the page isn't (`addressReach` and `areAddressesWithinReach`, `src/core/url/local-network.ts`). So `127.0.0.1.nip.io` and internal names on public domains are caught.
     - **What a page may reach:** public addresses, the class of its own host as written, and the classes its host resolved to, if none of them is public. An intranet page on a public-looking name may still use icons in its own network; a name with a public and a private record opens nothing local.
     - **Still open:** true DNS rebinding, an answer that changes between this lookup and the request's own. Chromium can't pin a browser-initiated request to an address.
   - **The log scrubs every string field** (item 14, assessment §6.6). While diagnostic logging is off, a word that looks like an address, a path or a host is written as `[hidden]` (`src/main/platform/log-redaction.ts`), in the file and on the console.
     - **Why:** field names weren't enough. An `openExternal` failure's message, Chromium's reasons and a page's scheme are free text.
     - **What stays:** the data worker's method names and the shell's command names, which look like host names, and Chromium's `net::ERR_*` codes.
   - **The packaged binary's fuses are read back** on every `package:dir` (`scripts/check-packaged-app.mjs`, `scripts/fuse-wire.mjs`). The check fails on a fuse it doesn't know, so a new Electron fuse forces a decision.
   - **JS dialogs, re-checked:** no dialog-handler API in Electron 45.0.0, and no 46 build yet. electron/electron#34466 (a `webContents` `dialog` event) was closed unmerged in 2025. The open #54988 covers only the `dialog` module's own boxes and excludes `window.alert()`. Item 12's decision stands.
   - **`app://shell` and `initiatorOrigin`:** §6.2 says the handler checks the request's initiator. Electron's `protocol.handle` gets a standard `Request`, which has none. The handler exists only on the in-memory shell session, which holds only the shell and the popup address bar, so no page reaches it (`shell-protocol.spec.ts`).

## Consequences

- **Positive:** web pages can't reach any Veltriva API by construction, and privileged UI never lives inside the tab system.
- **Positive:** page signals come only from main-process events (`input-event`, `before-mouse-event`, media and fullscreen events) and two small isolated-world scripts. One is an on-demand probe; the other is a passive trusted-input tracker installed after each navigation (ADR-0003). Neither has any channel to main, and page scripts can't see them.
- **Negative:** more code than a typical Electron app. We own the permission broker, protocol guard, popup policy and download manager.
- **Negative:** the shell renderer still parses untrusted data (titles, URLs, favicons). Main sanitizes titles, rebuilds the address text from the parsed URL, and passes favicons only as validated raster `data:` URLs (item 7). Re-encoding favicons remains a further hardening step (threat T5).

## Alternatives considered

- **Internal pages as privileged tabs** (like `chrome://` pages). Rejected: it puts privileged code inside the untrusted tab system.
- **A preload in web pages** to collect activity and form signals. Rejected: main-process events and isolated-world probes provide those signals without a bridge.
- **Overlay rendering** is decided separately, in ADR-0006.
