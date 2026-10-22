# Veltriva Browser — Technical Assessment & Architecture Proposal

> **Browse freely. Remember effortlessly.**
>
> Veltriva is a local-first, Chromium-powered desktop browser that intelligently manages inactive tabs, preserves browsing context, and makes previously visited pages instantly searchable.

| | |
|---|---|
| **Status** | **Approved 2026-10-16**: decisions D1–D8 accepted as recommended, recorded as [ADRs 0001–0009](../adr/README.md). Phase 0 spikes done; Phase 1 done (2026-10-17); Phase 2 done (2026-10-22, Milestone 0.1 reached, see §8.2); Phase 3 done (2026-10-22, see §8.2; the memory measurement still to run on a quiet machine); Phase 4 in progress (Step 0, Electron 45.0.0, done) |
| **Date** | 2026-10-16 |
| **Scope** | MVP for Windows 10/11 x64 |
| **Identity** | Project *Veltriva* · repo `veltriva` · app *Veltriva Browser* · MIT license (after dependency license review) |
| **Principles** | **Velocity** (fast, resource-aware) · **Retrieval** (find anything again) · **Continuity** (resume without losing context) |
| **Decision records** | [docs/adr](../adr/README.md). The ADRs are the source of truth from here on; this document records the original reasoning |

**Revised after the Phase 0 spikes (2026-10-16).** Spike results ([docs/spikes](../spikes/README.md)) corrected §1.2, §3.3, §3.7, §4.9, §4.10, §4.12, §5.3–5.5, §6.4, §6.6 and §9.2–9.3. Where this document and an ADR disagree, the ADR wins.

**How to read this.** Parts 1–11 follow the requested structure. Appendix A answers the twelve architectural questions briefly and links into the body. Appendix B lists the facts I checked against current primary documentation, with sources. Anything in the body that depends on behavior we haven't proven yet is labeled as a **spike** (Part 8.3), and no decision depends on an unproven claim.

---

## Executive summary

**Verdict: feasible for one developer as a focused MVP.** The MVP is a dependable single-window Chromium browser. What sets it apart is automatic tab-lifecycle management plus a local, searchable tab memory. Estimated effort is **440–585 hours, about 6–8 months at 15–20 h/week** plus contingency. You can start using it daily after about 3 months.

**Platform: Electron, using `BaseWindow` + `WebContentsView`.** It keeps TypeScript end to end, runs Chromium on every OS, and exposes the lifecycle hooks this product depends on. The costs are real: we build our own version of Chrome's "chrome layer" (tabs, history, permission prompts, popup policy, downloads, discarding), and we must ship Chromium security updates continuously.

**The ten decisions that shape everything else:**

1. **Tabs live on four independent dimensions** instead of one `ACTIVE → IDLE → SLEEPING → ARCHIVED` chain:
   - *placement*: Tabs, Sleeping, Archive, Closed;
   - *runtime*: unloaded through live;
   - *activity*: derived from timestamps;
   - *protection*: derived from signals.

   "Hidden but still running" and "visible but unloaded" both become first-class.
2. **Inactivity is measured on an engagement clock**, in engaged time and active days, so a weekend away never empties your workspace.
3. **Discarding is lossless where Chromium allows.** Veltriva snapshots back/forward history and in-memory page state, closes the page while honoring its `beforeunload` objection, and restores through Chromium's navigation-history restore. Archive is non-destructive with Undo, and even explicit closes stay recoverable for 7 days.
4. **A layered protection engine** (audio, capture, fullscreen, the page's own unsaved-changes signal, form probes, interaction guards, user and site rules). It never claims a tab is "safe"; it reports what it observed.
5. **The main process is the single authority.** The UI is a projection of main-process state, driven through a typed, Zod-validated, sender-checked IPC contract. **Web pages get no preload or bridge at all**, and internal pages are rendered by the trusted shell.
6. **SQLite (better-sqlite3) runs in a worker thread from day one**, with an external-content FTS5 index and explainable ranking (bm25 + decaying frecency + tab state).
7. **Web policy denies by default**: permissions, popups, external protocols, Mark-of-the-Web downloads, no certificate-error bypass. Electron fuses, including cookie encryption, are set from the first build.
8. **Persistence moves ahead of lifecycle** in the roadmap, so daily dogfooding starts after Phase 2.
9. **About 35 hours of Phase 0 spikes** prove the riskiest assumptions before any product code.
10. **A vertical sidebar** (Tabs · Sleeping · Archive) makes the model visible. This one is your call.

**The biggest risks:**

- Losing user work through discarding, which would destroy trust.
- Web-compatibility gaps such as Google sign-in and DRM video.
- The Chromium patch cadence.
- Adoption, because people rarely switch browsers.

Part 10 covers each risk and its mitigation. **Part 11.3 lists the eight decisions, all approved on 2026-10-16.**

---

## Part 1 — Feasibility Assessment

### 1.1 Verdict

A solo developer can build this, on one condition. The MVP has to be *a dependable single-window Chromium browser whose differentiator is an automatic tab lifecycle and a local searchable memory*. It cannot be *a Chrome replacement*. At that scope I estimate **~440–585 focused hours**: about **6–8 months at 15–20 h/week**, plus contingency. The first build you can use daily for your own browsing lands around **month 3** (Part 8).

Browsing itself is the easy part, because Electron embeds the same engine as Chrome. The hard parts are:

1. making automatic tab discarding *trustworthy*;
2. rebuilding the browser-level features Chrome provides above the engine, especially the security ones;
3. keeping a Chromium-based product patched.

### 1.2 What Electron gives you, and what it doesn't

> **Concept: content layer and chrome layer.** Chromium has two layers. The *content layer* handles rendering, JavaScript, networking and the multi-process sandbox. The *chrome layer* holds the browser features: tabs, the address bar, history, permission prompts, the popup blocker, Safe Browsing, the password manager, tab discarding and extensions. Electron embeds the content layer and adds Node.js plus a set of APIs. **Building Veltriva means building our own, smaller chrome layer.** That one framing explains most of the work in this plan.

| Capability | Chrome | Stock Electron | Veltriva must… |
|---|---|---|---|
| Rendering, JS, networking, site isolation, sandbox | ✓ | ✓ (same engine) | configure correctly |
| Tabs, tab strip, **tab discarding/freezing** | ✓ | ✗ (raw web contents only) | **build** (core of the product) |
| Address bar, history, suggestions | ✓ | ✗ | build (local-only) |
| Session restore (history + page state) | ✓ | building blocks only: `navigationHistory.getAllEntries()` / `restore()` (Electron 34.2+), including Chromium's serialized page state | build |
| Permission prompts | ✓ | handler hooks, no UI | build the broker and UI |
| Popup blocker | ✓ | ✗: the window-open handler isn't told whether a user gesture occurred | build a policy (§3.7) |
| Downloads UI and manager | ✓ | `DownloadItem` events | build |
| Safe Browsing (phishing/malware) | ✓ | ✗ | document as a gap; post-MVP |
| Password manager, autofill, sync | ✓ | ✗ | out of scope |
| Extensions | ✓ | limited subset | out of scope |
| PDF viewer | ✓ | ✓ Built in and on by default. It runs in a `chrome-extension://` frame that navigation guards must allow (S7) | allow its frame (§6.4) |
| DRM video (Widevine: Netflix, Spotify web) | ✓ | ✗ in stock builds; castlabs' "Electron for Content Security" fork adds it | out of scope; document |
| Spellcheck | ✓ | ✓ On the test machine, en-US used Windows' own spellchecker (S7). Other languages download dictionaries from a Google CDN by default | self-host the dictionaries (§6.6) |
| Security updates | automatic, by Google | arrive through Electron releases that **we must ship** | build a release pipeline |

### 1.3 The hardest engineering challenges, ranked

1. **Trustworthy discarding.** Electron has no discard or freeze API. Discarding means destroying a page's web contents and recreating them later. A recreated page loses its in-memory state unless we restore navigation history and page state, and unsaved work can only be *partially* detected. Getting this wrong destroys trust, which is the product's success criterion.
2. **Lifecycle concurrency.** Navigation events, renderer crashes, user clicks, the scheduler and persistence are all asynchronous. Without per-tab operation serialization and stale-result detection you get the classic bugs: a tab discarded the moment the user selected it, orphaned renderers, double restores.
3. **The browser-grade security surface.** Permission prompts, popup policy, external-protocol launches, download safety, certificate errors, UI-spoofing defenses (fullscreen, chromeless popups) and, above all, the Chromium patch cadence are now our responsibility.
4. **View composition.** Web pages are native views painted *above* the HTML interface, so the DOM cannot overlap them. The omnibox dropdown and the search palette need a deliberate overlay strategy, and keyboard focus has to be routed across views.
5. **Crash-safe, privacy-correct persistence.** Session state must survive a hard kill without blocking Electron's UI thread, and deletion must really delete, including from the full-text index.
6. **Search that feels like memory.** The MVP indexes only titles and URLs, so ranking signals (recency, frequency, tab state) do most of the work.
7. **Honest measurement.** Windows memory accounting (working set, private bytes, shared memory) makes it easy to publish numbers that are accidentally misleading.
8. **Web compatibility.** Google sign-in, OAuth popups, DRM video and PDFs decide whether anyone can use Veltriva daily.

### 1.4 Explicit non-goals for a solo developer

Chrome feature parity, an extension ecosystem, a password manager or autofill, sync, DRM streaming, enterprise policy, and Safe Browsing. Safe Browsing is documented as a known gap and revisited after the MVP.

### 1.5 Product feasibility

The technical risk is manageable. **Adoption is the larger risk.** Tab hoarders already live in Chrome or Edge with their logins, passwords and extensions. Veltriva has to be clearly better at one job, long research sessions with many tabs, so that people use it *alongside* their main browser. Two design consequences follow: import paths should come early after the MVP, and the core logic should stay portable enough to power a companion Chrome extension later (Part 10).

### 1.6 Prior art and positioning

| Product | What it does | Lesson for Veltriva |
|---|---|---|
| **Chrome Memory Saver** | Unloads inactive tabs (Moderate, Balanced, Maximum). Exempts playing media, calls, screen sharing, sites that send notifications, downloads, partly filled forms and pinned tabs | Saves memory but doesn't reduce clutter or help you find anything. Its exemption list matches our protection engine, which is reassuring (§4.10) |
| **Edge sleeping tabs** | Puts tabs to sleep after a timeout and fades them. Microsoft's own sources disagree on the default: 15 minutes in the policy reference, two hours in consumer help | Same gap: invisible resource savings, no retrieval |
| **Firefox tab unloading** | Unloads least-recently-used tabs only when memory is critically low | Pressure-driven only, like our rule 4 in §4.7 |
| **Vivaldi Memory Saver** | Hibernates idle tabs; off by default; exempts media and partly filled forms | Opt-in, conservative |
| **Arc auto-archive** | Archives idle, unpinned tabs; 12 hours by default, per Arc's help center | The closest prior art, and well loved. But Arc has been **in maintenance mode since 2025** (Chromium updates only), and The Browser Company is now owned by Atlassian. That leaves an opening for auto-archiving that is local-first and searchable, on Windows |
| **OneTab, Tab Wrangler, Workona** | Extensions that turn tabs into lists, auto-close idle tabs into a "corral", or organize spaces with suspension and sync | Their popularity proves the pain is real. They're bolted on from outside the browser, so they can't own the tab model |

**Veltriva's position: the only option that combines all three halves of the problem:**

1. invisible resource savings, like Chrome, Edge and Firefox;
2. visible clutter reduction, like Arc;
3. a searchable, local memory of everything that left the strip.

On top of that it adds timing that ignores time away (the engagement clock).

---

## Part 2 — Technology Evaluation

### 2.1 Platform: is Electron the right choice? (Question 1)

| Criterion | **Electron** | CEF (C++ / CefSharp) | Tauri 2 + WebView2 | Chrome extension |
|---|---|---|---|---|
| Engine | Bundled, pinned Chromium | Bundled Chromium | Edge WebView2 (Evergreen) on Windows; **WebKit** on macOS/Linux | The user's Chrome |
| Language for browser logic | TypeScript | C++ or C# | Rust, with a TS UI | TypeScript |
| Many pages in one window | `WebContentsView`, first-class | One `CefBrowser` per tab, first-class | Multi-webview still behind Tauri's `unstable` feature flag (2.12) | n/a (real Chrome tabs) |
| Lifecycle hooks | Navigation-history restore, `beforeunload` interception, media/capture events, process metrics, CDP | Rich, low-level | **Ahead of Electron here:** `TrySuspend` (hidden webviews), `MemoryUsageTargetLevel = Low`, and `IsUserInitiated` on new-window requests | `tabs.discard`, `autoDiscardable`, collapsible tab groups |
| Security patching | **You ship Electron updates** | You ship CEF updates | Microsoft auto-updates the runtime (Evergreen; built into Windows 11) | Google |
| UI freedom | Full | Full | Full | Constrained: tabs can be discarded and hidden in collapsed groups, but the strip and address bar are Chrome's |
| Installer size | Large (Chromium included) | Large | Small | Tiny |
| Fit with your skills | Excellent | Poor (C++) / fair (C#) | Fair (Rust) | Excellent |
| Portfolio value | High: browser internals in TS | High but niche | High | Medium |
| User switching cost | Must adopt a new browser | Same | Same | **None** |

**Recommendation: Electron.**

- The whole stack stays in TypeScript, which matches your experience and keeps your velocity high.
- `WebContentsView` inside a `BaseWindow` is designed for exactly this case: many web pages composed in one window.
- It exposes the hooks this product depends on: exporting and restoring navigation history, intercepting `beforeunload`, media and capture signals, per-process metrics, isolated-world scripting, and the DevTools Protocol.
- It is Chromium on every OS, so a later macOS or Linux port keeps the same engine. Tauri would switch to WebKit there.
- As portfolio material it demonstrates browser internals, not a thin wrapper.

**The costs, stated plainly.** You must ship Chromium security fixes yourself, through Electron updates. The installer is large. You build the chrome layer.

**Runners-up, and what we borrow from each:**

- **Chrome extension.** The best *product* hedge, because users don't switch browsers. It can discard tabs and tuck them into collapsed tab groups, but it lives inside Chrome's UI: it can't redesign the tab strip, the address bar, or the lifecycle model. It's also a weaker "desktop browser engineering" story. We borrow its architecture: keep `src/core` free of Electron imports so a companion extension could reuse the lifecycle policy, ranking and URL logic later.
- **Tauri 2 + WebView2.** The best *patching* story, because Microsoft updates the runtime, and the installer is tiny. WebView2 is genuinely **ahead of Electron on lifecycle APIs**: a real suspend for hidden webviews, a low-memory target level, and a user-gesture flag on popups. But:
  - multi-webview is still behind Tauri's `unstable` flag;
  - every WebView2-specific feature means Rust plus COM interop through `with_webview`;
  - non-Windows builds would run on WebKit, not Chromium.
- **CEF.** The most control, at the price of C++ (or C#) and a much heavier build. A poor fit for this team of one.

### 2.2 Stack review

| Area | Brief proposed | Verdict | Notes |
|---|---|---|---|
| Desktop framework | Electron | **Keep** | Phase 1 started on 44.7.2 (Chromium 152, Node 24.21), the newest stable then, and moved to 44.9.0 (Chromium 152.0.7977.167, Node 24.22) in its wrap-up; Phase 2 began with the 44.9.1 patch (same Chromium and Node). **Phase 4 Step 0 moved to 45.0.0** (Chromium 156, Node 24.22, stable since 2026-10-21); see ADR-0001's pin history. A new major ships every 8 weeks and only the latest 3 get fixes; the oldest of those gets security fixes only. Everything we rely on is present: `WebContentsView` (30+), `createWindow` (31+), `navigationHistory.restore` (34.2+), `before-mouse-event` (36.5+) |
| Window and page API | — | **`BaseWindow` + `WebContentsView`** | `BrowserView` has been deprecated since Electron 30; it's now a thin wrapper, not yet removed. No `<webview>`, no iframes |
| Language | TypeScript | **Keep** | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Use **TypeScript 6.0** for now. TypeScript 7 (the native compiler, GA July 2026) comes in once typescript-eslint supports it; today its peer range stops below 6.1 |
| Linting and formatting | — | **Add ESLint 10 (flat config) + typescript-eslint + Prettier** | Type-aware rules such as `no-floating-promises` matter for async lifecycle code. oxlint is the faster alternative to revisit with TypeScript 7 |
| UI framework | React | **Keep** | React 19 (19.3 current) |
| Build | Vite | **Keep, through electron-vite** | electron-vite 6 on Vite 8: one config for main, preload and renderer; HMR for UI; hot restart for main (§2.4) |
| Styling | Tailwind CSS | **Keep** | v4 (4.3 current), via `@tailwindcss/vite` |
| Components | shadcn/ui | **Keep, selectively** | Radix-based accessible primitives for dialogs, popovers, forms. The tab sidebar and omnibox are custom |
| Icons | Lucide | **Keep** | |
| UI state | Zustand | **Keep, renderer only** | Read-model of main-process state plus local UI state. Main uses plain TypeScript classes and typed events, with no state library |
| Database | SQLite | **Keep** | |
| SQLite driver | — | **better-sqlite3 in a worker thread** (node:sqlite fallback) | §2.3 |
| Full-text search | FTS5 | **Keep** | `unicode61` tokenizer with prefix indexes; trigram later for CJK and substring matching |
| Validation | Zod | **Keep** | Zod 4 (4.6 current), used only at trust boundaries (IPC, settings, persisted JSON) |
| Unit and integration tests | Vitest | **Keep** | Vitest 5 on plain Node 24. better-sqlite3 13 is an N-API module, so the same binary loads in Node and in Electron (§2.6) |
| Property and model-based tests | — | **Add fast-check** | fast-check 4: `fc.scheduler()` and `scheduledModelRun` reorder async completions to expose races deterministically |
| End-to-end tests | Playwright | **Keep, with caveats** | Playwright 1.64. Electron support is still labeled experimental, but `WebContentsView`s inside a `BaseWindow` show up as Pages, which Playwright's own test suite has covered since March 2026. Complemented by main-process hooks (§9.2) |
| Packaging | electron-builder | **Keep electron-builder (NSIS)** | electron-builder 26 (26.17 stable). Compared with Electron Forge 8 in §2.4 |
| Logging | "structured" | **Thin logger interface** + our own ~100-line rotating JSONL sink | Privacy-aware: no URLs at the default log level. electron-log works but does more than we need and is rarely updated |
| Domain parsing | — | **Add tldts** | Public Suffix List-aware registrable domains for the omnibox, grouping and site rules |
| Long lists | — | **Add @tanstack/react-virtual** | Archive lists with thousands of rows |
| Deliberately **not** added | — | ORM, Redux, React Query, any backend server, analytics SDKs | Each would add weight without solving a problem we have |

### 2.3 SQLite driver

| | **better-sqlite3 13** (recommended) | `node:sqlite` (built into Node) |
|---|---|---|
| Maturity | Mature and widely used. v13 (July 2026) moved to **N-API** | **Release candidate** (stability 1.2) in Node 24 LTS and Node 26; Electron 42+ has the RC version |
| Electron coupling | One `win32-x64` prebuild loads in Node 22.14+ **and** Electron 35+; there's no per-Electron-ABI binary anymore | Ships *inside* Electron's Node. It has broken once: Electron 37.2.0 shipped without it until a patch release |
| FTS5 and math functions | Both enabled; bundles SQLite 3.53.4 | Both enabled in Electron 44.7.2 (S5, observed at runtime) |
| API | Synchronous (ideal *inside* a worker); custom functions, online backup, iteration | Synchronous; `function()`, `aggregate()`, `backup()`, `iterate()` |
| Watch-outs | Use ≥ 13.0.2: earlier 13.x could abort the process if a worker terminated mid-call. On Windows, npm may try to compile it unless installs use `--ignore-scripts` (S5) | API still settling (classes are being renamed); a broken Electron build would block a security upgrade |

**Decision.** Use better-sqlite3 13, inside a dedicated `worker_threads` worker, behind an **async repository interface**.

`node:sqlite` is nearly as capable and has zero dependencies. But it would tie the data layer to how each Electron release builds Node. That has already broken once, and the failure would land at the worst moment: in the middle of a security upgrade.

Spike S5 runs both drivers, in development and in a packaged build. Because every call site goes through the repository interface, swapping drivers later is a contained change.

**Why a worker thread from day one.** Electron's main-process JavaScript runs on Chromium's *browser UI thread*. That is the same thread that routes input to every tab and manages windows. A 40 ms synchronous query there doesn't just slow Veltriva's own UI: it delays keystrokes and clicks to *every web page*. Moving the database later would mean converting every synchronous call site, so the async boundary has to exist from the start.

### 2.4 Build and packaging: electron-vite + electron-builder (vs Electron Forge)

- **electron-vite 6** (October 2026) supports Vite 6–8 and Electron 42–44. It gives one Vite configuration for main, preload and renderer, renderer HMR, main and preload hot restart, multiple renderer entries, and TypeScript out of the box. One caution: its release cadence stalled for about five months during the 6.0 betas, which is a maintenance-health signal we watch. On Electron 45 (Phase 4 Step 0), 6.0.0 has no entry for 45 and builds for the newest it knows, `chrome152` and `node24.18`: older targets than 45's engines, so the output still runs, only with less modern syntax.
- **electron-builder 26** provides:
  - an **NSIS installer** (its default Windows target; per-user, no admin rights);
  - `electron-updater` with **differential (blockmap) updates**;
  - automatic unpacking of native modules from `asar`;
  - Electron fuse flipping, through the `electronFuses` config key (added in 26.0);
  - code signing through `signtoolOptions`, `azureSignOptions` or a custom `sign` hook. A custom hook is how SignPath plugs in.
- **Electron Forge 8** (September 2026) is the officially recommended toolchain, and it **promoted its Vite plugin to stable**, which closes most of the gap. Its Windows makers are Squirrel.Windows, WiX MSI, MSIX, AppX and ZIP. NSIS is available only through electron-builder's own Forge maker, and `electron-updater` doesn't support Squirrel installs.

For a per-user NSIS installer with differential updates, electron-builder is the direct route.

**Fallback.** If electron-vite's maintenance falters, the development build can move to Forge 8's Vite plugin while packaging stays on electron-builder.

The choice is reversible except for one thing. **The installer technology and the AppUserModelID are effectively one-way doors once users have installed builds**, because auto-update continuity depends on them (Part 10.2).

### 2.5 Electron limitations we design around

1. **No tab discard or freeze API.** Discarding is implemented as snapshot, then destroy, then recreate (Part 4).
2. **The main process is Chromium's UI thread.** Never block it: the database lives in a worker, there is no synchronous file I/O after startup, and there is no large synchronous JSON work.
3. **Native views can't be overlapped by HTML.** This drives the overlay strategy in §3.3.
4. **The missing chrome layer.** The table in §1.2 is our backlog, triaged in Part 7.
5. **No popup blocker, and dangerous defaults.** Electron ignores user activation when a page opens a window, so `window.open` spam isn't blocked. Without handlers installed it also **grants every permission**, launches external apps for unknown URL schemes, and **auto-selects the first client certificate**. Every one of these defaults is overridden in §3.7 and §6.
6. **Patch cadence.** Chromium security fixes reach users only when we ship an Electron update.
7. **Playwright's Electron support is experimental.** We keep a second test channel through main-process hooks.
8. **Fixed baseline memory.** Electron's own processes (browser, GPU, network service, UI renderer) cost memory before the first tab. Honest benchmarks report this baseline separately (Part 9.3).

### 2.6 Native modules: what you need to know

> **Concept: ABI vs N-API.** A native Node module (a `.node` file) is compiled C/C++.
>
> - Modules built against V8's internal ABI (`NODE_MODULE_VERSION`) only load in the exact runtime they were compiled for. Electron's embedded Node differs from the Node on your PATH, so such a binary can't load in both, and every new Electron major needs a new build.
> - **N-API** modules target a stable C interface instead, so one binary loads in any runtime that supports its N-API version.
>
> better-sqlite3 switched to N-API in v13 (July 2026). Before that, its Electron prebuilds lagged new Electron majors by anything from same-day to about **six weeks**; Electron 42 was the six-week case.

Consequences we plan for:

- **Install.** better-sqlite3 13 ships a ready-made `win32-x64` binary in its npm package. Because it also contains a `binding.gyp`, npm may try to compile it, which needs Visual Studio Build Tools and Python. We avoid that by installing with `--ignore-scripts`, which is also good supply-chain hygiene (§6.5 T12), and by disabling electron-builder's native rebuild. Spike S5 verifies that a clean machine needs no compiler.
- **Packaging.** `.node` files can't load from inside an `asar` archive. electron-builder 26 unpacks them automatically. Whether the *worker entry script* resolves correctly from inside the archive is untested, so S5 checks it in a packaged build.
- **Tests.** One N-API binary serves both the app (Electron) and Vitest (plain Node 24), so no special test runner is needed. The Vitest maintainers have said Vitest can't run *inside* Electron, so this matters.
- **Upgrades.** N-API removes per-major rebuilds, but every Electron upgrade still goes through a CI branch before landing.

---

## Part 3 — Recommended Architecture

### 3.1 Process model and trust zones

```text
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ MAIN PROCESS  · Node.js + Chromium browser/UI thread · TRUSTED               │
 │ Owns all authoritative state and every privileged decision.                  │
 │                                                                              │
 │  AppController ── WindowManager ── LayoutManager ── FocusManager             │
 │  TabManager ── TabRuntime (one per live tab) ── LifecycleEngine (core policy)│
 │  ActivityTracker · EngagementClock · ProtectionMonitor                       │
 │  NavigationService · OmniboxService                                          │
 │  WebPolicy: Permissions · Popups · Downloads · ExternalProtocols · Certs     │
 │  SettingsService · IpcRouter · Logger · Metrics                              │
 │                │ async RPC over a worker MessagePort                         │
 │                ▼                                                             │
 │  ┌──────────────── DATA WORKER (worker_threads) · TRUSTED ────────────────┐  │
 │  │ better-sqlite3 · migrations · repositories · FTS5 search ·             │  │
 │  │ backups · retention jobs                                               │  │
 │  └────────────────────────────────────────────────────────────────────────┘  │
 └──────────────┬──────────────────────────────────────────┬────────────────────┘
   preload bridge│ (allow-listed commands,                  │ Electron webContents API only
   Zod-validated,│  sender-checked)                         │ (no preload, no IPC bridge)
                 ▼                                          ▼
 ┌─────────────────────────────────────┐   ┌──────────────────────────────────────────┐
 │ UI RENDERER · app://shell · React   │   │ TAB RENDERERS · one per site instance    │
 │ Trusted code, UNTRUSTED data        │   │ UNTRUSTED · sandboxed · site-isolated    │
 │ (titles, URLs, favicons)            │   │ session partition "persist:browsing"     │
 │ sandbox · contextIsolation · CSP    │   │ nodeIntegration off · contextIsolation   │
 │ separate session, never browses     │   │ no access to any Veltriva API            │
 └─────────────────────────────────────┘   └──────────────────────────────────────────┘
   Chromium also runs a GPU process, the Network Service and utility processes.
```

> **Concept: renderer processes and site isolation.** Chromium renders pages in separate, sandboxed *renderer processes*. With site isolation, pages and cross-site iframes from different sites (eTLD+1, such as `github.com`) get different processes, so a compromised page can't read another site's memory. Two tabs on the same site may share a process. That's why "one tab = one process" is only approximately true, and why our memory measurements work per process, then map back to tabs.

> **Concept: sessions and partitions.** An Electron `session` is a browser profile in miniature: cookie jar, cache, storage, permission handlers. `persist:browsing` is stored on disk under the app's user-data folder. A partition name without `persist:` is in-memory only, which is what a future private window uses. The UI runs in a **different** session from web pages. That separation means web pages can't see the UI's protocol handler, and clearing browsing data never affects the UI.

### 3.2 Component responsibilities

| Component | Responsibility | Talks to |
|---|---|---|
| **AppController** | Startup and shutdown sequencing, single-instance lock, crash detection, safe mode | WindowManager, DataClient |
| **WindowManager** | `BaseWindow` lifecycle, window bounds persistence, creating the UI view | LayoutManager |
| **LayoutManager** | Computes the content rectangle from window size and UI insets; attaches and detaches tab views; fullscreen; overlay mode (§3.3) | TabManager |
| **FocusManager** | Decides whether the UI or the page has keyboard focus; routes browser shortcuts (§3.9) | LayoutManager |
| **TabManager** | Authoritative tab registry: placement, order, selection. Command API, per-tab operation queue, state events | everything tab-related |
| **TabRuntime** | Wraps one `WebContentsView`: create, restore, snapshot, discard, event wiring | Electron APIs |
| **LifecycleEngine** | Pure policy (`src/core`) plus a scheduler; turns facts into actions with reasons | TabManager, EngagementClock, ProtectionMonitor |
| **ActivityTracker / EngagementClock** | Input, selection and focus timestamps; system idle, sleep and lock state; the engagement clock (§4.6) | `powerMonitor` |
| **ProtectionMonitor** | Per-tab protection signals: audio, capture, fullscreen, unsaved-work probes, background activity | TabRuntime |
| **NavigationService / OmniboxService** | URL-or-search classification, navigation commands, local suggestions | DataClient |
| **WebPolicy** | Permission broker, popup policy, downloads, external protocols, certificate and login handling | UI prompts |
| **SettingsService** | Zod-validated settings with defaults and change events | DataClient |
| **IpcRouter** | Contract registry, sender validation, payload validation, error mapping | UI |
| **DataClient ↔ DataWorker** | Async RPC; repositories, search, migrations, backups, retention | SQLite |
| **UI renderer** | Renders a projection of main-process state, dispatches commands, owns purely local UI state | preload API |

### 3.3 Window composition and overlays (Question 2)

```text
BaseWindow  (native Windows frame in the MVP)
└─ contentView
   ├─ [z=0] uiView         WebContentsView · app://shell · fills the window
   │                       toolbar, tab sidebar, internal pages, prompts, overlays
   └─ [z=1] activeTabView  WebContentsView · https://…  · bounds = content rect
         Only the *selected* tab's view is attached. Other live tabs exist but are
         detached; unloaded tabs have no view at all.
```

**The safest, most efficient way to manage many pages:**

- One `WebContentsView` per **live** tab. Views for hidden live tabs are *detached* from the window, and discarded tabs have *no* view.
- **Destruction is always explicit.** Electron never destroys a view's web contents for us; its docs warn that forgetting to close them leaks memory. Every discard and close therefore runs `removeChildView` → `webContents.close()` → drop all references. A leak test asserts that renderer process counts return to baseline. Electron 46 is changing how views hold their contents; this rule works either way.
- Every tab view gets the same hardened `webPreferences` and the `persist:browsing` partition.
- No `<webview>` tags, no iframes, no deprecated `BrowserView`.
- A global `app.on('web-contents-created')` hook applies navigation and window-open guards to *every* web contents, including ones created by popups or DevTools, so nothing escapes the policy.

**Internal pages are rendered by the trusted UI, never inside a tab renderer.** The new-tab page, settings, the memory page, error pages (network, certificate, crashed tab) and the "this tab is sleeping" placeholder are React views painted in the content area while the tab view is detached. Their identifiers look like URLs (`veltriva://settings`) but are **never loaded into any web contents**. A web page that tries to navigate to `veltriva:` or `app:` URLs is blocked. This means a privileged page never lives inside the untrusted tab system, which removes a whole class of escalation bugs.

**Overlays.** Native views always paint above the UI view, so an HTML dropdown can't cover a page. Two features need to: omnibox suggestions and the Ctrl+Shift+K memory palette. Menus use native `Menu.popup()` (accessible, and painted above everything), and permission prompts are anchored inside the toolbar.

**Decision (ADR-0006, after spike S4): raise the transparent shell above the tab.** The options compared (10-run medians):

| Option | How it works | S4 result |
|---|---|---|
| A. Snapshot takeover (Min browser's approach) | `capturePage()` the tab, paint the snapshot plus the overlay in the shell, raise the shell above the tab | **Rejected.** An *opaque* view above a tab counts as occlusion: the page goes `hidden`, its timers are throttled and it stops painting. Overlay on screen in 24 ms |
| **A′. Raise the transparent shell** (found during S4) | The shell view's background is `#00000000`. While an overlay is open, a CSS class clears the content area and the shell is re-added on top | **Adopted.** The page stays `visible` and live underneath. Overlay on screen in 12 ms. No extra renderer, and focus stays in the shell's own input |
| B. Overlay view | A second trusted, transparent `WebContentsView` above the tab | Fallback. The page stays live, but it costs an extra renderer (about 23 MB) and cross-view state; 33 ms warm |
| C. Child popup window (what Chrome does for its omnibox popup) | A frameless, non-focusable child window | Not needed |

While raised, the shell receives all mouse input over the content area. That's correct for the modal palette. For the omnibox dropdown, a click on the page closes the dropdown and the click is consumed.

### 3.4 State ownership and data flow

```text
 UI renderer                         Main process                            Data worker
 ───────────                         ────────────                            ───────────
 user clicks "Archive"  ──command──▶ IpcRouter: sender ✓ schema ✓
                                     TabManager.archive(tabId)
                                       ├─ per-tab queue → TabRuntime.discard()
                                       ├─ placement = archive, emit change
                                       └─ PersistenceScheduler.markDirty ──batch──▶ BEGIN … COMMIT
 Zustand store ◀──snapshot (coalesced, versioned)── WorkspaceProjector
 React re-renders only the slices that changed
```

- **The main process is the only writer of domain state.** The UI sends *intents* (`tabs.archive`) and never state patches.
- **Main pushes versioned, coalesced snapshots of the workspace view model**: at most one per animation frame, about 16 ms. High-frequency details such as load progress travel as separate lightweight events. The archive and search results are *not* in the snapshot; they're paged queries. Snapshots are simpler than patches and can't drift. At a few hundred tabs they're cheap. If profiling disagrees, we move to patches.
- **Persistence is asynchronous and batched** (Part 5.5). The UI never waits on the database for tab operations.

### 3.5 IPC contract

- `src/shared/contracts` defines every command as `name → { input: ZodSchema, output: ZodSchema }`, plus every event name and payload schema. Main and UI derive their types from it, giving one source of truth.
- The **UI preload** builds a frozen API object from the contract (`window.veltriva.tabs.archive({ tabId })`) and exposes it with `contextBridge`. It never exposes `ipcRenderer`, the IPC `event` object, or a generic `send(channel)`.
- The **main IpcRouter** handles each command as follows:
  1. It verifies the sender: the message must come from the main frame of `uiView.webContents`, whose origin is `app://shell` (or the Vite dev-server origin in development builds only). Anything else is dropped and logged.
  2. It parses the payload with a `.strict()` schema, so unknown keys are rejected.
  3. It calls the handler.
  4. It returns `{ ok: true, value }` or `{ ok: false, code }`. Stack traces never cross to the renderer.
- **Tab renderers have no preload and no IPC channel.** The signals we need from pages come from Electron's main-process `webContents` events, or from two small isolated-world scripts (§4.10): an on-demand probe and a passive trusted-input tracker. Neither has a channel to main.

### 3.6 Address bar (Question 8)

The classifier is a pure function in `src/core/url`, tested against a large table of adversarial inputs:

1. **Sanitize.** Trim, strip control characters and newlines, and cap the length.
2. **Internal pages.** `veltriva://<name>` opens an allow-listed internal page and nothing else.
3. **Explicit scheme.**
   - `http:` and `https:` navigate.
   - `about:blank` is allowed.
   - `file:` is allowed only when typed, never when a page initiates it.
   - `javascript:`, `data:` and `vbscript:` are **never navigated**; the text becomes a search instead.
   - Any other scheme goes through the external-protocol guard (§6.4).
4. **No scheme.**
   - Input containing whitespace becomes a search.
   - Otherwise parse `https://<input>`. Treat it as a URL only if the host is `localhost`, an IP literal, has an explicit port, or ends in a real public suffix (tldts).
   - Single words become searches. There is no intranet guessing in the MVP.
5. **Scheme upgrade.** Inferred URLs use `https://`, except for `localhost` and private IP ranges, which use `http://`. A TLS failure on an inferred URL shows an error page offering an explicit "Try http://".
6. **Search.** Uses a template from settings with `encodeURIComponent`. The default engine is chosen at first run; DuckDuckGo is preselected for privacy.
7. **Suggestions are local only.** They come from open tabs, memory hits and typed history. **No keystrokes leave the machine** while typing.
8. **Display.**
   - Show the committed URL's host in punycode when it contains non-ASCII characters, to prevent homograph spoofing.
   - Strip `user:pass@` and warn.
   - Mark `http:` pages "Not secure".
   - **Never** show page-controlled text in the address bar.

### 3.7 Cookies, authentication, permissions, downloads, protocols (Question 9)

| Concern | MVP policy |
|---|---|
| **Cookies and storage** | One persistent partition, `persist:browsing`, for all normal tabs. The cookie-encryption fuse is **on from the first build** (Windows DPAPI). Electron has no third-party-cookie switch and allows them by default; blocking them would mean rewriting headers in `webRequest`, a post-MVP privacy feature. Future private windows use in-memory partitions and never touch the profile or the database |
| **Logins and OAuth** | In-page logins work normally. OAuth and payment popups keep `window.opener` because the window-open handler's `createWindow` hosts Chromium's pre-created contents in our own view (`new WebContentsView({ webContents: options.webContents })`, available since Electron 31). Ctrl/middle-click opens get no pre-created contents, so we create the view and load the URL ourselves |
| **Google sign-in** | **A real compatibility risk.** Google's OAuth policy forbids *embedded* user agents, and Electron's default user agent advertises `Electron/x` plus the app name. Spike S7 found:<br>• Setting `app.userAgentFallback` before `ready` removes every trace, in the page, in workers and in request headers.<br>• Client-hint brands never mention Electron, but they don't say "Google Chrome" either.<br>• Navigations carry no `Sec-CH-UA*` headers.<br>Min browser even switches to a Firefox user agent just for `accounts.google.com`. Manual check M1 decides whether a per-site override is needed; it would be a documented last resort.<br>**M1 result (2026-10-18):** refused as an embedded browser. The first answer is honest client hints: navigations now carry the `Sec-CH-UA*` headers Chromium sends on subresources, and `Accept-CH` is honored (ADR-0002 item 11). The retest showed it isn't enough on its own: Google still warned on the first attempt, and "Try again" let the user in. So the documented last resort is now in place: requests to `accounts.google.com` carry Firefox's user agent, as in Min (ADR-0002 item 11). With it, sign-in goes straight through (retest, 2026-10-19) |
| **HTTP authentication** | Electron cancels HTTP auth by default. MVP: a simple credential prompt in the trusted UI, never stored (should-have) |
| **Client certificates** | Electron **auto-selects the first certificate** unless the app intervenes, and since Electron 44 also for requests that have no tab. Veltriva always intervenes. MVP: decline, with a clear error page. Post-MVP: a picker |
| **Certificate errors** | Electron rejects invalid certificates by default; we keep that. Blocking error page with **no "proceed anyway"** in the MVP |
| **Permissions** | With no handler installed, Electron **grants everything**, so Veltriva installs both the request handler and the synchronous check handler on every session. Deny by default; prompt (showing the punycode origin) for camera, microphone, geolocation, notifications and clipboard read; decisions remembered per origin. USB, HID and serial are denied through the device handler; Bluetooth chooser requests are cancelled |
| **Downloads** | A `will-download` handler on every session always calls `setSavePath`, saving to the Downloads folder with unique names; Electron would otherwise show a save dialog. Progress UI.<br>Chromium writes Windows **Mark-of-the-Web**, verified in S7: `ZoneId=3` with `HostUrl=about:internet`, and no source or referrer recorded. Whether the antivirus hand-off happens couldn't be observed.<br>Downloads belong to the session and survive closing, discarding or crashing their tab. Never auto-opened; executables need an extra confirmation |
| **Popups** | **Electron has no popup blocker**, and nothing tells us whether a gesture occurred, so Veltriva approximates Chromium's user-activation rule: a popup is allowed only within a few seconds of a trusted click or key press in that tab. Otherwise it's blocked, with an indicator to open it anyway. Popups are routed by `disposition`:<br>• `foreground-tab` and `background-tab` become tabs we create and load ourselves. Ctrl, middle and Shift clicks carry no pre-created contents.<br>• `new-window` feature popups (OAuth, payments) become small popup windows hosting the pre-created contents, with a **read-only, always-visible URL bar**. Their host window is closed when the page calls `window.close()`, which Electron doesn't do by itself.<br>Hosted popups don't inherit `safeDialogs`; that's a known gap (S7) |
| **External protocols** | With no handler, Electron hands unknown schemes straight to the OS, **with no prompt and no gesture required**. Veltriva routes them through the `openExternal` permission. `mailto:`, `tel:` and app schemes (`zoommtg:` and so on) need a gesture plus a prompt, with an optional per-site "always allow". Known-dangerous schemes are always blocked (`ms-msdt:`, `search-ms:`, `ms-officecmd:` and others) |

### 3.8 Project structure

```text
veltriva/
├─ docs/
│  ├─ architecture/        # this proposal, overview, lifecycle, security, data model
│  ├─ adr/                 # 0001-platform-electron.md, …
│  └─ spikes/              # Phase 0 spike reports
├─ src/
│  ├─ core/                # PURE TypeScript: no electron/node imports; unit-tested
│  │  ├─ lifecycle/        # tab model, runtime state machine, policy engine, invariants
│  │  ├─ protection/       # protection rules and their evaluation
│  │  ├─ search/           # query parsing, ranking, frecency
│  │  ├─ url/              # omnibox classifier, normalization, URL sanitization
│  │  └─ settings/         # settings schema and defaults (Zod)
│  ├─ main/
│  │  ├─ app/              # bootstrap, single-instance lock, crash recovery, safe mode
│  │  ├─ windows/          # WindowManager, LayoutManager, FocusManager, UI view
│  │  ├─ tabs/             # TabManager, TabRuntime, lifecycle scheduler, activity tracking
│  │  ├─ web/              # session setup, permissions, popups, downloads, protocols, certs
│  │  ├─ data/             # DataClient (RPC), worker entry, migrations/, repositories/
│  │  ├─ ipc/              # router, sender validation, command handlers
│  │  └─ platform/         # logger, metrics, shortcuts, menus
│  ├─ preload/
│  │  └─ shell.ts          # contextBridge API for the trusted UI only
│  ├─ renderer/            # React UI served from app://shell
│  │  ├─ app/              # layout shell
│  │  ├─ features/         # toolbar, sidebar, memory, search-palette, settings, prompts, ntp
│  │  ├─ components/ui/    # shadcn/ui components
│  │  ├─ stores/           # Zustand: projection of main state, plus local UI state
│  │  └─ lib/              # typed API client
│  └─ shared/
│     ├─ contracts/        # IPC commands/events and Zod schemas
│     └─ constants/
├─ tests/
│  ├─ fixtures/            # deterministic local test pages and a tiny fixture server
│  ├─ integration/         # data layer, migrations, TabManager with fakes
│  ├─ e2e/                 # Playwright
│  └─ bench/               # benchmark harness (manual, not CI-gating)
└─ scripts/
```

Unit tests sit next to the code (`*.test.ts`). `core/` versus `main/` is the one deliberate layering rule, and it's what makes the lifecycle policy testable without launching Electron.

### 3.9 Keyboard and focus

- **Browser-reserved shortcuts** are intercepted in main through `before-input-event` on the UI and on every tab web contents, before the page sees them. They are Ctrl+T, Ctrl+W, Ctrl+Shift+T, Ctrl+Tab and Ctrl+Shift+Tab, Ctrl+1…9, Ctrl+L, Alt+D, F6, F5, Ctrl+R, Alt+←/→, F11, F12 and Ctrl+Shift+K.
- **Every other shortcut goes to the page first.** Web apps legitimately claim shortcuts such as Ctrl+K and Ctrl+F; Google Docs has its own find. Exactly how "page first, browser second" is implemented with views is validated in Phase 1.
  - **Validated in M1.3b.** The browser's page-first shortcuts (Ctrl+F, F3, Ctrl+G, zoom) are accelerators of a window menu that is never shown. Electron runs a menu accelerator only for a key event the renderer left unhandled, so a `preventDefault()` in the page wins. Measured on Electron 44 with `WebContentsView` tabs, and it holds while the shell has focus too.
  - Reserved keys are matched by a pure function (`src/core/input/shortcuts.ts`). AltGr, which Windows reports as Ctrl+Alt, never matches, so AltGr characters still type; on non-Latin layouts the physical key decides.
  - Playwright's keyboard (CDP) doesn't pass through `before-input-event`, so tests send keys with `webContents.sendInputEvent`.
- **Reserving Ctrl+Shift+K is a deliberate trade-off.** The memory palette is the product's core, so it wins over the few sites that bind that combination (Slack uses it for "Browse DMs"). Shortcuts become rebindable after the MVP.
- **FocusManager** owns the rules: Ctrl+L focuses the UI view and the omnibox; a committed navigation returns focus to the page; Escape in an overlay restores the previous focus.

---

## Part 4 — Tab Lifecycle Design

This is the most important system in the product. A user lets tabs leave their sight only if they trust Veltriva not to lose them.

### 4.1 Four operations that must never be confused

| Operation | What changes | Resources freed | What survives | Undone by | UI label |
|---|---|---|---|---|---|
| **Hide** (shelve) | *Placement*: Tabs → Sleeping | None (the page may stay live) | Everything | Clicking it in Sleeping | "Sleeping" |
| **Suspend** | *Runtime*: hidden-tab throttling (automatic) or freeze (experimental) | CPU only; memory stays | Everything (still in memory) | Selecting the tab | invisible |
| **Discard** | *Runtime*: live → unloaded (renderer destroyed) | Renderer memory and CPU | URL, title, favicon, back/forward stack; page state such as scroll and form values, best-effort and only within the current run | Selecting the tab (it reloads) | dimmed "unloaded" dot |
| **Archive** | *Placement*: → Archive (always discarded) | All live resources | Everything above except in-memory page state; searchable | Search or the Archive list | "Archive" |
| *Close* (user) | *Placement*: → Closed, kept 7 days | All | Same as Archive, short-lived | Ctrl+Shift+T or Recently closed | "Recently closed" |

**The key insight (Question 4): what you *see* (placement) and what the tab *costs* (runtime) are independent dimensions.**

- A tab can be **in the strip but discarded**. That's every tab after a restart, until you click it.
- A tab can be **in Sleeping but still live**. That's a protected tab with an unsaved form, collapsed out of the strip but not destroyed. This is exactly the brief's §7.3 suggestion, and it falls out of the model naturally.

One linear `ACTIVE → IDLE → SLEEPING → ARCHIVED` enum can't express either case without boolean flags patched on top, which is the brief's own Rule 5 warning.

### 4.2 The tab model: four dimensions

```text
Tab
├─ identity    id (UUIDv7), workspaceId, createdAt, openerTabId
├─ placement   STRIP | SHELF | ARCHIVE | CLOSED                    persisted; user-visible
├─ runtime     UNLOADED | CREATING | LIVE | FROZEN | DISCARDING | CRASHED
│              in memory only; derived as UNLOADED after any restart
├─ activity    lastUsedAt (wall clock), lastUsedEngaged (engagement clock),
│              lastUsedActiveDay, lastInteractedAt, hiddenSince, lastAudibleAt
│              → derived classes: active · recent · idle · stale · dormant
└─ protection  set of { reason, source, blocks: freeze|discard|shelve|archive, hard|soft }
               recomputed on every evaluation, never stored as a "state"
```

Mapping from the brief's states:

- **ACTIVE** means "selected" (a property, not a state).
- **IDLE** becomes a *derived* activity class, so no timer has to "move" a tab into it.
- **SLEEPING** splits into *placement SHELF* and *runtime UNLOADED/FROZEN*.
- **ARCHIVED** is *placement ARCHIVE*.
- **RESTORING** is the `CREATING` operation.
- **ERROR** splits into *runtime CRASHED* (renderer died) and a *navigation error*. A navigation error is a page-level condition shown by an error page, not a lifecycle state.

### 4.3 Runtime state machine

```text
   UNLOADED ──ensureLive()──▶ CREATING ──view ready──▶ LIVE ◀──thaw──▶ FROZEN (experimental, off)
      ▲  ▲                       │                       │  ▲
      │  └──creation failed──────┘              discard()│  │ blocked: page objects to unload /
      │                                                  ▼  │ probe finds unsaved input / timeout
      └──────────── destroyed ──────────────────── DISCARDING

   LIVE | FROZEN ──renderer gone──▶ CRASHED ──reload / ensureLive()──▶ CREATING
   any state ──close tab──▶ removed   (epoch++ cancels in-flight work; orphan views destroyed)
```

| From | Event | To | Side effects |
|---|---|---|---|
| UNLOADED | `ensureLive` (select, restore) | CREATING | Create the view; restore navigation history, or `loadURL` |
| CREATING | View ready | LIVE | Attach to the window if selected |
| CREATING | Creation threw | UNLOADED | Error toast with Retry; snapshot untouched |
| LIVE | `freeze` (flagged experiment) | FROZEN | CDP `Page.setWebLifecycleState: frozen`, sent through `webContents.debugger`. It's experimental in the protocol, and the debugger detaches whenever the user opens DevTools |
| FROZEN | `thaw` (select, any protection signal, before discard) | LIVE | `Page.setWebLifecycleState: active`. Chromium's implementation unfreezes without re-showing the page, so the thaw path re-attaches the view to restore visibility explicitly |
| LIVE, FROZEN | `discard` | DISCARDING | Thaw → probe → snapshot → close (with the `beforeunload` check only for tabs that had real input; §4.9) |
| DISCARDING | `destroyed` | UNLOADED | Release the view; persist the snapshot |
| DISCARDING | `will-prevent-unload`, dirty probe, or 5 s timeout | LIVE | Add protection *unsaved changes* |
| LIVE, FROZEN | `render-process-gone` | CRASHED | Crashed-tab page; if killed for memory, raise the pressure level |
| CRASHED | `ensureLive` (user clicks Reload) | CREATING | Destroy the dead view; recreate from the snapshot |

### 4.4 Placement transitions

```text
  ┌─────────┐  auto: stale & beyond cap   ┌──────────┐  auto: dormant       ┌─────────┐
  │  STRIP  │ ──────────────────────────▶ │  SHELF   │ ───────────────────▶ │ ARCHIVE │
  │ "Tabs"  │ ◀────────────────────────── │"Sleeping"│                      │         │
  └─────────┘  select / drag back         └──────────┘                      └─────────┘
     │  ▲  │                                                                   ▲    │
     │  │  └──────────────────── manual: Archive ─────────────────────────────┘    │
     │  └──────────────────────── restore (search, archive list) ──────────────────┘
     └── user closes ──▶ CLOSED ── 7 days ──▶ purged (its pages remain in history)
                          └── Ctrl+Shift+T / Recently closed ──▶ STRIP
```

Sleeping tabs can also be archived or closed manually. Restoring from Archive puts the tab next to the current tab.

### 4.5 Invariants

These are enforced in TabManager and asserted after every step of the model-based tests.

1. **I1.** A non-empty workspace has exactly one selected tab, and it is in STRIP.
2. **I2.** The selected tab's runtime is CREATING, LIVE or CRASHED, because selection always triggers `ensureLive` or thaw.
3. **I3.** Every ARCHIVE or CLOSED tab is UNLOADED. Archived tabs never hold renderer resources.
4. **I4.** A tab has a `WebContentsView` **if and only if** its runtime isn't UNLOADED. No leaks, no zombies.
5. **I5.** Automation never acts on the selected tab, on a tab with a hard protection, or on a tab whose epoch changed after the decision.
6. **I6.** Ephemeral (future private) tabs never reach the persistence layer. This is enforced by type and by a runtime assertion.
7. **I7.** A tab has at most one lifecycle operation in flight.
8. **I8.** A pinned tab is always in STRIP.

### 4.6 The engagement clock: inactivity measured in *your* time

**Problem.** Wall-clock thresholds punish absence. Close the laptop on Friday, and by Monday every tab is "3 days stale", so Monday morning starts with an archived workspace. That is the fastest way to lose a user's trust.

**Design.** An `EngagementClock` is a persisted, monotonic counter. It advances only while:

- the app is running,
- the OS isn't suspended or locked, **and**
- the user was active in the last 5 minutes. `powerMonitor.getSystemIdleState(300)` returns `active`, `idle` or `locked` and is sampled every 30 s, alongside the Windows `suspend`, `resume`, `lock-screen` and `unlock-screen` events.

The clock gives two units:

- **Engaged time**, for short horizons such as "unused for 2 hours of active browsing".
- **Active days**, for long horizons. A calendar day counts once engagement reaches 10 minutes, so "not used in 3 active days" survives weekends and vacations.

Each tab records the clock value and active-day index at its last use. The policy compares against those values. The UI still shows people wall-clock time ("last used 4 days ago").

**Discarding is the exception and uses wall-clock hidden time.** Releasing memory while you're away is desirable, and it's invisible except for a reload.

### 4.7 Policy engine and defaults

The policy is a **pure function** in `src/core/lifecycle`, so it's fully unit-testable with no Electron and no timers:

```ts
planLifecycle(input: {
  tabs: readonly TabFacts[];        // placement, runtime, timestamps, protections, pinned…
  settings: LifecycleSettings;
  clock: { wallNow: number; engagedNow: number; activeDay: number };
  pressure: 'none' | 'moderate' | 'critical';
}): LifecycleAction[];               // { tabId, kind, rule, reason } — every action explains itself
```

The rules, using Balanced values:

1. **Discard** a LIVE tab that has been hidden for 60 min or more, unless a protection blocks discard.
2. **Shelve** an unpinned STRIP tab that is outside the 10 most-recently-used unpinned tabs *and* unused for 2 engaged hours or more. A tab you used recently never moves, even when the strip is over the cap.
3. **Archive** a SHELF tab unused for 3 active days or more, when auto-archive is on. It's discarded first in the same operation. If the discard is blocked, the archive is skipped and the reason logged.
4. **Under memory pressure**, discard hidden, unprotected tabs in least-recently-used order, at most K per tick. Critical pressure overrides *soft* protections only. **Pressure never shelves or archives**: what you see never changes for resource reasons.
5. **Freeze** is an experiment, off by default: a LIVE tab hidden for 10 min or more that is not audible, capturing, or background-active (§4.10).

| Setting | Gentle | **Balanced (default)** | Aggressive | Measured in |
|---|---|---|---|---|
| Discard hidden tabs after | 4 h | **60 min** | 15 min | wall-clock hidden time |
| Unpinned tabs kept in the strip | 15 | **10** | 6 | most recently used |
| Move extra tabs to Sleeping after | 8 h | **2 h** | 30 min | engaged time |
| Archive Sleeping tabs after | 14 active days | **3 active days** | 1 active day | active days |
| Recent-interaction guard | 30 min | **15 min** | 5 min | wall clock |
| Pinned tabs can be discarded | no | **no** | yes | — |
| Freeze hidden tabs (experiment) | off | **off** | off | — |

These defaults are **hypotheses**. They get tuned during dogfooding with the local "regret" signal (§4.13).

**Memory pressure** has no Electron event. Veltriva polls `process.getSystemMemoryInfo()`, which on Windows reports total and free memory but no "available" figure. It also reacts when a renderer dies with reason `oom` or `memory-eviction`. The thresholds come from Phase 3 measurements.

### 4.8 Scheduler

- **One timer for the whole browser**, no per-tab timers. It evaluates every 60 s, plus on events: a tab becomes hidden, settings change, the pressure level changes, or the system resumes (the clock is re-sampled first, so no mass action happens on wake). Evaluation is O(number of non-archived tabs), effectively free.
- **Actions run through TabManager's per-tab queues** with rate limits: at most 3 discards per tick, staggered about 1 s apart, so automation never causes jank.
- **Quiet start.** No automation in the first 2 minutes after launch, while the restored session settles.
- **Injected clock and timer.** Tests drive time explicitly, and E2E tests can fast-forward an hour of engagement in milliseconds through a test-only hook that is compiled out of production builds.

### 4.9 The procedures

**Discard** (LIVE or FROZEN → UNLOADED). This answers Question 3: how resources are freed without losing restore metadata.

1. **Re-validate at commit time.** The tab is not selected, has no blocking protection, isn't loading, and its epoch is unchanged.
2. **Thaw if FROZEN.** Unload handlers need a running page.
3. **Probe and flush.**
   - A short isolated-world script checks for unsaved input (§4.10) and reads `navigator.userActivation.hasBeenActive`. The caller enforces a 100 ms budget with its own timeout, because a busy page delayed the probe by about 680 ms in S3, and a timeout means "keep the tab". If anything is dirty, abort and add the *unsaved input* protection.
   - The same script calls `history.replaceState(history.state, '')`. Chromium commits page state on its own only after about 1 s on a visible tab, or about 5 s on a hidden one; this call forces the commit in roughly 10 ms (spike S2). It triggers one `did-navigate-in-page` event, which must not count as a navigation or as engagement.
4. **Snapshot** the navigation entries and active index (`navigationHistory.getAllEntries()`, `getActiveIndex()`), title, favicon and last committed URL. Each entry's `pageState` is Chromium's serialized page state: scroll position and form values. It's kept **in memory only**. It is about 0.7–2 KB per entry, and grows by about 2 bytes per typed character.
5. **Close.** The probe's `hasBeenActive` reading picks the path (S3). That flag resets on navigation, and unlike our main-process input observers it also flips when the user interacts inside a cross-site iframe.
   - **`hasBeenActive` is true:** call `webContents.close({ waitForBeforeUnload: true })`. If the page's `beforeunload` handler objects, Electron emits `will-prevent-unload` within a few milliseconds. Unless we call `preventDefault()`, it silently cancels the close, with no dialog (S3 checked the window list). We **don't override it**: the tab stays LIVE and gains the *page reports unsaved changes* protection. No `destroyed` event within 5 s also counts as blocked. The listener is removed after each attempt.
   - **`hasBeenActive` is false:** close directly, without the `beforeunload` round-trip. Electron's `close({ waitForBeforeUnload })` grants the page user activation before dispatching `beforeunload` (S3 saw `hasBeenActive` flip from false to true), which defeats Chromium's rule that untouched pages can't object to leaving. Without this split, a site that always registers `beforeunload` could pin every one of its tabs awake. A plain `close()` delivers only `visibilitychange` to the page, not `beforeunload`, `pagehide` or `unload`.
   - Veltriva never runs scripts in tabs with `userGesture: true`, because that would forge activation.
6. **On `destroyed`**, drop the view, set runtime to UNLOADED, and persist the snapshot, without page state, for crash safety.

**Restore** (UNLOADED → LIVE, on selection or an explicit restore). The order below was verified in spike S2:

1. **Create a brand-new `WebContentsView`** with the hardened preferences and wire its events. `restore()` only works on contents that has never loaded anything. Any earlier load, even `about:blank`, makes it reject, and an un-awaited load corrupts the history.
2. **Attach the view first.** If the tab isn't selected, attach it with `setVisible(false)`. Restoring into a *detached* view puts the scroll position off by the display scale factor (6416 → 8020 px at 125%), and it never corrects itself.
3. **Validate persisted entries.** URLs must parse and pass the scheme allow-list, and titles must be strings. Omit `pageState` instead of storing `''`, which is rejected.
4. **Restore or load.** If a snapshot exists, call `navigationHistory.restore({ entries, index })`; otherwise call `loadURL`. Restore rebuilds the back/forward stack and titles. When in-memory page state is available, it also brings back the scroll position and text, textarea, select and checkbox values. It does **not** bring back React-style controlled inputs or `contenteditable` content.
5. **Handle the three failure shapes.**
   - A synchronous throw (bad index or empty entries), or a rejection with no `did-fail-load`, is a *creation* failure. The tab returns to UNLOADED with "Couldn't restore — Retry", and Retry uses another new view.
   - A rejection after `did-fail-load` is a failing *navigation*. The tab stays LIVE on an error page, with its history intact; that's a page condition, not a lifecycle failure.
   - Error pages emit `did-finish-load` too, and HTTP 404/500 responses resolve, so neither is a success signal.
6. **Show the view** if the tab is selected, and focus it.

**Archive.** The tab must be UNLOADED, so it's discarded inline first, and the archive is aborted if that discard is blocked. Then persist the placement, `archived_at` and reason, drop the in-memory page state, and show "Archived · Undo".

**Close.** A user-initiated close runs `beforeunload` under the same rule as discard: only for tabs that had real input. If the page objects, Veltriva asks "Leave page? Changes may not be saved", exactly as Chrome does, and only the user can override. The tab then moves to CLOSED for 7 days.

**Startup.** All tabs start UNLOADED. Only the previously selected tab is restored, and the others restore when selected, so a large session never loads all at once (brief §8.3).

### 4.10 Protection engine (Question 5)

**Hard** protections block an action entirely. **Soft** protections block it unless memory pressure is critical.

| Signal | How it's detected | Blocks | Hard or soft | Confidence and limits |
|---|---|---|---|---|
| Selected or visible tab | TabManager | everything | hard | exact |
| User-protected tab | user flag | everything | hard | exact |
| Protected site | site rule | everything | hard | exact for listed sites |
| Pinned | user flag | shelve, archive (discard per setting) | hard | exact |
| Audio playing (and 2 min after) | `audio-state-changed` (`event.audible`), `isCurrentlyAudible()` | freeze, discard, shelve | hard | high |
| Video playing | `media-started-playing` / `media-paused` (no payload, so we keep a per-tab counter) | freeze, discard | hard | medium. S1: the events fire as documented, and a muted tab still reports audible, so muted-but-playing tabs are protected too. Whether that should become a soft protection is a Phase 3 tuning question. **As built (M3.4):** the counter never ends for a Web Audio context a page keeps open, even silent, so the discard's probe finds playing media at decision time instead, muted or not, and the finding is learned (ADR-0003 item 15) |
| Camera, microphone or screen capture | permission granted to the page + `isBeingCaptured()` | everything | hard | medium: we know when it starts, not exactly when it stops, so protection lasts until navigation or close |
| Fullscreen | `enter-html-full-screen` | everything | hard | high |
| Page declares unsaved changes | For tabs whose `hasBeenActive` is true, `beforeunload` cancels the discard attempt and Electron emits `will-prevent-unload`. A cross-site iframe's objection counts only if that iframe itself was interacted with (S3) | discard, archive | hard | high for sites that use `beforeunload` (Google Docs, GitHub, Jira, mail compose); blind to sites that don't |
| Unsaved form input (heuristic) | On-demand probe through `executeJavaScriptInIsolatedWorld`:<br>• changed `input`/`textarea`/`select` (`value ≠ defaultValue`);<br>• the record of the **trusted-input tracker**, a passive isolated-world listener for trusted `input`/`change` events installed after each navigation (S3);<br>• a focused `contenteditable`, which counts only as *soft* on its own, because a plain click sets it (S3) | discard, archive | hard | medium-high. The `value` check alone misses React-style inputs, and focus alone misses a `contenteditable` once blurred; the tracker catches both (S3). Still misses JavaScript-only state and canvas editors. **Top-level frame only**: Electron can't run isolated-world scripts in subframes from the main process, so forms inside iframes rely on `beforeunload` and `hasBeenActive` |
| Recent interaction | Main-process input observers. Names differ by event (S3):<br>• `input-event` reports every type, including `mouseMove`, wheel, `rawKeyDown`/`char`/`keyUp` and scroll gestures; the handler only stamps a time.<br>• `before-input-event` is keyboard only (`keyDown`/`keyUp`).<br>• `before-mouse-event` reports mouse but not wheel | discard, shelve, archive | soft | exact within the guard window for the top frame. Clicks into a cross-site iframe reach only `before-mouse-event`, and **keystrokes inside one aren't observed at all**, so `hasBeenActive` and `beforeunload` cover those |
| Loading or navigation pending | `isLoading()`, `did-start-navigation` | discard, archive (deferred) | hard | exact |
| Has an open popup (OAuth, payment) | popup registry | discard, archive | hard | exact |
| DevTools open | `devtools-opened` | discard | hard | exact |
| Site can send notifications | `notifications` permission granted to the tab's origin | discard, freeze | soft | exact; Chrome's Memory Saver exempts the same case |
| Background-active app (title or favicon changes while hidden, e.g. chat, mail) | `page-title-updated`, `page-favicon-updated` while hidden | discard, freeze | soft | heuristic; Chrome uses similar signals |
| Sensitive page (password or payment fields present) | probe: `input[type=password]`, `autocomplete^="cc-"` | discard; never content-indexed | soft | heuristic |
| Upload in progress | **not detected in the MVP**; the recent-interaction guard covers typical uploads | — | — | documented gap |
| Download in progress | *No protection needed.* S7 showed downloads belong to the session and complete after their tab is closed, discarded or crashed | — | — | verified |

**Limits we state openly.** Arbitrary web apps keep state in memory that no browser can see: a half-written comment in a canvas-based editor, or a single-page app that never registers `beforeunload`. Veltriva therefore stacks four lines of defense:

1. **Conservative defaults** and the vacation-proof clock.
2. **Detection**, using the page's own `beforeunload` contract plus form probes.
3. **Recovery**: in-run page-state restoration brings scroll position and plain text, textarea, select and checkbox values back after a discard. It does not restore React-style controlled inputs or `contenteditable` content (S2). That's why edits the trusted-input tracker catches in those fields stay a hard protection.
4. **User control**: protect a tab or a site, pin it, or pause automation.

The UI never claims a tab is "safe". It says what Veltriva *observed* ("Kept awake: page reported unsaved changes").

### 4.11 Concurrency and race safety

1. **Per-tab serial operation queue.** Lifecycle operations on one tab never interleave.
2. **Epochs.** Every runtime transition increments `runtimeEpoch`. An async completion that carries an older epoch is ignored, and any view it created is destroyed.
3. **Idempotent commands.** `ensureLive` while CREATING returns the in-flight promise. `discard` on an UNLOADED tab is a no-op, and so is `archive` on an archived tab.
4. **Commit-time re-validation.** Decisions use a snapshot of facts but are checked again immediately before the irreversible step.
5. **Shutdown sequencing.** Stop the scheduler, cancel queued operations, snapshot live tabs, flush to disk (capped at 3 s), then quit.

| Race | Resolution |
|---|---|
| User selects a tab while it's being discarded | The discard re-validates "not selected" before `close()` and aborts; `ensureLive` is queued behind it |
| Tab closed while CREATING | Epoch mismatch: the new view is destroyed when it arrives |
| Archive while navigation is pending | Deferred to the next tick (loading protection) |
| Double-clicked restore | The in-flight `ensureLive` promise is reused |
| Rapid tab switching | Selection is synchronous in TabManager; only the final selection's view gets attached; intermediate `ensureLive` calls complete harmlessly |
| App killed during a database write | WAL and transactions: at most the last 1–2 s of changes are lost, and nothing is corrupted (Part 5.5) |
| Renderer crashes mid-discard | Treated as discarded, using the last known navigation entries |

### 4.12 Safeguards against data loss

- Conservative defaults, measured on the vacation-proof engagement clock.
- Hard protections: the selected tab; user or site protection; audio, capture and fullscreen; a page declaring unsaved changes; modified forms; loading; open popups; DevTools.
- Discards keep the back/forward stack, plus page state within the current run.
- Archive is non-destructive and searchable. Every automated batch has **Undo** and appears in a "Recently archived" list.
- Explicit closes stay recoverable for 7 days. Pages stay in history according to the retention setting.
- One toggle pauses all automation. Every automatic action is logged locally with the rule that triggered it.

### 4.13 Trust and transparency in the UX

- **Visible.** The sidebar shows counts ("Sleeping 12 · Archived today 3"). Tab tooltips explain status: "Unloaded to save memory — click to reload", "Kept awake: playing audio".
- **Reversible.** Every move has an Undo toast, and one click brings a tab from Sleeping or Archive back to Tabs.
- **Predictable.** Presets come with plain-language descriptions, and a "What happens next" view lists the tabs that will move soon.
- **Measured locally.** If you restore a tab within one engaged hour of automation moving it, that counts as a *regret event*. The regret rate appears only on a local diagnostics page and is the metric for tuning defaults during dogfooding. There is no telemetry.
- **Optional onboarding.** For the first 3 active days, automation runs in *preview* mode: it marks the tabs it *would* move, without moving them, so new users can calibrate trust.

---

## Part 5 — Database Design (Question 6)

### 5.1 Principles

- **Two kinds of data, kept separate.** **Workspace objects** (`tabs`) are what the user owns and arranges, with everything needed to restore each tab. **Memory** (`pages`, `visits`) is what the user saw, subject to retention. Search joins the two. *An archived tab is a workspace object you can restore; a visit is a fact in your history.* That answers the brief's question of how archived tabs differ from navigation history.
- **IDs.** The main process mints tab IDs as UUIDv7, synchronously, so it never waits on the database. High-volume rows (`pages`, `visits`) use integer rowids.
- **Integrity in the schema.** `STRICT` tables, foreign keys, and `CHECK` constraints for enumerations and invariants such as "archived implies archived_at".
- **Timestamps** are INTEGER Unix milliseconds (UTC).
- **Never on disk:** Chromium page state (serialized form values and scroll), page content (until opt-in content indexing in v1.1), passwords. Cookies stay in Chromium's own encrypted store.

### 5.2 Entity overview

```text
 workspaces 1──* tabs *──0..1 pages 1──* visits
                  │              │
                  └──0..1 favicons 0..1──┘
 pages ══ external-content FTS5 ══▶ pages_fts
 site_rules · permission_decisions · settings · app_state · app_runs
```

### 5.3 Initial schema (migration `0001_init.sql`)

```sql
-- Connection pragmas, set by the data worker on open (not stored in this file):
--   journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000;
--   secure_delete=ON; temp_store=MEMORY; cache_size=-16000 (16 MB; S5)
-- On a brand-new database the runner sets PRAGMA auto_vacuum = INCREMENTAL *before*
-- journal_mode=WAL; in the other order it silently stays off (S5).

CREATE TABLE workspaces (
  id          TEXT    PRIMARY KEY,                    -- UUIDv7 (MVP: one default row)
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE favicons (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT    NOT NULL UNIQUE,                -- of the bytes
  bytes       BLOB    NOT NULL,                       -- as sniffed, ≤ 64 KiB, never decoded in main (T5)
  updated_at  INTEGER NOT NULL,
  mime        TEXT    NOT NULL DEFAULT 'image/png'    -- the raster type the bytes sniff as
              CHECK (mime IN ('image/png','image/x-icon','image/gif','image/jpeg','image/webp','image/bmp'))
) STRICT;
-- As built: 0001 created `png` (for a re-encoded PNG); migration 0002 (M2.2b) renamed it to
-- `bytes` and added `mime`, once re-encoding in main was ruled out. The shell scales the image.

-- Memory: one row per distinct normalized URL.
CREATE TABLE pages (
  id              INTEGER PRIMARY KEY,
  url_key         TEXT    NOT NULL UNIQUE,            -- identity: normalized, tracking params removed
  url             TEXT    NOT NULL,                   -- display/search form, secrets stripped (§5.7)
  host            TEXT    NOT NULL,
  site            TEXT    NOT NULL,                   -- registrable domain (eTLD+1)
  title           TEXT    NOT NULL DEFAULT '',
  favicon_id      INTEGER REFERENCES favicons(id) ON DELETE SET NULL,
  first_visit_at  INTEGER NOT NULL,
  last_visit_at   INTEGER NOT NULL,
  visit_count     INTEGER NOT NULL DEFAULT 0,
  typed_count     INTEGER NOT NULL DEFAULT 0,
  frecency        REAL    NOT NULL DEFAULT 0,         -- decayed score as of frecency_at (§5.4)
  frecency_at     INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX pages_site_idx       ON pages(site);
CREATE INDEX pages_last_visit_idx ON pages(last_visit_at DESC);
-- Recent-and-frequent listing (empty query). The decayed score f·2^(−(now−f_at)/H) orders exactly
-- like log2(f) + f_at/H, because the shared "now" term cancels; H = 30 days in ms (S5: 0.4 ms vs a 29–45 ms scan).
CREATE INDEX pages_frecency_idx   ON pages((log2(frecency) + frecency_at / 2592000000.0));

CREATE TABLE visits (
  id          INTEGER PRIMARY KEY,
  page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tab_id      TEXT,                                   -- soft reference: visits outlive tabs
  visited_at  INTEGER NOT NULL,
  transition  TEXT    NOT NULL CHECK (transition IN
               ('link','typed','reload','back_forward','redirect','restore','generated','other'))
) STRICT;
CREATE INDEX visits_page_time_idx ON visits(page_id, visited_at DESC);
CREATE INDEX visits_time_idx      ON visits(visited_at DESC);

-- Workspace objects: every tab the user owns, wherever it currently lives.
CREATE TABLE tabs (
  id                    TEXT    PRIMARY KEY,          -- UUIDv7 minted in main
  workspace_id          TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  placement             TEXT    NOT NULL CHECK (placement IN ('strip','shelf','archive','closed')),
  position              INTEGER NOT NULL DEFAULT 0,   -- order within (workspace, placement)
  pinned                INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  user_protected        INTEGER NOT NULL DEFAULT 0 CHECK (user_protected IN (0,1)),
  page_id               INTEGER REFERENCES pages(id) ON DELETE SET NULL,  -- current entry, for search
  url                   TEXT    NOT NULL,             -- exact current URL (needed to restore)
  title                 TEXT    NOT NULL DEFAULT '',
  favicon_id            INTEGER REFERENCES favicons(id) ON DELETE SET NULL,
  restore_state         TEXT,                         -- JSON {v, index, entries:[{url,title}]}, ≤ 50 entries
  opener_tab_id         TEXT,                         -- soft reference
  created_at            INTEGER NOT NULL,
  last_used_at          INTEGER NOT NULL,             -- wall clock
  last_used_engaged     INTEGER NOT NULL,             -- engagement-clock value (§4.6)
  last_used_active_day  INTEGER NOT NULL,             -- active-day index (§4.6)
  placement_changed_at  INTEGER NOT NULL,
  archived_at           INTEGER,
  archive_reason        TEXT    CHECK (archive_reason IN ('auto','manual')),
  closed_at             INTEGER,
  CHECK (placement <> 'archive' OR archived_at IS NOT NULL),
  CHECK (placement <> 'closed'  OR closed_at   IS NOT NULL),
  CHECK (pinned = 0 OR placement = 'strip'),
  CHECK (restore_state IS NULL OR json_valid(restore_state))
) STRICT;
CREATE INDEX tabs_layout_idx   ON tabs(workspace_id, placement, position);
CREATE INDEX tabs_archived_idx ON tabs(archived_at DESC) WHERE placement = 'archive';
CREATE INDEX tabs_closed_idx   ON tabs(closed_at)        WHERE placement = 'closed';
CREATE INDEX tabs_page_idx     ON tabs(page_id);

CREATE TABLE site_rules (
  site            TEXT    PRIMARY KEY,                -- registrable domain
  protect         INTEGER NOT NULL DEFAULT 0 CHECK (protect IN (0,1)),         -- no automation
  exclude_memory  INTEGER NOT NULL DEFAULT 0 CHECK (exclude_memory IN (0,1)),  -- never recorded
  created_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE permission_decisions (
  origin      TEXT    NOT NULL,                       -- scheme://host:port
  permission  TEXT    NOT NULL,                       -- 'media', 'geolocation', 'protocol:zoommtg', …
  decision    TEXT    NOT NULL CHECK (decision IN ('allow','deny')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (origin, permission)
) STRICT, WITHOUT ROWID;

CREATE TABLE settings (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  json  TEXT    NOT NULL CHECK (json_valid(json))     -- parsed by Zod; missing keys take defaults
) STRICT;

CREATE TABLE app_state (                              -- small documents: session, clocks, window
  key   TEXT PRIMARY KEY,
  json  TEXT NOT NULL CHECK (json_valid(json))
) STRICT, WITHOUT ROWID;

CREATE TABLE app_runs (                               -- crash detection and diagnostics
  id                 INTEGER PRIMARY KEY,
  started_at         INTEGER NOT NULL,
  last_heartbeat_at  INTEGER NOT NULL,
  ended_at           INTEGER,
  exit_kind          TEXT    CHECK (exit_kind IN ('clean','crash')),
  app_version        TEXT    NOT NULL
) STRICT;

-- Full-text index over memory. External content: the text lives once, in `pages`.
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title, url, site,
  content = 'pages', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 1);  -- deleted terms really disappear

CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, url, site) VALUES (new.id, new.title, new.url, new.site);
END;
CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, url, site)
  VALUES ('delete', old.id, old.title, old.url, old.site);
END;
-- Only text changes re-index; frequent visit_count/frecency updates do not.
CREATE TRIGGER pages_fts_au AFTER UPDATE OF title, url, site ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, url, site)
  VALUES ('delete', old.id, old.title, old.url, old.site);
  INSERT INTO pages_fts(rowid, title, url, site) VALUES (new.id, new.title, new.url, new.site);
END;
```

**Phase 2 amendments.** The shipped `0001_init.sql` (`src/data/migrations/`) is the schema above plus four changes the user approved on 2026-10-20 (ADR-0004 item 7):

- (a) `permission_decisions.decision` takes `'allow'` or `'block'`, the code's `Decision` type, instead of `'allow'` or `'deny'`.
- (b) An external protocol's "always allow" is a `permission_decisions` row with permission `protocol:<scheme>`, origin the asking site's origin, and decision `'allow'`.
- (c) A new `downloads` table holds download history:
  - columns `id` (UUIDv7), `file_name`, `path`, `url` (secrets stripped, §5.7), `site`, `state`, `dangerous`, `confirmed`, `received_bytes`, `total_bytes`, `started_at` and `ended_at`;
  - CHECKs: only a dangerous file can be unconfirmed, only a running or paused download has no `ended_at`, and byte counts are never negative.
- (d) Client-hint opt-ins are the `app_state` document `client_hints`, with no table of their own.

Notes on the brief's proposed entities:

- **Sessions** become `app_runs` (crash detection) plus `app_state['session']` (selected tab, window bounds). The `tabs` table *is* the live session, always current, so restart and crash recovery read one place.
- **Tab history** splits two ways: `visits` holds the global history, and `restore_state` holds each tab's own back/forward stack.
- **Collections** are deferred to v1.2 and land in a new migration.
- **Settings** are one validated JSON document. Zod defaults make new settings forward-compatible without a migration.
- **Deliberate duplication.** `tabs.url`/`title` overlap `pages.url`/`title`. The tab needs the *exact* URL to restore, while `pages.url` is normalized and sanitized, so both are required.

### 5.4 Search and ranking

**Retrieval** runs in the worker:

```sql
-- Rank first, then join only the 200 candidates (S5: 50k-page p95 25 → 11 ms, p99 42 → 14 ms).
WITH ranked AS (
  SELECT rowid AS id, bm25(pages_fts, 10.0, 3.0, 5.0) AS text_rank   -- lower is better
  FROM pages_fts
  WHERE pages_fts MATCH :q
  ORDER BY text_rank
  LIMIT 200
)
SELECT p.id, p.url, p.title, p.site, p.favicon_id, p.last_visit_at, p.visit_count,
       p.frecency, p.frecency_at, t.id AS tab_id, t.placement, r.text_rank
FROM ranked r
JOIN pages p     ON p.id = r.id
LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed'
ORDER BY r.text_rank;
```

- `:q` is built from the user's words. Each token is double-quoted and prefix-starred (`"postgre"* "index"*`), which gives implicit AND **and neutralizes FTS5 operator syntax**, so typing `NEAR(` or `-x` can't change the query's meaning.
- **Full-text search needs at least 2 characters.** A one-character prefix matches nearly every page and cost 17–79 ms at 50k (S5); shorter input shows the recent-and-frequent list instead.
- **Title matches are marked in shared JS** on the 200 rows. They're returned as ranges that the UI renders as `<mark>` spans, and page text is never interpreted as HTML. S5 found that SQL's `highlight()` accounted for 35–40% of query cost.
- With no query, the palette shows recent and frequent pages (from the expression index in §5.3) plus open tabs.

**Ranking** is a pure function in `src/core/search` that re-scores the 200 candidates:

```text
score = 1.0 · text        (bm25, normalized over the candidate set)
      + 0.6 · log1p(frecencyNow)
      + 0.4 · titleExact  (every token matches a title word start)
      + 0.3 · siteMatch   (a token equals the site's label)
      + state boost       (open in Tabs +0.5 · Sleeping +0.3 · Archived +0.2)
```

**Frecency** uses exponential decay with a 30-day half-life:

- On each visit: `f ← f·2^(−Δt/H) + w`, where the visit weight `w` is typed 2, link 1, restore or back/forward 0.5, reload or redirect 0.
- At query time: `f_now = f·2^(−(now − f_at)/H)`.

That makes updates O(1), with no nightly recomputation.

The weights are starting points, tuned against a **golden query set** (Part 9). Every result carries its score breakdown, shown in a debug panel, so ranking stays explainable. That is the brief's "simple, explainable" requirement.

**Performance targets**, revised with spike S5 measurements on a low-end Core i3 laptop shared with other spikes, using synthetic data:

| End-to-end search (worker plus IPC round trip) | Target | S5 observed (median of 3 runs) |
|---|---|---|
| p95 at 10,000 pages | ≤ 30 ms | 12.6 ms |
| p95 at 50,000 pages | ≤ 50 ms | 23.4 ms (about 11 ms in-worker with the restructured query) |
| p99 at 50,000 pages | ≤ 60 ms | 29.3 ms |
| First query after open, 50,000 pages | ≤ 100 ms | 58 ms (cold cache) |

Phase 4 re-measures with real history data, and may tighten the 50k p95 target to 25 ms.

**Measured in M4.1** ([docs/benchmarks/search.md](../benchmarks/search.md)), end to end through the RPC inside the app, on S5's synthetic data (real history data stays the user's), median of 3 runs on the same loaded laptop:

- **10,000 pages:** p95 4.3 ms.
- **50,000 pages:** p95 10.3 ms, p99 12.8 ms, and the first search on a cold index 25 ms.

Every target is met. The 25 ms tightening of the 50k p95 is supported by that evidence but not adopted here, so the table above still applies. A first search fired while the app is still starting waits for startup's work, 134–222 ms; the write-up says why. The golden query set is `src/data/repos/search-golden.test.ts`. One of its expectations records a limit of word-start matching: `electron 45` doesn't find `v45.0.0`.

### 5.5 Write strategy

- **One worker, one connection, WAL mode.** All database work is serialized inside the worker, which is simple and correct. If writes ever delay searches, a second read-only connection in a second worker is an *additive* change, because WAL allows concurrent readers.
- **Batched persistence.** TabManager marks tabs dirty. A flush runs at most 1 s later (250 ms for structural changes such as a close or an archive), one transaction per flush.
- **Visits** are recorded on committed main-frame navigations (`did-navigate`) and on same-document navigations whose path or query changed (`did-navigate-in-page`, for single-page-app routes). Title updates are debounced to 2 s per tab.
- **Heartbeat.** `app_runs.last_heartbeat_at` is updated every 60 s.
- **Every statement is unkillable** (S5). Neither driver can interrupt a running statement. `worker.terminate()` waits for it, and so do `app.quit()` and `app.exit()`. So queries are always bounded, and maintenance (integrity checks, FTS rebuilds, incremental vacuum) runs only when idle, in small chunks or on a second worker.
- **Shutdown.** The final flush is awaited in `before-quit` against a 3 s timer. The timer runs while the event loop is alive, because one scheduled after `app.quit()` never fired in time. If the worker hasn't finished, the process hard-exits with `process.kill(process.pid)`, which took 30–180 ms in S5.
- **Loss window.** A hard kill or power loss loses at most the last 1–2 s of changes. WAL plus transactions mean it never causes corruption. S5 killed processes mid-write five times, and each database reopened with `quick_check` and the FTS integrity check passing.
- **Bulk import.** Drop the FTS triggers, load, then rebuild the index. That was about 1.5× faster at 50k pages (S5).

### 5.6 Migrations, backups, corruption handling

- **Migrations.**
  - Numbered SQL files bundled with the worker, versioned through `PRAGMA user_version`.
  - Each runs inside `BEGIN IMMEDIATE … COMMIT`.
  - A backup is taken before upgrading an existing database.
  - A database *newer* than the app is refused with a clear message (downgrade protection).
- **Backups.** A daily online backup through SQLite's backup API, taken when idle and only if the data changed. Three are kept.
- **Integrity checks.** `PRAGMA quick_check` runs after an unclean exit. A full integrity check plus FTS5's `integrity-check` runs weekly when idle.
- **Corruption.** Rename the file to `veltriva.db.corrupt-<timestamp>`, restore the newest backup, and otherwise start fresh. A banner explains what happened, and the corrupt file is kept for manual recovery.
- **Migration tests.** Fixture databases at *every* historical schema version are upgraded and verified in CI (Part 9).

### 5.7 Privacy: retention, deletion, URL hygiene

- **Retention.**
  - Visits older than 365 days are pruned (configurable).
  - Pages with no remaining visits and no tab referencing them are pruned with them.
  - Closed tabs are purged after 7 days.
- **Deletion.** The options are: one entry, "forget this site", or a time range (last hour, day, week, or everything).
  1. Each deletion runs as one transaction. Inside it, triggers remove the matching index entries, and `secure_delete` plus FTS5's `secure-delete` overwrite the freed content.
  2. After it commits, `wal_checkpoint(TRUNCATE)` and `incremental_vacuum` shrink the files on disk.

  The same dialog can also clear Chromium's cookies, cache and site storage for the browsing session.
- **Excluded sites** (`exclude_memory`) never record pages or visits. Their tabs are never auto-archived, and closing one keeps no record.
- **URL hygiene.**
  - *Identity normalization* (`url_key`): lowercase scheme and host, drop default ports, remove tracking parameters (`utm_*`, `fbclid`, `gclid`, …).
  - *Secret stripping* (`pages.url`, used for display and search): drop query parameters that look like credentials (`token`, `access_token`, `id_token`, `password`, `sig`, `signature`, `X-Amz-*`, `code` when paired with `state`, …) and any fragment containing tokens.
  - *OAuth callback URLs* aren't recorded as visits.
  - `tabs.url` keeps the exact URL needed to restore the tab, as every browser does, minus token-bearing fragments.
- **No encryption at rest.** The database file isn't encrypted, which matches mainstream browsers' history databases. We document this and rely on Windows account security and BitLocker. SQLCipher is revisited only if a real threat model calls for it.

### 5.8 Designed-for extensions (not built in the MVP)

- **v1.1 content indexing.**
  - Tables: `page_content(page_id, text, lang, content_hash, extracted_at)` plus `page_content_fts`.
  - Filled by an **opt-in** extractor (Readability-style, run in an isolated world after load, off the critical path).
  - Controlled by a per-site allow list; sensitive pages are excluded.
- **v1.2 collections and workspaces.** `collections` and `collection_items`. Multiple workspaces already exist in the schema.
- **v1.3 semantic search.**
  - `page_chunks` plus a vector table (for example sqlite-vec), filled by a local ONNX embedding model running in a utility process.
  - **Hybrid search** merges FTS candidates with vector candidates, then feeds the same re-ranker one extra feature.

**The design consequence today:** ranking is a pluggable scoring function, and search already sits behind an async worker interface.

### 5.9 Crash recovery (Question 7)

| Failure | How it's detected | How Veltriva recovers |
|---|---|---|
| App killed, crashed, or power lost | At startup, the last `app_runs` row has no `ended_at` | Run `quick_check` → rebuild the workspace from `tabs` (all UNLOADED) → load **only** the selected tab → banner: "Veltriva recovered your session" |
| Crash loop (2+ unclean exits within 60 s of startup) | `app_runs` history | **Safe mode**: restore the workspace without loading any tab and pause automation, then offer "Resume normally" |
| A tab's renderer crashes or is killed for memory | `render-process-gone` | Tab → CRASHED; crashed-tab page with Reload; an out-of-memory kill also raises the memory-pressure level |
| A page hangs | `unresponsive` | "Page isn't responding — Wait / Reload" |
| The GPU process crashes | `app` `child-process-gone` | Chromium restarts it and we log it. Repeated crashes suggest turning off hardware acceleration (applies after restart) |
| Unhandled exception in main | `uncaughtException` | Log, attempt a final flush, exit; the next start recovers as above |
| Database corruption | Open or `quick_check` failure | §5.6 |
| Restore interrupted by a crash | Tab still UNLOADED or CREATING | The restore snapshot is only replaced after a successful commit, so the restore simply runs again |

The brief's six recovery steps (§8.3) map onto this design:

1. Detect the previous session through `app_runs`.
2. Load tab metadata from `tabs`.
3. Restore the workspace's placements.
4. Load nothing except the selected tab.
5. Restore other tabs lazily, through `ensureLive` on selection.
6. Never load archived tabs.

Local crash dumps, using Electron's `crashReporter` with uploading disabled, are an opt-in diagnostic and are never sent anywhere.

---

## Part 6 — Security Model (Questions 9 and 10)

### 6.1 Principles

1. **Web content is hostile.** It gets no Veltriva API, no Node and no preload.
2. **Our own UI has least privilege.** It's sandboxed and locked down by CSP, and it reaches main only through a narrow, validated contract.
3. **Deny by default.** That covers permissions, devices, popups without a gesture, external protocols, and any navigation of privileged contents.
4. **Patch fast.** An outdated Chromium is the largest real-world risk to users.
5. **Privacy is a security property.** No telemetry, local-only suggestions, minimal logs.

### 6.2 Hardening configuration

```ts
// Every tab: untrusted web content
const TAB_WEB_PREFERENCES: WebPreferences = {
  partition: 'persist:browsing',   // one-way door: renaming it would log users out (Part 10.2)
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  safeDialogs: true,               // Chrome-style protection against dialog spam (off by default)
  spellcheck: true,
  backgroundThrottling: true,
  // deliberately no `preload`
};

// The trusted shell UI
const SHELL_WEB_PREFERENCES: WebPreferences = {
  preload: SHELL_PRELOAD_PATH,     // exposes only the typed command API (§3.5)
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  devTools: !app.isPackaged,
};
```

**Application level:**

- `app.enableSandbox()` and a single-instance lock.
- An `app.on('web-contents-created')` guard that assigns every web contents a role and attaches the matching policy.
- On *every* session: a permission **request** handler, a permission **check** handler, a device-permission handler, a display-media handler and a Bluetooth chooser listener. Electron's defaults grant everything, so each one is required. The shell session denies everything.
- The `app://shell` protocol is registered as privileged but handled **only on the shell session**. Electron registers protocol handlers per session, so web pages in `persist:browsing` can't load it. It serves files from the bundled renderer directory with path-traversal protection, and checks the unspoofable `request.initiatorOrigin`.

**Production Content Security Policy for the shell.** The `app://` handler sends it as a response header rather than a `<meta>` tag, so directives such as `frame-ancestors` actually apply:

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

If a UI library injects `<style>` elements, `style-src` relaxes to `'self' 'unsafe-inline'`. **`script-src` never relaxes.**

**Electron fuses**, flipped at package time through electron-builder's `electronFuses` key, with no extra dependency:

| Fuse | Electron default | Veltriva | Why |
|---|---|---|---|
| `RunAsNode` | on | **off** | Stops `ELECTRON_RUN_AS_NODE` from turning the signed app into a general-purpose Node runtime |
| `EnableCookieEncryption` | off | **on** | Cookies encrypted at rest with DPAPI. **One-way:** Electron's docs warn that turning it off later corrupts the cookie store |
| `EnableNodeOptionsEnvironmentVariable` | on | **off** | Blocks `NODE_OPTIONS` injection |
| `EnableNodeCliInspectArguments` | on | **off** | Blocks `--inspect` on the packaged app. Playwright needs it on, so E2E tests run against the unpackaged build (§9.2) |
| `EnableEmbeddedAsarIntegrityValidation` | off | **on** | Detects tampering with `app.asar` |
| `OnlyLoadAppFromAsar` | off | **on** | Pairs with integrity validation |
| `GrantFileProtocolExtraPrivileges` | on | **off** | We never load app code from `file://` |
| `LoadBrowserProcessSpecificV8Snapshot` | off | off | Not used |
| `WasmTrapHandlers` | on | on | Default since Electron 41; keeps WebAssembly fast and safe |

### 6.3 IPC security

The contract is in §3.5. In summary:

- A **single entry point**.
- **Allow-listed commands** with strict Zod schemas.
- **Sender verification** on frame, contents ID and origin.
- **No generic channels** and **no `ipcRenderer` exposure**.
- **Errors without stack traces.**
- **Tab renderers have no channel at all.**

A *hostile fixture page* in the E2E suite tries to reach `window.veltriva`, `require`, `process`, `app://` URLs and privileged navigations, and the test asserts that every attempt fails.

### 6.4 Navigation, popups, protocols, permissions, downloads

| Web contents role | Navigation (`will-navigate`, `will-frame-navigate`, `will-redirect`) | `window.open` | `<webview>` | Permissions |
|---|---|---|---|---|
| Shell UI | always blocked | always denied | blocked | all denied |
| Tab | `http(s):`, `about:blank`, and `blob:` documents whose origin is a web origin (M1.3a). Subframes may also load `about:srcdoc`, `data:`, any `blob:`, and the PDF viewer, `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`, since blocking it renders PDFs blank (S7); its ID is re-checked on every Electron upgrade. Top-level `data:` and opaque `blob:null/…` documents are blocked, as are `veltriva:` and `app:`; other schemes go to the protocol guard | §3.7 policy, plus a scheme check (S7: `window.open('custom:…')` arrives here, not as `openExternal`) | blocked | broker |
| Popup window | as Tab | opens tabs | blocked | broker |
| DevTools | Electron-managed | denied | blocked | denied |

**The permission broker.** Electron forwards every Chromium permission type, about 46 names today. The broker therefore uses an **allow-list**: anything not named below is denied.

- **Prompt**, remembering the decision per origin, for `media` (camera and microphone), `geolocation`, `notifications` and `clipboard-read`.
- **Allow** `clipboard-sanitized-write`, and `fullscreen` in tabs (with an exit notice that shows the origin).
- **`pointerLock` stays denied in the MVP** (decided in M1.4a): a hidden, captured pointer helps a page pass itself off as the desktop (T6), and there is no notice for it yet. Revisit with a fullscreen-style notice if users need it.
- **No prompt for embedded pages from other sites,** popup windows or insecure origins: those requests are denied without asking (ADR-0002, item 9).
- **Deny** in the MVP, among others: `display-capture` (Windows needs a custom `desktopCapturer` picker, after the MVP), `midiSysex`, `hid`, `serial`, `usb`, `idle-detection`, `window-management`, `local-network-access`, `storage-access`, `top-level-storage-access`.
- `openExternal` is refused as a backstop. Page navigations to other apps are caught in `will-frame-navigate` and `will-redirect`, which name the frame correctly, and handed to the protocol guard below (measured in M1.4a).

**The external-protocol guard:**

- A short list of schemes is **always blocked**, the Follina-class remote-execution vectors: `ms-msdt:`, `search-ms:`, `search:`, `ms-officecmd:`, `ms-cxh:`, `ms-cxh-full:`, `ms-appinstaller:`, `vbscript:`, `javascript:`, `jar:`, `file:`.
- Everything else needs a recent user gesture and a prompt naming both the site and the app ("zoom.us wants to open *Zoom*"), with an optional per-site "always allow".
- The launch goes through `shell.openExternal` **only** after the URL is parsed and validated.

**Downloads:**

- Save to the Downloads folder with unique file names.
- Mark-of-the-Web is written by Chromium itself as `ZoneId=3` with `HostUrl=about:internet` (S7; 11 download variants, including HTTPS). It marks files as coming from the Internet zone, which SmartScreen and Office Protected View key on, but it records no source or referrer. The antivirus hand-off through Attachment Execution Services wasn't observable; the packaged-build check repeats it with Defender active.
- Nothing is auto-opened.
- These types need an extra confirmation: `.exe .msi .msix .appx .bat .cmd .com .scr .ps1 .vbs .js .jse .wsf .hta .lnk .reg .jar .iso .img .vhd .vhdx`.

### 6.5 Threat model (initial)

| # | Threat | Vector | Mitigation | Residual risk |
|---|---|---|---|---|
| T1 | A page compromises its renderer | Chromium memory-safety bug | Sandbox, site isolation, no Node, fast Electron updates | 0-days; the window before we ship a patched build |
| T2 | A page reaches privileged APIs | Preload or IPC exposure | No preload for web content; sender and schema checks; hostile-page E2E test | None known by design |
| T3 | A page pivots into the shell | Shell navigation, `window.open` from the shell | Shell navigation blocked, popups denied, CSP | Low |
| T4 | XSS in our UI via page data | Titles, URLs | React escaping; lint ban on `dangerouslySetInnerHTML`; highlight markers aren't HTML | Low |
| T5 | Shell compromise through image decoding; requests into the local network | Malicious favicon, or a favicon URL on a local host | Main fetches favicons through the browsing session with a 64 KB cap, accepts only raster formats it recognizes by their magic bytes (no SVG), and hands the shell a `data:` URL it built itself, so the shell never loads a remote image (M1.3a). Main's fetch skips Chromium's local-network-access check, so main refuses favicon URLs on loopback, private and link-local addresses and on local-only names (single label, `.local` and similar), unless the page is on the same kind of host (M1.3b, `src/core/url/local-network.ts`). **Stored favicons (M2.2b)** keep those sniffed bytes and their type, deduplicated by SHA-256; the data worker sniffs them again before storing, and main never decodes them (an ESLint rule bans `nativeImage` in `src/main`). Post-MVP: decode and re-encode with a memory-safe JS decoder | Moderate until re-encoding lands. Impact: history readable through IPC. **DNS rebinding:** the check classifies names as written, so a public name that resolves to a private address still gets a request. Closing it needs a resolver-level check, such as resolving first and refusing private results |
| T6 | UI spoofing | Fake browser chrome in fullscreen, chromeless popups, imitation prompts | Fullscreen notice with origin, built from the committed URL and drawn above the page for 4 s; Esc always leaves fullscreen, and main can end it whatever the page's script does (M1.3b, ADR-0002 item 8). Popups always show a URL bar; prompts anchored in the toolbar, outside the page area | Low |
| T7 | Phishing and homographs | IDN hosts, `user@host` URLs | Punycode display; userinfo stripped and warned | No Safe Browsing list (documented gap) |
| T8 | Malicious downloads | Drive-by downloads | No auto-open, Mark-of-the-Web and SmartScreen, dangerous-type confirmation | A user can still choose to run malware |
| T9 | External-protocol abuse | `ms-msdt:` and similar | Blocklist + gesture + prompt | New dangerous schemes until listed |
| T10 | Local data theft | Malware running as the same user | Cookie encryption (DPAPI), data minimization, no secrets in logs | The database is readable by same-user malware, as in mainstream browsers |
| T11 | Sensitive data in the memory index | Tokens in URLs, private pages | URL hygiene, site exclusions, no content indexing in the MVP, secure deletion | Unusually named secret parameters may slip through |
| T12 | Supply-chain compromise | Malicious dependency or install script | Few dependencies, lockfile, `npm ci`, Renovate or Dependabot, reviewed install scripts, GitHub Actions pinned by SHA, CodeQL | Can't be eliminated |
| T13 | Tampered binary or update | Modified asar, intercepted update | ASAR integrity fuse, code signing, signed updates | Builds are unsigned until signing is set up |
| T14 | Stale Chromium | Not shipping updates | Written upgrade policy (§10.1); update notification before any public release; auto-update once signed | Depends on maintainer availability |
| T15 | Debug surfaces | `--inspect`, remote debugging, `NODE_OPTIONS` | Fuses; no debugging port in production; test hooks compiled out | Low |

### 6.6 Privacy posture

- No telemetry, no analytics SDKs, no crash uploads. Crash dumps, if enabled, stay local.
- **Network activity is limited to** the user's own browsing and the search engine on submit, plus update checks once they exist, which can be turned off. There is no suggestion service.
- **Background traffic from bare Electron** (S7: 20 s capture on a fresh profile). It made **no external HTTP requests**. It did two network-level things, which we disclose rather than suppress:
  - **WPAD lookups:** Windows proxy auto-detection. Disabling it would break users behind proxies.
  - **One UDP connect to `2001:4860:4860::8888`:** Chromium's IPv6 reachability probe, which sends no request data.
- **One Electron default to fix: spellcheck dictionaries.** On the test machine, en-US used Windows' own spellchecker with no download. Languages Windows doesn't provide fetch Hunspell dictionaries from `redirector.gvt1.com` by default. Veltriva points `setSpellCheckerDictionaryDownloadURL` at dictionaries we host alongside our releases; S7 verified the override works.
- **Logs** record tab IDs and error codes by default. URLs appear only when the user enables diagnostic logging. Files rotate at 5 × 5 MB.
- **User controls:** clear ranges, forget a site, exclude sites, and a **"Pause memory"** toggle that stops recording history without opening a private window.
- **Future private windows** use in-memory partitions and are barred from the database by invariant I6.

### 6.7 Residual risks, stated honestly

These are documented in the README's *Known limitations*:

- Chromium vulnerabilities between upstream fixes and our release.
- No Safe Browsing protection against phishing or malware.
- The database isn't encrypted at rest.
- DPAPI doesn't stop malware running as the same user.
- Unsaved-work detection is heuristic.
- The favicon decoding exposure until re-encoding lands.
- Unsigned builds until code signing is in place.

---

## Part 7 — MVP Scope (Question 11)

### 7.1 Definition

> **The MVP is the smallest browser you'd keep open all day for research: one where you never close a tab by hand and can always find it again.**

"Genuinely usable" sets the floor. Without find-in-page, zoom, context menus, downloads, popups for sign-in, permission prompts and session restore, people bounce off in the first hour, however good the tab memory is.

### 7.2 Must / Should / Could / Won't

**Must (v1.0)**

| Area | Features |
|---|---|
| Browsing | Single window. Tabs: new, close, select, reorder, pin, duplicate, reopen closed. Back, forward, reload, stop. Omnibox (URL or search, local suggestions). Loading state, titles, favicons. Find in page. Zoom. Context menus. Reserved shortcuts. HTML fullscreen. Error pages. Crashed-tab page. JS dialogs and file chooser. Print. DevTools for pages (F12) |
| Web plumbing | Downloads (basic manager). Permission prompts. Popups (tabs, plus popup windows that preserve the opener for OAuth). External-protocol prompts. Certificate-error page |
| Lifecycle | Engagement clock. Discard and restore with navigation history. Sleeping shelf. Archive (auto and manual) with Undo. Protection engine v1. Automation pause. Activity log |
| Persistence | SQLite data worker. Session restore with lazy loading. Crash recovery and safe mode. History (pages and visits). Migrations. Backups |
| Search | FTS5 over titles, URLs and sites. Ranking v1. Ctrl+Shift+K palette with keyboard navigation and filters (state, time, site). Memory suggestions and switch-to-tab in the omnibox. Virtualized Archive list |
| Settings and privacy | Lifecycle presets plus advanced thresholds. Site rules (protect, exclude). Clear memory and site data. Default search engine. Startup behavior |
| Release | NSIS installer. Fuses. About page with versions and licenses. Update-available notification before any public release |

**Should:** an HTTP-auth prompt; scroll position restored across restarts (non-sensitive); a "Pause memory" toggle; per-tab memory display (also great for demos); a dark theme; first-run onboarding (search engine, preset, preview mode); the freeze experiment behind a flag; regret rate on a diagnostics page; silent auto-update once builds are signed.

**Could:**

- A custom title bar, with tabs and toolbar in the caption area. `BaseWindow` supports `titleBarOverlay`, but a lower view's drag region currently swallows clicks in views stacked above it. The fix merged to Electron's main branch on 2026-10-15 and isn't in a release yet.
- Tab hover previews.
- Importing open tabs or bookmarks from Chrome.
- Exporting memory as JSON or HTML.

**Won't, for the MVP** (roadmap candidates):

- Multi-window and tab drag-out.
- Private windows. The architecture is already ready for them.
- Sync, extensions, password manager and autofill.
- Safe Browsing.
- Ad and tracker blocking. The candidate is `@ghostery/adblocker-electron` (MPL-2.0, maintained, tested against Electron 44). It needs a design review first: it injects a preload into web pages and takes over the session's `webRequest` hooks, of which Electron allows only one listener per event. Both conflict with §6.
- Content indexing (v1.1), collections and workspaces UI (v1.2), semantic search (v1.3).
- Thumbnails, DRM video, a screen-share picker, macOS and Linux.

### 7.3 UI concept

**Recommendation: a vertical sidebar with three sections, *Tabs · Sleeping · Archive*.** It makes the product's mental model visible at a glance, keeps long titles readable, and scales to many tabs. A horizontal strip plus a separate memory panel is the familiar alternative, and it's *decision D4* in Part 11.

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ◀  ▶  ⟳  │ 🔒 postgresql.org/docs/current/indexes.html                 │  ⌕  ⋮  │
├────────────────────┬─────────────────────────────────────────────────────────────┤
│ ⌕ Search memory…   │                                                             │
│ PINNED             │                                                             │
│  ● Gmail           │                                                             │
│  ● GitHub          │                                                             │
│ TABS               │                page content (WebContentsView)               │
│  ▸ PostgreSQL: In… │                                                             │
│  ◌ Understanding … │                                                             │
│  ● YouTube   ♪     │                                                             │
│  + New tab         │                                                             │
│ SLEEPING (12)   ▾  │                                                             │
│ ARCHIVE (55)    ›  │                                                             │
│ ⏸ Automation: on   │                                                             │
└────────────────────┴─────────────────────────────────────────────────────────────┘
  ● live    ◌ unloaded (reloads on click)    ♪ playing audio — kept awake
```

**The memory palette (Ctrl+Shift+K).** The brief's example showed a *Collection* label. In the MVP that label is replaced by the site and the tab's state, because collections arrive in v1.2.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ⌕ postgres index                                                     │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ PostgreSQL Documentation — Indexes                 ● Open (Tabs)   │
│   postgresql.org · visited 3 days ago                                │
│   Understanding EXPLAIN ANALYZE                      ☾ Sleeping      │
│   thoughtbot.com · visited 3 days ago                                │
│   Database Query Optimization Guide                  ▣ Archived      │
│   use-the-index-luke.com · visited 4 days ago                        │
├──────────────────────────────────────────────────────────────────────┤
│ ↵ switch / restore   Ctrl+↵ open in new tab   Tab: All·Open·Sleeping·Archived·Today │
└──────────────────────────────────────────────────────────────────────┘
```

**Accessibility:**

- Everything is reachable by keyboard.
- ARIA patterns: `listbox`/`option` for the palette, `tree` for the sidebar.
- Visible focus rings and WCAG AA contrast.
- `prefers-reduced-motion` is respected; there is very little motion to begin with.
- State icons have text equivalents ("Unloaded", "Playing audio").

### 7.4 MVP acceptance criteria

1. With 100+ tabs over a week of real use, you never *need* to close a tab manually. The strip stays at its cap, except for tabs used recently.
2. Every tab that left the strip can be found with a few partial words from its title, URL or site, and restored in one action. Search latency meets the targets in §5.4, or the targets are revised with measurements.
3. No automated action ever touches a tab with a hard protection. Fixture tests cover every protection signal.
4. A hard kill at any moment loses at most about 2 s of changes. Relaunch restores the workspace and loads only the selected tab.
5. With 50 fixture tabs, "discarded" mode uses measurably less total private memory than "all live" mode. Numbers are published with their method; nothing is claimed before it is measured.
6. The security checklist passes, and the hostile-page fixture can't reach any Veltriva API.
7. The installer works on clean Windows 10 and Windows 11 virtual machines.

---

## Part 8 — Development Roadmap

### 8.1 Changes from the brief's phase order

**Persistence moves before lifecycle.** There are three reasons:

1. Archiving without persistence would lose archived tabs on every restart, so lifecycle work would have to build throwaway storage first.
2. The restore snapshot is a *persisted* artifact. Its format belongs to the data design, not the other way round.
3. Session restore makes Veltriva **dogfoodable** after Phase 2. Daily real use is the only way to tune the lifecycle defaults, which are the product's riskiest guesses.

### 8.2 Phases, milestones and acceptance

Effort assumes one developer at 15–20 h/week.

| Phase | Milestones | Depends on | Acceptance | Hours | Weeks |
|---|---|---|---|---|---|
| **0 · Architecture & spikes** | Approved proposal → ADRs 0001–0008; spikes S1–S8 (§8.3); repo initialized with docs | — | Every spike has a written result; every failed assumption has a recorded fallback | 35–50 | 2–3 |
| **1 · Browser foundation** | **M1.1** scaffold and CI (electron-vite, strict TS, React, Tailwind, shadcn, ESLint, Vitest, Playwright smoke, Windows CI). **M1.2** secure shell (BaseWindow, `app://shell`, CSP, preload, IPC router and contract, web-contents guard, fuses, hostile-page test). **M1.3** tabs and navigation (TabManager with live tabs only, TabRuntime, LayoutManager, omnibox, sidebar v1, shortcuts, context menus, find, zoom, fullscreen, DevTools). **M1.4** web plumbing (permission broker, popups with opener, external protocols, downloads, error, crash and certificate pages, new-tab page) | 0 | Real sites browse correctly in multiple tabs. E2E on local fixtures covers open, switch, close, navigate, history, popup, download and permission flows. Security tests pass | 110–140 | 6–8 |
| **2 · Persistence & session restore** | **M2.1** data worker, RPC, migration runner, schema 0001, repositories, backups, corruption handling. **M2.2** session persistence, lazy startup restore, crash detection and safe mode, history recording with URL hygiene, settings storage, Recently closed | M1.3 | 20 scripted hard kills at random moments all restore cleanly. Only the selected tab loads at startup. Migration tests pass. Profiling shows no database work on the main thread. **→ Milestone 0.1: daily dogfooding** | 60–80 | 3–5 |
| **3 · Lifecycle & protection** | **M3.1** runtime state machine, discard/restore with navigation history, per-tab queues and epochs, model-based tests. **M3.2** activity tracking, engagement clock, policy engine, scheduler, memory-pressure discard. **M3.3** Sleeping and Archive UI, Undo, activity log, manual archive, protect and pin. **M3.4** protection monitor v1, probes, "why" explanations, preview mode | 2, S1–S3 | With 50 fixture tabs and an accelerated clock, actions exactly match policy. Protected fixtures (audio, `beforeunload`, dirty form, open popup) are never discarded. 10,000-step model-based runs show no invariant violations. Memory reduction measured and published with the method in §9.3 | 90–115 | 5–7 |
| **4 · Searchable memory** | **M4.1** FTS5 query builder, ranking v1 with golden set, synthetic dataset generator (1k, 10k, 50k), benchmarks. **M4.2** Ctrl+Shift+K palette (overlay strategy from S4), filters, keyboard navigation, highlighting, omnibox memory suggestions and switch-to-tab, virtualized Archive list | 2, 3 | Latency targets met, or revised with evidence. E2E: archive → search by partial words → restore. Golden-set ranking tests pass | 50–70 | 3–4 |
| **5 · Settings, privacy & control** | Settings UI (presets and advanced), site rules, clear-data flows (database and Chromium storage), Pause memory, permission management, startup behavior, diagnostics page (regret rate, memory per tab) | 3, 4 | Every automatic action is explainable and reversible from the UI. Tests verify deletion: rows, index entries and file shrink. Invalid settings are rejected | 40–55 | 2–3 |
| **6 · Quality & release** | Benchmark report (10, 25, 50, 100 tabs × 3 modes). Security review (checklist, threat-model re-check, dependency and **license audit**). Accessibility pass. NSIS installer with fuses and ASAR integrity. Signing, if approved. Update notification. README, architecture docs, screenshots and GIFs, release notes. Manual release workflow (tag → build → draft release) | all | Clean install on Windows 10 and 11 VMs. Reproducible benchmark report. Known limitations documented. CI green | 55–75 | 3–4 |
| **Total** | | | | **440–585 h** | **~25–33 weeks** |

**Progress, 2026-10-22.** Phases 0, 1 and 2 are done; **Milestone 0.1 (daily dogfooding) is reached**. Each Phase 2 acceptance criterion above, with its evidence and the test that proves it, is in [the Phase 2 plan's as-built record](../plans/phase-2-plan.md#milestone-01-acceptance-assessment-82); the hands-on checks are in `docs/testing/phase-2-manual-checks.md`. Still open from earlier phases: S7's OAuth-popup check (M2), and the manual checklists, which the user runs at the end.

**Progress, 2026-10-22 (Phase 3).** Phase 3 (lifecycle and protection) is done: each acceptance criterion above, with its evidence, is in [the Phase 3 plan's as-built record](../plans/phase-3-plan.md#phase-3-acceptance-assessment-82), and the memory measurement's method and status in [docs/benchmarks/phase-3-memory.md](../benchmarks/phase-3-memory.md): its harness is built, but the reference laptop was too loaded on 2026-10-22 to finish a run, so that criterion is still open. Two parts of later phases came early at the orchestrator's request: the regret metric and its diagnostics page (Phase 5). The hands-on checks are in `docs/testing/phase-3-manual-checks.md`. Phase 4 is next.

At 15–20 h/week that's **about 6–8 months**. Add 15–20% contingency for Electron surprises. Daily dogfooding starts around **week 11–16**. Subagent assistance may shorten the *coding* hours, but review, debugging, dogfooding and decisions don't shrink the same way, so I plan against the full estimate and treat any speed-up as buffer.

### 8.3 Phase 0 spikes

Each spike is time-boxed throwaway code in `spikes/`, never shipped. Each ends with a short report in `docs/spikes/`.

| Spike | Question it answers | Time box | If it fails |
|---|---|---|---|
| **S1** View lifecycle | Do detached or hidden views report `hidden` and get throttled on **Windows**? Electron doesn't document view visibility, and Linux had a regression in 44.0–44.5 where re-added views reported `hidden`. Does `removeChildView` + `close()` free the renderer (measured with `getAppMetrics`)? Do the media and input events fire as documented, including inside cross-process iframes? | 4 h | Explicit `setBackgroundThrottling` plus earlier discard; change the view-hiding method |
| **S2** Restore fidelity | Does `navigationHistory.restore` bring back the back/forward stack, scroll and form values, both from in-memory page state and from persisted URL/title-only entries? | 4 h | Fall back to `loadURL` plus our own scroll capture; document the reduced fidelity |
| **S3** Unsaved-work detection | Confirm on a real build what Electron's source says: `close({ waitForBeforeUnload })` cancels silently when the page objects, and an untouched page closed directly never runs `beforeunload`. How accurate is the isolated-world probe on plain, React and `contenteditable` forms? | 4 h | Treat any registered `beforeunload` as a protection; widen the interaction guard |
| **S4** Overlay strategy | Snapshot takeover vs overlay view: latency, flicker, focus, visibility side effects | 6 h | Option B or C from §3.3 |
| **S5** Data stack | better-sqlite3 13 in a worker thread, in dev and in a packaged NSIS build: does it install with no compiler (`--ignore-scripts`), does the worker script load from inside `asar`, does the same binary load under Vitest on Node 24? FTS5 latency at 50k rows; `node:sqlite` run side by side | 6 h | Switch to `node:sqlite` behind the same interface |
| **S6** Test reach | Confirm in *our* layout what Playwright documents: shell and tab views are reachable as Pages, `electronApp.evaluate` reaches main-process hooks, and runs on the Windows CI runner are stable | 2 h | Main-process hooks plus a direct CDP connection for tab content |
| **S7** Web compatibility | Google sign-in (with a user-agent policy), GitHub OAuth popup, YouTube (fullscreen, background audio), PDF, downloads with Mark-of-the-Web, `window.open` without a gesture, `mailto:`/`zoommtg:`, no background network calls | 4 h | Document each gap; adjust MVP messaging |
| **S8** Measurement method | `getAppMetrics` private bytes vs Windows process-tree counters; run-to-run variance | 3 h | Pick the stabler source; widen the run count |

**Outcome (2026-10-16): all eight spikes ran.** None failed outright, and none forced a fallback platform or driver. S1, S5 (with amendments) and S8 confirmed their assumptions. S2, S3, S6 and S7 changed specific procedures, and S4 replaced the overlay plan with a better option. Each change is recorded in the ADRs; results are in [docs/spikes](../spikes/README.md). S7's four manual web-compatibility checks (Google sign-in, an OAuth popup, YouTube, a real PDF) still need a person to run them.

### 8.4 How the work splits across subagents

You asked for subagent-driven development. Here is how it will run:

| Role | Model and effort | Typical tasks |
|---|---|---|
| **Orchestrator** (me) | Opus | Architecture, ADRs, contracts and interfaces; security-sensitive code (IPC router, sender validation, web policy, protocol guard); the lifecycle engine core; **reviewing every diff**; integration; running the app and the test suites myself before reporting anything as done |
| **Implementers** | Sonnet, extra-high effort | Well-bounded modules against a written interface, *with their tests*: the omnibox classifier, data worker and repositories, FTS search and benchmarks, sidebar, palette, download manager, prompts UI, E2E specs |
| **Helpers** | Haiku, max effort | Mechanical and bulk work: fixture pages, synthetic datasets, adversarial test tables, docs formatting, dependency, version and license audits |

**Rules for every brief:**

- One **owner per file set**; parallel agents never touch the same files.
- Each brief states the goal, the files owned, the interfaces, the constraints (security rules, no new dependencies without approval) and the exact acceptance commands.
- Every agent reports which commands it ran and their output.
- Nothing is marked done until I've re-run the tests myself.

---

## Part 9 — Testing Strategy

### 9.1 Shape

```text
              ▲     manual dogfooding · benchmark harness (from Phase 2 / 3)
             ▲▲▲    E2E: Playwright + Electron against a local fixture server
           ▲▲▲▲▲    integration: data worker, migrations, TabManager with fake runtimes
       ▲▲▲▲▲▲▲▲▲    unit + property/model-based: src/core (policy, state machine, URL, ranking)
```

### 9.2 What each layer covers

- **Unit tests (Vitest)**
  - Lifecycle rules, per rule and per preset.
  - Engagement-clock arithmetic, including active days across midnight and DST changes.
  - Every protection signal.
  - Every legal runtime transition, and rejection of illegal ones.
  - The omnibox classifier, against a table of ~200 inputs, including adversarial ones: `javascript:alert(1)`, `JaVaScRiPt:`, `data:text/html,…`, IDN homographs, `user:pass@host`, IPv6 literals, `localhost:3000`, `foo bar`, `1.1`, embedded newlines, oversized input.
  - URL normalization and secret stripping.
  - Ranking, against a golden query set.
  - Settings and IPC schemas, including rejection of unknown keys.
- **Property and model-based tests (fast-check).** Random sequences of `create`, `select`, `close`, `archive`, `restore`, `discard`, `tick(Δt)`, `navigationStart`/`Commit`, `rendererCrash` and `beforeunloadBlock` run against fake tab runtimes. Async completions are deliberately reordered with fast-check's `fc.scheduler()` and `scheduledModelRun`, and invariants I1–I8 are checked after every step. This covers the brief's reliability scenarios (rapid switching, closing during restore, archiving mid-navigation, duplicate restores) far more thoroughly than hand-written cases.
- **Integration tests (Vitest on Node 24, same N-API SQLite binary as the app)**
  - Migrations from every historical schema version.
  - Repository behavior.
  - FTS consistency (`INSERT INTO pages_fts(pages_fts) VALUES('integrity-check')`).
  - Deletion purges index entries.
  - Retention jobs.
  - Corruption recovery: a garbled file is recovered from backup.
  - **Crash consistency:** a child process is killed mid-transaction in a loop, followed by integrity checks.
- **E2E tests (Playwright + Electron).**
  - **Fixtures.** A local server serves deterministic pages: an article, a long-scroll page, a form, a page with `beforeunload`, generated audio, a local video, an OAuth-style popup opener using `postMessage`, downloads (a fake `.exe` and a PDF), permission requests, a slow page and a hostile page.
  - **Scenarios.** Startup; tabs; navigation and history; omnibox; archive → search → restore; automation under an accelerated clock; protections holding; restart and crash recovery; downloads; permissions; popups; external-protocol prompts; find in page; shortcuts.
  - **No external sites are needed for any critical test.**
- **Test hooks.** Test builds expose `advanceClock`, `getTabStates`, `setMemoryPressure` and `crashRenderer`. They're compiled out of production, and a packaging test asserts they're absent.
- **Playwright rules (S6).**
  - **Locate pages by identity, never by position.** Use the shell URL and each tab's DevTools target ID, because page order is random.
  - **Register `waitForEvent('window')` before opening a tab.**
  - **Act on tabs only while they're attached.** Detached views produce no frames.
  - **Never `page.close()` a tab.**
  - **Launch through `executablePath`.** Playwright's own loader turns off renderer backgrounding.
- **Lifecycle behavior tests run without Playwright.** Playwright's per-page focus emulation makes hidden and detached tabs report `visible`, with unthrottled timers (S6). Visibility, throttling, renderer release, restore fidelity and `beforeunload` behavior are therefore asserted by a small Electron-script harness like the Phase 0 spikes, with the test window always on top.
- **What E2E runs against.** Playwright's Electron launcher times out when the `EnableNodeCliInspectArguments` fuse is off, and production turns it off (§6.2). E2E therefore runs against the **built but unpackaged** app. The production installer gets its own smoke test without Playwright: install, launch, read back the fuses, check no test hooks exist, uninstall. Two more cautions from Playwright's tracker:
  - An inherited `ELECTRON_RUN_AS_NODE` breaks launches, so the test environment clears it.
  - Playwright 1.64.0 has an open regression where a packaged app's first window is sometimes not reported. We pin the Playwright version and upgrade deliberately.
- **Security tests.**
  - The hostile page.
  - Malformed IPC payloads sent to every handler.
  - Navigation guards.
  - The protocol blocklist.
  - Fuse state read back from the packaged binary.
- **Accessibility.** `@axe-core/playwright` on shell views, plus a keyboard-only walkthrough.

### 9.3 Benchmark methodology (Question 12)

- **Environment.** Record the reference machine (CPU, RAM, Windows build). Run on AC power with a fixed power plan, no other apps, and a fresh profile per run. Note whether Defender real-time scanning is on.
- **Corpus.**
  1. Synthetic fixtures with controlled cost: DOM size, JS heap, timers.
  2. A local snapshot of about 30 **openly licensed** real pages (Wikipedia, MDN, Python and PostgreSQL docs) served by the fixture server.
  3. Dynamic sites (Gmail, YouTube), measured manually and labeled as such.
- **Scenarios.** 10, 25, 50 and 100 tabs, each in three modes:
  - **A — all live**, automation off.
  - **B — visually collapsed**: shelved but still live. This mode *demonstrates* that visual organization alone saves nothing.
  - **C — discarded or archived.**
- **Metrics.**
  - Private bytes and working set across the whole process tree, broken down by process type: browser, GPU, utility, shell, tabs.
  - CPU averaged over 60 s of quiescence.
  - Tab-switch latency, live vs unloaded.
  - Restore latency.
  - Search latency at p50, p95 and p99.
  - Startup time: process start → shell ready → first tab committed.
  - Database size.

  **Spike S8 settled the method.** The headline number is the **sum of private bytes** across the process tree, read with `app.getAppMetrics()`:
  - it matched Windows' own counters exactly for every process;
  - it missed no process;
  - it varied by only 0.5–1.3% across five fresh launches.

  Working set counts shared pages once per process, so it came out about 2.3× private memory and varied by 9%; it's reported only as a secondary number. Cross-browser comparisons use the Windows counters, because they apply to any browser.

  S8 reference numbers: Electron alone uses 62 MB private, 20 light fixture tabs 886 MB, and discarding 19 of them frees 762 MB (about 40 MB per tab).

  One trap: `getAppMetrics()` reports CPU as an average *since the previous call, by any caller*. So a single MetricsService owns all polling, and everything else reads from it. Measurement tools must also stay out of the measured process tree, or be excluded from it.
- **Protocol.** One warm-up run, discarded. Then 5 measured runs, reporting the median and the range. Raw CSVs and scripts are published so anyone can reproduce the results. **No number is ever published without its method.**
- **Optional cross-browser comparison.** Run Chrome or Edge on the same corpus with the same Windows counters, with their memory savers off (for "all live") and then on (for "their automation"). Document the interpretation caveats: shared memory, GPU-process differences, and Electron's extra shell renderer.

### 9.4 Continuous integration (GitHub Actions, `windows-latest`)

- **Every PR.** `npm ci`, typecheck, lint, unit, integration, lifecycle-behavior and E2E tests, plus a license check. S6 ran 10 clean Playwright cycles locally; the first CI runs confirm the same on the Windows runner.
- **`main`.** Adds an unsigned NSIS build as an artifact, with fuse verification.
- **Manual or scheduled.** Benchmarks.
- **Releases.** Manual tag → build → sign (once available) → **draft** GitHub release. Nothing is published automatically.
- **Coverage.** `src/core` ≥ 90% of lines and branches; the data layer ≥ 80%. The UI is held to critical-flow E2E coverage rather than a percentage.

---

## Part 10 — Risks and Trade-offs

### 10.1 Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Electron lifecycle behavior differs from the docs (visibility, restore fidelity, `beforeunload`) | Medium | High | Spikes S1–S3 before Phase 3; fallbacks written down |
| R2 | **Discarding loses user work** (false negatives) | Medium | **Critical, because it destroys trust** | Conservative defaults, layered protections, in-run page-state restore, Undo, preview mode, regret metric |
| R3 | Web-compat gaps (Google sign-in, DRM, PDF, popups) block daily use | Medium | High | Spike S7, user-agent policy, documented limits; castlabs' DRM-enabled Electron fork evaluated after the MVP |
| R4 | Chromium patches lag once the app is public | Certain without a process | High | **Upgrade policy:** move to each new Electron major within 4 weeks, after native-module and E2E checks on a branch; apply security patch releases within 7 days once there are public users; update notification before the first public release; auto-update once builds are signed |
| R5 | Native-module friction (install-time compiling, packaging) | Low–medium, now that better-sqlite3 is N-API | Medium | S5, `--ignore-scripts` installs, `node:sqlite` fallback |
| R6 | Playwright's Electron support breaks or can't reach tab views | Medium | Medium | S6, main-process hooks, a focused E2E suite |
| R7 | View layering and focus bugs | Medium | Medium | S4; FocusManager owns every focus decision |
| R8 | Scope creep (browsers are infinite) | High | High | MoSCoW in Part 7: any new *Must* has to displace an existing one |
| R9 | Users won't switch browsers | High | High | Specialize in research sessions; import paths; a portable `core` for a companion extension |
| R10 | Memory savings are smaller than hoped (Electron's baseline) | Medium | Medium | Honest benchmarks; position the value as less clutter plus retrieval, not only RAM |
| R11 | SmartScreen warnings on unsigned installers | High | Low–medium | **SignPath Foundation**: free for open-source projects with an OSI license, no proprietary components, builds from the repository and MFA. Microsoft's Azure *Artifact Signing* (formerly Trusted Signing) is the paid alternative. Its public-trust tier is limited to organizations in listed countries and to individuals in the US or Canada |
| R12 | Solo-developer time and energy | Medium | High | Every phase ends runnable; dogfooding from Phase 2; subagents take the mechanical work |

### 10.2 One-way doors: decisions that are hard to change later

1. **The platform** (Electron).
2. **Main-process-authoritative state and the IPC contract style.** Changing state ownership later would rewrite most features.
3. **The tab model:** orthogonal dimensions, UUID identity, placement semantics. Both the schema and the UI encode it.
4. **The browsing partition name** `persist:browsing`. Renaming it signs every user out and orphans their site data.
5. **The cookie-encryption fuse.** Turn it on from the first build. Electron documents it as a one-way transition: disabling it later corrupts the cookie store.
6. **App identity.** The Windows AppUserModelID, product name and user-data folder (`%APPDATA%\Veltriva`), executable name and installer type (per-user NSIS). Together they anchor profile location, taskbar pins, notifications and update continuity.
7. **Core data concepts** (pages vs visits vs tabs). Migrations make columns cheap to change; concepts stay expensive.
8. **Internal pages are rendered by the shell, never by tab renderers.** It's a security property that is painful to retrofit.

**Easy to change:** UI component details, ranking weights, lifecycle thresholds, the overlay strategy, the logger, the SQLite driver (it sits behind an interface), and the packaging tool, up until public users exist.

### 10.3 Deliberate trade-offs

| We choose | Over | Because |
|---|---|---|
| Snapshot UI sync | Fine-grained patches | Simpler and self-healing; cheap at our scale |
| A worker-thread database | Synchronous main-thread SQLite | A little complexity now buys a responsive browser forever |
| No page state on disk | Perfect restoration across restarts | Privacy: serialized page state can contain form contents |
| No "proceed anyway" on certificate errors | Convenience | Safety in the MVP |
| Single window | Flexibility | Scope |
| Local-only suggestions | Web search suggestions | Typing never leaves the machine |
| A vertical sidebar | Familiarity | It makes Tabs, Sleeping and Archive tangible (pending your decision) |

---

## Part 11 — Final Recommendations

### 11.1 Strategy

**Build the chrome layer you need, prove the risky parts first, and dogfood early.**

1. Build on Electron with `BaseWindow` + `WebContentsView`, internal pages rendered by the trusted shell, and **no bridge for web content**.
2. Spend about 35 hours on the Phase 0 spikes before writing product code. They turn the riskiest assumptions into facts.
3. Build in the reordered phase sequence, and start using Veltriva daily once Phase 2 lands.
4. Treat the lifecycle engine as the heart of the product: pure, exhaustively tested, explainable.
5. Measure everything we claim, and publish the method alongside the numbers.

### 11.2 What should change in the brief before development begins

1. Replace the single lifecycle chain with **four dimensions** (placement, runtime, activity, protection). IDLE becomes derived, RESTORING becomes an operation, and ERROR splits into crash vs navigation error.
2. Measure visible changes on the **engagement clock** (engaged time and active days) instead of wall-clock thresholds.
3. **Move persistence ahead of lifecycle** in the roadmap.
4. Replace the "sessions" table with `app_runs` plus the always-current `tabs` table. Move collections to v1.2. Search results show site and state instead of a collection.
5. Render **internal pages in the shell**. Web pages get no preload. The shell lives on `app://shell` in a separate session.
6. Put the **database in a worker thread** from day one.
7. Add **fast-check** model-based tests, **tldts** and **@tanstack/react-virtual**, and use **electron-vite** as the Vite integration.
8. Make explicit closes **recoverable for 7 days**. That completes "close nothing, lose nothing".
9. Treat **security patching as a product feature**: an update notification ships before any public release.

### 11.3 Decisions (approved 2026-10-16)

| # | Decision | My recommendation |
|---|---|---|
| D1 | Platform | Electron with `BaseWindow` + `WebContentsView` |
| D2 | Lifecycle model and default preset | The four-dimension model, with Balanced defaults (§4.7) treated as hypotheses tuned by dogfooding |
| D3 | Roadmap order | Persistence (Phase 2) before lifecycle (Phase 3) |
| D4 | Layout | Vertical sidebar with Tabs · Sleeping · Archive |
| D5 | Default search engine | Chosen at first run, DuckDuckGo preselected |
| D6 | App identity | AppUserModelID `io.github.rmv-coder.veltriva`, user-data folder `%APPDATA%\Veltriva`, MIT license after a dependency license review |
| D7 | Packaging and signing | electron-builder, per-user NSIS. Apply to SignPath Foundation's free OSS signing once the repo is public. Azure Artifact Signing is paid and limited by region for individuals |
| D8 | Window scope | Single window for the MVP; private windows after the MVP |

### 11.4 Next steps after approval

1. Initialize the repository: `git init`, the MIT `LICENSE`, a README stub, `.gitignore`, `.editorconfig`. Commit this proposal and ADRs 0001–0008.
2. Run spikes S1–S8 and write their reports.
3. Update the ADRs with the spike results and confirm the Phase 1 plan with you.
4. Start Phase 1, Milestone 1.1: scaffold and CI.

---

## Appendix A — The twelve architectural questions, answered briefly

| # | Question | Short answer | Detail |
|---|---|---|---|
| 1 | Is Electron the best choice? | Yes for this project. It's TypeScript end to end, Chromium on every OS, and exposes the lifecycle hooks we need. The price: we ship Chromium patches ourselves and build the chrome layer. A Chrome extension is the best product hedge; WebView2 has the best patching story | §2.1 |
| 2 | Safest, most efficient way to manage many pages? | `BaseWindow` + one `WebContentsView` per **live** tab, with only the selected one attached. Hardened `webPreferences`, a separate partition, no preload, and a global guard on every web contents. No `<webview>`, iframes or `BrowserView` | §3.3, §6.2 |
| 3 | Release resources without losing restore metadata? | Snapshot the navigation entries and active index (page state kept in memory only), `close({ waitForBeforeUnload: true })`, persist the snapshot, then restore with `navigationHistory.restore` | §4.9 |
| 4 | Model visual grouping and renderer state separately? | **Yes.** Placement (what you see) and runtime (what it costs) are independent; activity and protection are derived | §4.1–4.2 |
| 5 | How do we avoid archiving unsaved work? | Layered: the page's own `beforeunload` contract, an isolated-world form probe, an interaction guard, media and capture signals, user and site protection. In-memory app state can't be detected, and we say so | §4.10 |
| 6 | Which SQLite schema? | `tabs` (workspace objects) separate from `pages`/`visits` (memory), an external-content FTS5 index, `app_runs` for crash detection, STRICT tables with constraints | §5.3 |
| 7 | How do we recover from unexpected shutdowns? | `app_runs` heartbeat, WAL, `quick_check`, lazy restore, safe mode against crash loops, crashed-tab handling | §5.9 |
| 8 | How should the address bar accept URLs and searches safely? | A pure classifier with a Public Suffix List, scheme allow/deny rules, HTTPS by default, local-only suggestions, punycode display | §3.6 |
| 9 | Authentication, cookies, permissions, downloads, protocols? | One persistent encrypted-cookie partition; OAuth popups keep their opener; a deny-by-default permission broker; Mark-of-the-Web downloads; a gesture-gated protocol guard with a blocklist | §3.7, §6.4 |
| 10 | How is the browser UI isolated from web pages? | Separate session and protocol, sandbox, CSP, a typed and validated IPC contract with sender checks, internal pages rendered by the shell, no bridge for web pages | §3.1, §3.5, §6.2–6.3 |
| 11 | What's the minimum to make the MVP usable? | Part 7's Must list, including the unglamorous essentials (find, zoom, context menus, downloads, popups, permissions, session restore) | Part 7 |
| 12 | How do we benchmark fairly? | A fixed corpus, three modes (all live, collapsed, discarded), process-tree private bytes by process type, 5 runs reporting median and range, published scripts and raw data | §9.3 |

---

## Appendix B — Verified facts and sources

**How these facts were gathered.** On 2026-10-16, four research subagents read primary sources: official docs, release notes, source code, issue trackers and package registries. **Nothing was executed.** Confidence tags:

- **V** (verified): seen in official docs, source or release notes.
- **P** (partial): indirect evidence, or source reading without runtime confirmation.

Every **P** item that a decision depends on is covered by a Phase 0 spike.

**Electron platform**

| Fact | Tag | Source |
|---|---|---|
| Latest stable was Electron 44.7.2 (2026-10-14): Chromium 152.0.7977.149, Node 24.21.0. 45.0.0 is scheduled for 2026-10-20. (Phase 1 wrap-up, 2026-10-17: 44.9.0 is current, with Chromium 152.0.7977.167 and Node 24.22.0, and 45.0.0 is still in beta.) | V | [releases](https://github.com/electron/electron/releases/tag/v44.7.2), [schedule](https://releases.electronjs.org/schedule) |
| A new major every 8 weeks; the latest 3 majors are supported (the newest gets all fixes, the oldest security fixes only); 44 reaches end of life around 2027-03-02 | V | [timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) |
| `BaseWindow`, `View` and `WebContentsView` arrived in 30.0. `BrowserView` is deprecated since 30, now a wrapper, still present in 44/45 | V | [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [migration guide](https://www.electronjs.org/blog/migrate-to-webcontentsview) |
| Re-adding a child view moves it to the top; transparency via `setBackgroundColor('#00000000')` (the default is white) | V | [View](https://www.electronjs.org/docs/latest/api/view) |
| A view's web contents is **not** destroyed automatically, and must be closed explicitly or it leaks | V | [BaseWindow resource management](https://www.electronjs.org/docs/latest/api/base-window#resource-management) |
| `navigationHistory.getAllEntries()` / `restore({ entries, index })`: `restore` added in 34.2.0. `NavigationEntry.pageState` holds scroll and form state, committed periodically. `restore` resolves on `did-finish-load` | V | [NavigationHistory](https://www.electronjs.org/docs/latest/api/navigation-history) |
| `close({ waitForBeforeUnload: true })` doesn't close if the page objects. Without `preventDefault()`, `will-prevent-unload` cancels silently. `close()` grants the page user activation before dispatching `beforeunload` | V (docs + source) | [webContents.close](https://www.electronjs.org/docs/latest/api/web-contents#contentscloseopts) |
| No freeze or discard API. CDP `Page.setWebLifecycleState` exists, marked experimental | V | [DevTools protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/) |
| How views report visibility isn't documented. Linux had a 44.0–44.5 regression where re-added views reported `hidden` (fix queued) | P | [electron#54626](https://github.com/electron/electron/issues/54626) |
| `getAppMetrics()` includes `privateBytes` on Windows. CPU % is measured since the *previous call by any caller* | V | [ProcessMetric](https://www.electronjs.org/docs/latest/api/structures/process-metric) |
| No memory-pressure event. On Windows, `getSystemMemoryInfo()` gives total, free and swap only | V / P | [process](https://www.electronjs.org/docs/latest/api/process) |
| `input-event` (22+, every input type, observe-only); `before-input-event` (keyboard); `before-mouse-event` (36.5+) | V | [webContents events](https://www.electronjs.org/docs/latest/api/web-contents) |
| `executeJavaScriptInIsolatedWorld` runs in the top-level frame only; `WebFrameMain.executeJavaScript` runs in the page's main world | V (source) | [webContents](https://www.electronjs.org/docs/latest/api/web-contents) |

**Electron security surface**

| Fact | Tag | Source |
|---|---|---|
| The official security checklist has 20 items. Veltriva's design satisfies all the ones that apply; 11–12 (`<webview>`) don't apply because we don't use `<webview>` | V | [Security tutorial](https://www.electronjs.org/docs/latest/tutorial/security) |
| With no handler, **every permission request and check is granted**. About 46 permission names are forwarded from Chromium | V | [session](https://www.electronjs.org/docs/latest/api/session) |
| The window-open handler's `details` has no user-gesture field, and Electron has no popup blocker. `createWindow` (31+) with `new WebContentsView({ webContents })` preserves `window.opener` | V / P (blocker absence from source) | [setWindowOpenHandler](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler) |
| Unknown schemes go through the `openExternal` permission. With no handler, the OS app launches with no prompt | V (source) | [session permissions](https://www.electronjs.org/docs/latest/api/session) |
| Unhandled defaults: the first client certificate is auto-selected; certificate errors are denied; HTTP auth is cancelled | V | [app events](https://www.electronjs.org/docs/latest/api/app) |
| Downloads with no save path show a dialog. Chromium writes `Zone.Identifier` (ZoneId=3) on Windows; the antivirus hand-off appears unwired | P | [DownloadItem](https://www.electronjs.org/docs/latest/api/download-item) |
| Fuse defaults as tabled in §6.2. Cookie encryption is one-way. electron-builder's `electronFuses` key exists since 26.0 | V | [Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) |
| PDF viewer built in and on; spellcheck uses Hunspell on Windows, with dictionaries downloaded from a CDN; no Widevine in stock builds (castlabs ECS adds it); proprietary codecs on | V / P | [spellchecker](https://www.electronjs.org/docs/latest/tutorial/spellchecker), [castlabs](https://github.com/castlabs/electron-releases) |
| Google forbids OAuth in embedded user agents. Electron's default user agent carries an `Electron/` token, and `navigator.userAgentData` can't be overridden | V / P | [Google OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies), [Min UASwitcher](https://github.com/minbrowser/min/blob/master/main/UASwitcher.js) |
| Protocol handlers are registered per session | V | [protocol](https://www.electronjs.org/docs/latest/api/protocol) |
| No API to block third-party cookies | V (absence) | [session](https://www.electronjs.org/docs/latest/api/session) |
| A lower view's drag region swallows clicks in views above it. Fixed on main 2026-10-15, not yet released | V | [electron#54936](https://github.com/electron/electron/pull/54936) |

**Toolchain**

| Fact | Tag | Source |
|---|---|---|
| better-sqlite3 13.0.3 (2026-08-05) is N-API with a `win32-x64` prebuild; FTS5 and math functions on; SQLite 3.53.4. Use ≥ 13.0.2 (fixes an abort on worker termination). npm may compile it on Windows without `--ignore-scripts` | V / P | [releases](https://github.com/WiseLibs/better-sqlite3/releases), [compilation](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md) |
| Pre-v13 Electron prebuilds lagged new Electron majors by up to about 6 weeks (Electron 42) | V | better-sqlite3 issues #1470, #1474 |
| `node:sqlite` is a release candidate in Node 24 LTS and Node 26; present in Electron, though 37.2.0 shipped without it | V | [Node docs](https://nodejs.org/api/sqlite.html), electron#47671 |
| electron-vite 6.0.0 (2026-10-14), Vite 6–8 | V | [changelog](https://github.com/alex8088/electron-vite/blob/master/CHANGELOG.md) |
| Electron Forge 8.0.1 (2026-09-29): Vite plugin now stable; Windows makers Squirrel, WiX, MSIX, AppX, ZIP | V | [Forge v8.0.1](https://github.com/electron/forge/releases/tag/v8.0.1) |
| electron-builder 26.17 stable: NSIS default, differential updates, `electronFuses`, signtool / Azure / custom signing | V | [electron-builder](https://github.com/electron-userland/electron-builder) |
| Playwright 1.64.1: Electron support experimental; `WebContentsView`s appear as Pages; `EnableNodeCliInspectArguments` must stay on for launches | V | [Electron class](https://playwright.dev/docs/api/class-electron) |
| Vitest 5.0.5; no official support for running under Electron | V | vitest#6286 |
| TypeScript 7.0 is GA (native compiler); typescript-eslint 8.x supports TypeScript < 6.1 | V | [TS 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) |
| React 19.3.1, Vite 8.3.4, Tailwind 4.3.3, shadcn CLI 4.21.5, Zustand 5.0.15, Zod 4.6.7, ESLint 10.12, fast-check 4.10.2 (with `fc.scheduler`), tldts 7.4.18, @tanstack/react-virtual 3.14.20 | V | npm registry |
| SignPath Foundation: free OSS code signing, with conditions. Azure Artifact Signing (renamed from Trusted Signing, GA 2026-01-12): paid; public trust for individuals in the US or Canada only | V | [signpath.org](https://signpath.org/), [Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/quickstart) |

**Alternatives and prior art**

| Fact | Tag | Source |
|---|---|---|
| Tauri 2.12.4: multi-webview APIs (`Window::add_child` and others) still need the `unstable` feature. `with_webview` exposes the WebView2 controller and environment without it | V | [docs.rs: tauri Window](https://docs.rs/tauri/latest/tauri/window/struct.Window.html) |
| WebView2 `TrySuspend` works only while hidden and is best-effort; `MemoryUsageTargetLevel` Low can swap renderer memory to disk | V | [ICoreWebView2_3](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_3), [ICoreWebView2_19](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_19) |
| WebView2 `IsUserInitiated` flags gesture-initiated popups (Edge's own popup blocker is off in WebView2). SmartScreen checking is on by default; tracking prevention is configurable; the Evergreen runtime auto-updates | V | [NewWindowRequestedEventArgs](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2newwindowrequestedeventargs), [distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) |
| Chrome extensions: `tabs.discard` keeps tabs in the strip and reloads them on activation; collapsed tab groups hide their tabs; `sidePanel` is Chrome 114+; MV3 service workers stop after 30 s idle; the minimum `alarms` period is 30 s | V | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs), [tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups), [alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms) |
| CEF Chrome-runtime vs Alloy status in 2026 couldn't be confirmed, so this proposal makes no claim about it | — | — |
| Arc auto-archive defaults to 12 h for idle, unpinned tabs. Arc is in maintenance mode (May 2025). Atlassian completed its acquisition of The Browser Company on 2025-10-21 | P / V / V | [Arc help](https://resources.arc.net/hc/en-us/articles/19228855311127), [The Register](https://www.theregister.com/2025/05/27/arc_browser_development_ends/), [Atlassian](https://investors.atlassian.com/news/news-details/2025/Atlassian-Completes-Acquisition-of-The-Browser-Company-of-New-York/default.aspx) |
| Edge sleeping tabs: the policy reference gives a 900 s default (30 s–12 h range); consumer help says two hours | V (conflicting sources) | [SleepingTabsTimeout policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/sleepingtabstimeout) |
| Chrome Memory Saver modes and exemptions (media, calls, screen sharing, notifying sites, downloads, partly filled forms, pinned tabs) | V | [Chrome help](https://support.google.com/chrome/answer/12929150) |
| Firefox unloads tabs on critically low memory, least recently used first (since Firefox 93) | V | [Mozilla Hacks](https://hacks.mozilla.org/2021/10/tab-unloading-in-firefox-93/) |
| Vivaldi Memory Saver hibernates idle tabs; off by default; exempts media and partly filled forms | V | [Vivaldi press release](https://vivaldi.com/press/vivaldi-boosts-performance-with-memory-saver-auto-detects-feeds-with-its-feed-reader/) |

---

## Appendix C — Glossary for browser and desktop concepts

| Term | Meaning, and why it matters here |
|---|---|
| **Main process** | Electron's privileged Node.js process, which is also Chromium's browser and UI thread. It owns windows, tabs and every decision. Never block it |
| **Renderer process** | A sandboxed process that runs web pages (and our React UI). It can't touch the OS directly |
| **`BaseWindow` / `WebContentsView`** | A native window, and a rectangular view inside it that hosts one *web contents*. One per live tab, plus one for our UI |
| **`webContents`** | The object that represents a loaded page: navigation, events, history, and its renderer |
| **Site isolation** | Chromium puts different sites (eTLD+1) in different processes, so a compromised page can't read another site's memory |
| **Sandbox** | OS-level restrictions on renderers. Our UI and every tab run sandboxed |
| **Context isolation** | Runs preload code in a separate JavaScript world from the page, so a page can't tamper with privileged code |
| **Preload / `contextBridge`** | A script that runs before page code and can expose a *chosen* API. Only our trusted UI gets one |
| **IPC** | Messages between renderer and main processes. Our command contract is validated on every call |
| **Session / partition** | A cookie jar, cache, storage and permission scope. `persist:` partitions live on disk; others are in-memory |
| **Isolated world** | A separate JavaScript context in a page that shares its DOM but not its JS objects. Our on-demand probes run there |
| **CDP** | The Chrome DevTools Protocol, reachable through `webContents.debugger`. It's where experimental controls such as page freezing live |
| **`beforeunload`** | An event a page uses to say "I have unsaved changes". Veltriva honors it as a protection signal |
| **Page Lifecycle (freeze / discard)** | Web standards for suspending a page's tasks (freeze) or dropping it entirely (discard) |
| **Back/forward cache** | Chrome keeps recently left pages alive in memory for instant Back. Electron's source suggests it's off in Electron, which S1 confirms. Either way, it's a reminder that "freed memory" must be measured, not assumed |
| **FTS5 / bm25** | SQLite's full-text search engine, and its relevance-scoring function |
| **Frecency** | A score that combines frequency and recency of visits |
| **WAL** | SQLite's write-ahead log, which gives crash-safe transactions and concurrent readers |
| **ABI / native module** | Compiled add-ons tied to one runtime ABI. That's why `better-sqlite3` must be built for Electron specifically |
| **asar** | The archive format Electron apps ship in. Native `.node` files must be unpacked from it |
| **Fuses** | Package-time switches that harden an Electron binary, for example turning off "run as Node" |
| **Mark-of-the-Web** | A Windows tag on downloaded files that makes SmartScreen and Office Protected View inspect them |
| **DPAPI** | Windows' per-user encryption API, used by the cookie-encryption fuse |
| **eTLD+1 / Public Suffix List** | The registrable domain (`example.co.uk`), computed from a maintained list of public suffixes |
| **Punycode / IDN homograph** | The ASCII form of internationalized hostnames; showing it defeats look-alike domains |
