# Security review (Phase 6, M6.1)

**Scope:** the code at 20a9e8f, the end of Phase 5, plus M6.1's own changes, on Electron 45.0.0 (Chromium 156.0.8078.48). Every item of the assessment's Part 6 and every threat T1–T15 was checked against the code as built. Where reading the code couldn't settle it, the behavior was **measured** on Electron 45.0.0, with a probe script or an E2E test.

**Status vocabulary:**
- **Holds:** the code does what Part 6 says. The evidence names the code and the test that pins it.
- **Holds, as built:** it holds, but differently from Part 6's wording; the difference is stated.
- **Fixed in M6.1:** it didn't hold, and M6.1 fixed it.
- **Residual:** a stated, accepted risk.
- **Open:** a follow-up, with the milestone that owns it.

## What M6.1 found and fixed

1. **A favicon redirect could send main into the local network (T5).** This was the review's one real hole.
   - **The design:** main fetches page-declared favicons itself. Since M1.3b it refused a favicon URL on a local host for a public page.
   - **The hole:** the request went through `session.fetch`, which follows redirects. *Measured:* a favicon URL that answered 302 to `http://127.0.0.2:…/target` reached the target. So any public page could make main send a GET to its router or to a service on this machine, by declaring a favicon on its own server that redirects there.
   - **The fix:** main now follows no redirect blindly. Each hop is a new request that passes every check again, with at most 5 redirects (`src/main/tabs/favicons.ts`).
   - **Why not `session.fetch`:** with `redirect: 'manual'` it fails with "Redirect was cancelled" and gives no target (*measured*). So the hop is one `net.request` through the browsing session with `redirect: 'manual'` (`src/main/tabs/favicon-request.ts`).
     - It sends cookies as `session.fetch` did (*measured*: both send the session's cookies).
     - It declines HTTP authentication, so a favicon never asks for a password.
   - **Tests:**
     - **Unit:** `favicons.test.ts` covers redirects to loopback, private, metadata, local-name, public-name-for-loopback and `file:` targets, relative redirects and the redirect limit.
     - **E2E:** `tests/e2e/favicon-network.spec.ts`. The fixture server doubles as the browsing session's proxy, so a page can sit on a "public" host (`pub.test`, mapped to a never-routed TEST-NET-3 address) without leaving the machine.
     - **Negative control:** the same spec, run against the old `session.fetch` wiring, failed its two refusal tests. The request to this machine was made in both. With the fix they pass.
2. **A public name that resolves to a local address was trusted (T5).** The check classified names as written, so a name such as `127.0.0.1.nip.io`, or an internal name on a public domain, passed as public.
   - **The fix:** before each request, main resolves the host with the browsing session's own resolver (`session.resolveHost`, the same resolver and cache the request then uses).
     - **Refused:** any resolved address that is local where the page isn't (`addressReach`, `areAddressesWithinReach` in `src/core/url/local-network.ts`).
     - **Allowed:** a page whose own host resolves only to private addresses (an intranet wiki on a public-looking name) may still use icons in its network.
     - **Still public only:** a page with a public record gets nothing local, even with a private record beside it.
     - **No request:** a name that doesn't resolve.
   - **Tests:** unit tests in `local-network.test.ts` and `favicons.test.ts`; E2E in `favicon-network.spec.ts`, where `loop.test` maps to 127.0.0.1 and gets no request.
   - **What stays open (residual):** true DNS rebinding. That is an answer that changes between main's lookup and the request's own lookup, which a TTL-0 record makes possible. Chromium offers no way to pin a browser-initiated request to an address. See T5.
3. **Addresses could reach the log through free-text fields (§6.6).** Redaction was by field name only: `url`, `address` and `*Url`. But protocol-guard logs `message: error.message` from `shell.openExternal`, and other string fields come from outside our code: Chromium's reasons, a page-supplied scheme, the data worker's detail.
   - **The fix:** while diagnostic logging is off, every string field is now scrubbed word by word (`src/main/platform/log-redaction.ts`). The console redactor does the same.
   - **What it hides:** a word that looks like an address, a path or a host, each replaced with `[hidden]`:
     - a scheme with something after it: `https:`, `mailto:`, `file:`, `javascript:`, drive paths;
     - anything with `/`, `\` or `@`;
     - IPv4 and IPv6, with ports and zones;
     - dotted names in any script or punycode, which also catches downloaded file names.
   - **What it keeps:** our own data-worker methods and shell commands (`session.save`, which looks like a host name), and Chromium's `net::ERR_*` names.
   - **Tests:** `log-redaction.test.ts` and `file-logger.test.ts`.
     - error messages holding `mailto:`, `https:`, `file:` and UNC addresses, hosts, IPs, e-mail addresses and Windows paths;
     - what must stay readable;
     - a fast-check property: 2,000 random cases each run, with no generated web URL, e-mail address, domain, IPv4 or IPv6 address surviving the scrub.
4. **Nothing read the fuses back from the packaged binary** (§9.2, ADR-0008 item 5). `electron-builder.yml` set them, but no check confirmed the result.
   - **The fix:** `scripts/check-packaged-app.mjs`, which `package:dir` runs, now reads `Veltriva.exe`'s fuse wire (`scripts/fuse-wire.mjs`, no dependency).
   - **It fails** on any fuse not set as ADR-0007 item 3 says, and on any fuse it doesn't know. So the next Electron that adds a fuse forces a decision.
   - **The baseline:** the stock `electron.exe` of 45.0.0 has 9 fuses, with exactly the defaults the assessment's table lists.
5. **The license audit and THIRD_PARTY_NOTICES.txt** (ADR-0007 item 6, §9.4's license check). The results are below.

## §6.1 Principles

| Principle | Status | Evidence |
|---|---|---|
| Web content is hostile: no Veltriva API, no Node, no preload | Holds | `TAB_WEB_PREFERENCES` (`src/main/web/web-preferences.ts`) has no `preload`, `sandbox`, `contextIsolation`, no Node. `tests/e2e/hostile.spec.ts` asserts `window.veltriva`, `require`, `process`, `app://` and privileged navigations all fail |
| Our UI has least privilege: sandboxed, CSP, narrow validated contract | Holds | `shellWebPreferences`; `src/main/shell/csp.ts` (header); `src/main/ipc/router.ts` (allow-list + Zod) |
| Deny by default | Holds | `src/main/web/session-baseline.ts` (every session, from `session-created`); the broker's allow-list; the guard |
| Patch fast | Holds | ADR-0001's upgrade policy. Electron 45.0.0 is the newest stable (checked on npm, 2026-10-23: `latest` is 45.0.0, no 45.0.x patch, and no 46 build published) |
| Privacy is a security property | Holds | No telemetry or crash uploads (`crashReporter` is never started); local-only suggestions; logs per §6.6 below |

## §6.2 Hardening configuration

**Tab `webPreferences`** (`TAB_WEB_PREFERENCES`; guarded by intent `int-58958b`):

| Setting | Status |
|---|---|
| `partition: 'persist:browsing'` | Holds (`BROWSING_PARTITION`, `src/shared/constants/app-identity.ts`) |
| `sandbox`, `contextIsolation`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false` | Holds, plus `nodeIntegrationInWorker: false` |
| `webSecurity`, `allowRunningInsecureContent: false`, `experimentalFeatures: false`, `navigateOnDragDrop: false` | Holds |
| `safeDialogs: true`, `spellcheck: true`, `backgroundThrottling: true` | Holds |
| No `preload` | Holds, plus `webviewTag: false` |

**Shell `webPreferences`:** Holds (`shellWebPreferences`). It has `preload`, `sandbox`, `contextIsolation`, no Node, `webSecurity`, `webviewTag: false`, `devTools: !app.isPackaged`, and spellcheck off. The popup windows' address bar has the same settings and no preload.

**Application level:**

| Item | Status | Evidence |
|---|---|---|
| `app.enableSandbox()` and a single-instance lock | Holds | `src/main/index.ts` (before `ready`) |
| `web-contents-created` guard assigning roles and policies | Holds | `src/main/web/guard.ts`, `roles.ts`; unclaimed contents are `devtools` or `unknown` (can't navigate) |
| Request, check, device, display-media handlers and Bluetooth chooser on every session | Holds | `hardenSession` on `session-created`, also HID, serial and USB choosers; the browsing session's handlers are then the broker's |
| `app://shell` privileged, handled only on the shell session, path-traversal protection | Holds | `src/main/shell/protocol.ts`, `assets.ts` (`assets.test.ts`); `tests/e2e/shell-protocol.spec.ts` |
| …and checks `request.initiatorOrigin` | Holds, as built | Electron's `protocol.handle` gives a standard `Request`, with no initiator. The handler exists only on the in-memory `veltriva-shell` session, which holds only the shell and the popup address bar, so no page can reach it at all (`shell-protocol.spec.ts`) |
| Production CSP as a response header; `script-src` never relaxed | Holds | `SHELL_CSP` with `style-src 'self'` (no `'unsafe-inline'` in production); the dev CSP exists only in dev builds (ADR-0002 item 6). Intent `int-c9e815` |
| Fuses | Holds, **now read back** (M6.1) | `electron-builder.yml`; `scripts/check-packaged-app.mjs` + `scripts/fuse-wire.mjs` assert all nine on every `package:dir` |

## §6.3 IPC security

| Item | Status | Evidence |
|---|---|---|
| A single entry point, no generic channels, no `ipcRenderer` exposure | Holds | `INVOKE_CHANNEL` and `EVENT_CHANNEL` (`src/shared/contracts/ipc.ts`); `src/preload/shell.ts` exposes typed methods only |
| Allow-listed commands, strict Zod schemas (input and output) | Holds | `src/main/ipc/router.ts`; `router.test.ts`; `tests/e2e/ipc.spec.ts` (malformed payloads to every handler) |
| Sender verification: frame, contents, origin | Holds | `src/main/ipc/sender.ts`, `install.ts` (`senderFrame`; intent `int-c9e815`); `tests/e2e/ipc-sender.spec.ts` |
| Errors without stack traces | Holds | The router answers with a code; it logs only the command and the error's `name` |
| Tab renderers have no channel | Holds | No preload in tabs; `hostile.spec.ts` |

## §6.4 Navigation, popups, protocols, permissions, downloads

| Item | Status | Evidence |
|---|---|---|
| The role table (shell blocked; tabs `http(s)`, `about:blank`, web-origin `blob:`; subframes also `about:srcdoc`, `data:`, `blob:`, the PDF viewer; `veltriva:`, `app:` and top-level `data:` blocked) | Holds | `src/main/web/navigation-policy.ts` (`navigation-policy.test.ts`); `navigation.spec.ts`, `frames.spec.ts`, `pdf.spec.ts` (the viewer's ID re-checked on 45) |
| `window.open` policy and scheme check; `<webview>` blocked | Holds | `src/main/popups`, `guard.ts` (`will-attach-webview`; intent `int-a1c3e7`); `popups.spec.ts` |
| Permission broker: allow-list, prompts for media, geolocation, notifications, clipboard-read; `pointerLock` and the rest denied; no prompts for cross-site frames, popups or insecure origins | Holds | `src/core/permissions`, `src/main/permissions/permission-broker.ts`; `permissions.spec.ts`, `stored-decisions.spec.ts` |
| `openExternal` refused as a backstop | Holds | The broker's `external` verdict |
| The external-protocol guard: blocklist, gesture, prompt naming site and app, launch only after parsing | Holds | `src/core/url/external-protocol.ts` (intent `int-d2f640`), `src/main/external`; `external-protocols.spec.ts` |
| Downloads: Downloads folder, unique names, Mark-of-the-Web, no auto-open, dangerous types confirmed | Holds, as built | ADR-0002 item 10: 175 types need Keep (more than §6.4's list); `downloads.spec.ts` |

## §6.5 Threat model

| # | Threat | Status | Evidence, and what remains |
|---|---|---|---|
| T1 | A page compromises its renderer | Holds; residual | Sandbox, site isolation, no Node, Electron 45.0.0 (the newest). Residual: 0-days, and the window before a patched build ships |
| T2 | A page reaches privileged APIs | Holds | No preload in tabs; sender and schema checks; `hostile.spec.ts`, `ipc.spec.ts`, `ipc-sender.spec.ts` |
| T3 | A page pivots into the shell | Holds | The shell can't navigate or open windows; CSP; the shell session is separate |
| T4 | XSS in our UI via page data | Holds | React escaping; ESLint bans `dangerouslySetInnerHTML` (`eslint.config.mjs`); search highlights are ranges, not HTML (`src/core/search/highlight.ts`); titles cleaned in main |
| T5 | Image decoding in the shell; requests into the local network | **Fixed in M6.1** (redirects, resolved addresses); residual | Raster-only, 64 KB, sniffed, `data:` URLs built by main; `nativeImage` banned in main (intent `int-e8a1b3`). **M6.1:** every redirect hop re-checked; every resolved address checked. **Residual:** true DNS rebinding between the check and the request; the shell still decodes untrusted raster images (re-encoding is post-MVP) |
| T6 | UI spoofing | Holds; residual | The fullscreen notice with origin (`fullscreen.spec.ts`); popups always show an address bar; prompts in the toolbar strip. **Residual:** `alert` and `confirm` block the window and don't name the site (ADR-0002 item 12). Re-checked in M6.1: Electron 45.0.0's API has only `disableDialogs`, `safeDialogs` and `safeDialogsMessage`; no 46 build exists yet; electron/electron#34466 (a `webContents` `dialog` event) was closed unmerged in 2025; the open #54988 adds `app` events for the `dialog` module's own boxes only, and excludes `window.alert()` explicitly |
| T7 | Phishing and homographs | Holds; residual | Hosts shown in punycode, credentials stripped with a warning (`src/core/url/display.ts`, `omnibox.ts`). Residual: no Safe Browsing |
| T8 | Malicious downloads | Holds; residual | No auto-open, Mark-of-the-Web, Keep for 175 types. Residual: a user can still run malware |
| T9 | External-protocol abuse | Holds; residual | Blocklist, gesture and prompt. Residual: new dangerous schemes until listed |
| T10 | Local data theft | Holds; residual | `EnableCookieEncryption` (now read back), data minimization, **no addresses in logs by default (strengthened in M6.1)**. Residual: the database isn't encrypted; same-user malware can read it |
| T11 | Sensitive data in the memory index | Holds; residual | URL hygiene (`src/core/url/hygiene.ts`), `keptTitle` (d90bc52), site exclusions, no content indexing, `secure_delete = ON` plus vacuum on forget. Residual: unusually named secret parameters |
| T12 | Supply-chain compromise | Holds, partly; open | Exact pins (`save-exact`), lockfile, `npm ci`, `ignore-scripts` (intent `int-b47d02`), the Electron zip checked against its checksums by `electron/install.js`, better-sqlite3's binary pinned by SHA-256 (`scripts/sqlite-pin.mjs`), Actions pinned by SHA, **the license check (M6.1)**. **Open (M6.3):** no Dependabot or Renovate config, and no CodeQL workflow. Both are inert without a remote |
| T13 | Tampered binary or update | Holds, partly; residual | ASAR integrity and `OnlyLoadAppFromAsar` (now read back). Residual: unsigned builds (code signing is the user's paid decision); no update channel exists, so there is nothing to sign yet (M6.3) |
| T14 | Stale Chromium | Holds; open | ADR-0001's upgrade policy. **Open (M6.3):** the update-available notification |
| T15 | Debug surfaces | Holds | Fuses (now read back); no `remote-debugging-port` or `inspect` switch anywhere in `src/main`; test hooks compiled out and refused by `scripts/check-production-build.mjs` |

## §6.6 Privacy posture

| Item | Status | Evidence |
|---|---|---|
| No telemetry, analytics or crash uploads | Holds | No SDKs; `crashReporter` is never started |
| Network activity: browsing, the search engine on submit, update checks once they exist | Holds | The only requests main makes itself are favicon fetches for pages the user opened, plus their DNS lookups (M6.1), all through the browsing session. The update check comes in M6.3, off by default |
| Spellcheck dictionaries from our own host | Holds, as built | No host exists, so the URL is the loopback discard port (`SPELLCHECK_DICTIONARY_PLACEHOLDER`). Nothing leaves the machine; languages Windows can't spellcheck get none |
| Logs: tab IDs and error codes; URLs only with diagnostic logging; 5 × 5 MB | Holds, **strengthened in M6.1** | `file-logger.ts`, `log-redaction.ts` (see finding 3) |
| User controls: clear ranges, forget a site, exclude sites, Pause memory | Holds | Phase 5 (`privacy.spec.ts`, `settings.spec.ts`) |

## §6.7 Residual risks

All still stand, and all are in the README's known limitations:
- Chromium vulnerabilities between upstream fixes and our release.
- No Safe Browsing.
- The database isn't encrypted at rest.
- DPAPI doesn't stop same-user malware.
- Unsaved-work detection is heuristic.
- `alert` and `confirm` block the window and don't name the site.
- The favicon decoding exposure until re-encoding lands.
- Unsigned builds.

M6.1 adds one, from T5: **DNS rebinding** of a favicon host between main's check and the request.

## Dependencies (`npm audit`, 2026-10-23)

- **Runtime (`npm audit --omit=dev`):** 0 advisories. The one runtime dependency is better-sqlite3 13.0.3.
- **Everything:** 7 high-severity advisories, all one chain. The shadcn CLI 4.21.5 depends on fast-glob, then micromatch, then braces 3.0.3: GHSA-vfj7-8cjw-p6xm, stack exhaustion on deeply nested brace patterns. The other entries are the same chain as seen through `@shadcn/registry`, `ts-morph` and `@ts-morph/common`.
  - **Why it doesn't ship:** only the shadcn CLI's globbing runs that code, when a developer adds a component. The app ships just one CSS file from the package (`shadcn/tailwind.css`, imported by `globals.css`) and none of its JavaScript.
  - **The suggested fix** is a "major" to shadcn 1.0.0, a downgrade. Not taken.
- **Earlier phases** noted advisories in the electron-builder chain. None remain at electron-builder 26.17.0.

## Licenses

- **The app:** MIT (`LICENSE`). Every license it ships is permissive and compatible with that: MIT, ISC and Apache-2.0. Apache-2.0 asks for its text and any NOTICE file; class-variance-authority has no NOTICE.
- **What ships, and how we know:**
  - **The packages each bundle holds**, recorded by the build itself (`scripts/bundled-packages.mjs`, a Vite plugin, writes `out/third-party/*.json`):
    - main: tldts, tldts-core, zod;
    - the shell: React, react-dom, scheduler, zustand, lucide-react, class-variance-authority, clsx, cn, two Radix packages;
    - the preload: none.
  - **The packages the shell's styles import:** tailwindcss, tw-animate-css, shadcn.
  - **Bundler code no module id names:** rolldown's runtime helpers and Vite's module-preload helper.
  - **What electron-builder copies:** better-sqlite3, whose prebuilt binary also has node-addon-api's headers and SQLite (public domain) compiled in.
  - **Electron, Chromium and Node:** electron-builder puts `LICENSE.electron.txt` and `LICENSES.chromium.html` next to `Veltriva.exe`. The latter is Chromium's full third-party list, Node.js included.
- **`THIRD_PARTY_NOTICES.txt`:** generated by `scripts/third-party-notices.mjs`, committed, and shipped in `resources/` with `LICENSE.txt` (`electron-builder.yml` `extraResources`).
  - **`--check`** fails when the file is stale, or when a shipped package's license isn't on the allow-list (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD).
  - **Where it runs:** in `package:dir` and in CI ("License check").
  - **`check-packaged-app.mjs`** confirms all four license files are in the packaged app.

## Veyra across the history (2026-10-23, 119 commits, 084c89a..20a9e8f)

- **`veyra security scan --rev <commit>`, for every commit:** 0 findings.
- **`veyra intent verify --rev <commit>`:** for the 46 commits that have `.veyra/intents/`, 6 intents and 0 violations.
- **`veyra analyze --commit <commit>`, for every commit:** findings in three commits, none of them a risk here.
  - **Spikes and schema 0001** (084c89a and 1eb950d, 18 findings): `index-without-concurrently`. That rule is for Postgres, where an index build blocks writes. Veltriva is SQLite, which has no `CONCURRENTLY`, and these indexes are built when the schema is created.
  - **The rename in migration 0002** (49f9850): already judged acceptable at the M2.2b merge.
- **M6.1's new intents:** `int-830d8b` keeps addresses out of logs. `int-6acac3` keeps the favicon network checks and the packaged-binary read-back.
