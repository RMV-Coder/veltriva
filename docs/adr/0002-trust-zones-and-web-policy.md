# ADR-0002: Trust zones, window composition and web policy

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | D1 (platform) and D8 (single window) |
| **Validated by** | Spikes S1 (view lifecycle), S3 (unload behavior), S7 (web compatibility) |
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
   - **Destruction is explicit:** `removeChildView` → `webContents.close()` → drop every reference.

3. **Internal pages** are rendered by the shell in the content area: the new-tab page, settings, memory, error, crashed-tab and "sleeping" pages. Their `veltriva://` identifiers are never loaded into any web contents, and web pages can't navigate to `veltriva:` or `app:` URLs.

4. **Every unsafe Electron default is overridden:**
   - **Permissions.** Request and check handlers on every session. They work from an allow-list, so anything unlisted is denied. Every session also gets a device-permission handler, a display-media handler and a Bluetooth chooser listener.
   - **External protocols.** `openExternal` is routed through a protocol guard: dangerous schemes are always blocked, and everything else needs a user gesture plus a prompt.
   - **Client certificates.** `select-client-certificate` is always intercepted; the MVP declines.
   - **Popups.** A popup policy approximates Chromium's user-activation rule from main-process input events.
   - **Every web contents.** A global `web-contents-created` guard assigns each one a role (shell, tab, popup or DevTools) and attaches the matching navigation and window-open policy.
   - **Downloads.** Saved to explicit paths, and Chromium writes Mark-of-the-Web. Dangerous file types need confirmation, and nothing is auto-opened.

5. **Hardening.**
   - `app.enableSandbox()`.
   - Hardened `webPreferences`: `sandbox`, `contextIsolation`, `webSecurity`, `safeDialogs`, no Node.
   - Electron fuses as listed in ADR-0007.
   - The shell's CSP is sent as a response header by the `app://` handler.

## Consequences

- **Positive:** web pages can't reach any Veltriva API by construction, and privileged UI never lives inside the tab system.
- **Positive:** page signals come only from main-process events (`input-event`, `before-mouse-event`, media and fullscreen events) and short, on-demand isolated-world probes.
- **Negative:** more code than a typical Electron app. We own the permission broker, protocol guard, popup policy and download manager.
- **Negative:** the shell renderer still parses untrusted data (titles, URLs, favicons). Re-encoding favicons is a planned hardening step (threat T5).

## Alternatives considered

- **Internal pages as privileged tabs** (like `chrome://` pages). Rejected: it puts privileged code inside the untrusted tab system.
- **A preload in web pages** to collect activity and form signals. Rejected: main-process events and isolated-world probes provide those signals without a bridge.
- **Overlay rendering** is decided separately, in ADR-0006.
