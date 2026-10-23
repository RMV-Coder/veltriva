# MVP gap audit (Phase 5, M5.0)

Every "Must (v1.0)" and "Should" item of assessment §7.2 is checked against what main does at d5703eb, the end of Phase 4, plus what M5.0 itself adds. Where the code alone couldn't settle it, the behavior was **measured** on Electron 45.0.0 with a test build:
- **JS dialogs and the file chooser:** native dialog windows were read with Windows UI Automation;
- **printing:** windows in every process were checked, since Windows 11's print dialog has its own process.

The table names a file or a test as evidence. The last column is the milestone that closes each gap. About, licenses, the installer and the update notification are Phase 6's.

**Status:** **done** works as §7.2 asks; **partial** works but falls short of it, with the gap named; **missing** isn't built.

## Must (v1.0)

### Browsing

| Item | Status | Evidence | Closed by |
|---|---|---|---|
| Single window | done | `src/main/windows/main-window.ts` (one `BaseWindow`, ADR-0009 D8) | — |
| Tabs: new, close, select, reorder, pin | done | `tests/e2e/tabs.spec.ts`, `shortcuts.spec.ts` (Ctrl+T/W/Tab/1–9, Alt+Shift+arrows) | — |
| Duplicate tab | done | the tab menu's "Duplicate" (`src/main/menus/tab-menu-model.ts`); `tests/e2e/context-menu.spec.ts` | — |
| Reopen closed tab | done | Ctrl+Shift+T and Recently closed; `tests/e2e/session.spec.ts`, `shortcuts.spec.ts` | — |
| Back, forward, reload, stop | done | `tests/e2e/navigation.spec.ts` | — |
| Omnibox: URL or search, local suggestions | done | `tests/e2e/omnibox.spec.ts`; memory suggestions and Switch to tab in `memory.spec.ts` (M4.2) | — |
| Loading state, titles, favicons | done | `tests/e2e/tabs.spec.ts`, `history.spec.ts` | — |
| Find in page | done | `tests/e2e/find.spec.ts` | — |
| Zoom | done | `tests/e2e/zoom.spec.ts` | — |
| Context menus | done | `tests/e2e/context-menu.spec.ts` | — |
| Reserved shortcuts | done | `tests/e2e/shortcuts.spec.ts` | — |
| HTML fullscreen | done | `tests/e2e/fullscreen.spec.ts` | — |
| Error pages | done | `tests/e2e/navigation.spec.ts` (network error), `certificates.spec.ts` | — |
| Crashed-tab page | done | `tests/e2e/crash.spec.ts` | — |
| **JS dialogs** (alert, confirm, prompt) | **partial** | **Measured:**<br>• `alert` and `confirm` open Electron's native message box. It is owned by the browser window, which it disables, so the whole browser is blocked until it's answered.<br>• A background tab's dialog appears at once too.<br>• The box is titled "Veltriva Browser" and shows the page's text, but not the site asking.<br>• From the second dialog, `safeDialogs` offers "Prevent this app from creating additional dialogs".<br>• `prompt()` returns `null` at once, with no dialog.<br>• Electron 45 has no hook to replace these. A DevTools-protocol session with `Page.enable` gets no `javascriptDialogOpening`, and the native box still shows (measured). | **Decided:** the native dialogs stay for v1.0, stated as a limitation (accepted on review, 2026-10-23); see below. |
| **`beforeunload` dialogs** | **done** (M5.0), with one stated limit | **On close:** "Leave page?" since M3.3 (`placement.spec.ts`).<br>**On navigation:** before M5.0, a page with an active handler silently blocked the user's own navigation and reload. Electron cancels them without a dialog (measured), so the address didn't change and nothing said why.<br>**M5.0 asks** "Leave page?" for the user's typed address, reload, back and forward, and Leave does it again (`tests/e2e/leave-page-navigation.spec.ts`).<br>**The limit:** a link inside the page that the page stops gives main no target. The handler runs in the renderer before main hears of any navigation (measured), so the page's objection stands, as before. | M5.0 |
| File chooser | done | **Measured:** `<input type="file">` opens Windows' native Open dialog. It is modal to the browser window, as Chrome's is. A manual check covers choosing a file. | — |
| **Print** | **done** (M5.0) | **Measured:** a page's `window.print()` opened Windows' print dialog, but **Ctrl+P did nothing**. M5.0 adds Ctrl+P, which a page may claim first, as with Ctrl+F, and "Print…" in the page's context menu. Both open the system dialog through `webContents.print()` (`tests/e2e/leave-page-navigation.spec.ts`, which records the request in test builds). | M5.0 |
| DevTools for pages (F12) | done | `tests/e2e/devtools.spec.ts` | — |

### Web plumbing, lifecycle, persistence, search

| Item | Status | Evidence | Closed by |
|---|---|---|---|
| Downloads (basic manager) | done | `tests/e2e/downloads.spec.ts`, `download-history.spec.ts` | — |
| Permission prompts | done | `tests/e2e/permissions.spec.ts`, `stored-decisions.spec.ts` | — |
| Popups (tabs, plus popup windows that keep the opener for OAuth) | done | `tests/e2e/popups.spec.ts` | — |
| External-protocol prompts | done | `tests/e2e/external-protocols.spec.ts` | — |
| Certificate-error page | done | `tests/e2e/certificates.spec.ts` | — |
| Engagement clock | done | `src/core/lifecycle/engagement-clock.ts`; `tests/e2e/automation.spec.ts` | — |
| Discard and restore with navigation history | done | `tests/e2e/lifecycle.spec.ts`; `tests/lifecycle/discard.test.ts` | — |
| Sleeping shelf | done | `tests/e2e/placement.spec.ts`, `placement-sidebar.spec.ts` | — |
| Archive (auto and manual) with Undo | done | `tests/e2e/placement.spec.ts`, `automation.spec.ts` | — |
| Protection engine v1 | done | `tests/e2e/protection.spec.ts`, `automation.spec.ts` | — |
| Automation pause | done | the sidebar's "Pause automation" (M3.4); `protection.spec.ts` | — |
| Activity log | done | the Activity view (M3.3); `placement-sidebar.spec.ts` | — |
| SQLite data worker | done | `tests/e2e/data-worker.spec.ts`; `src/data` | — |
| Session restore with lazy loading | done | `tests/e2e/session.spec.ts` | — |
| Crash recovery and safe mode | done | `tests/lifecycle/hard-kill.test.ts`, `durability.test.ts`; `session.spec.ts` | — |
| History (pages and visits) | done | `tests/e2e/history.spec.ts` | — |
| Migrations | done | `src/data/database.test.ts` (the frozen v1 fixture) | — |
| Backups | done | `src/data/maintenance.test.ts`; `tests/lifecycle/durability.test.ts` | — |
| FTS5 over titles, URLs and sites; ranking v1 | done | `src/data/repos/search.test.ts`, `search-golden.test.ts`; `docs/benchmarks/search.md` | — |
| Ctrl+Shift+K palette with filters (state, time, site) | done | `tests/e2e/memory.spec.ts` | — |
| Memory suggestions and switch-to-tab in the omnibox | done | `tests/e2e/memory.spec.ts` | — |
| Virtualized Archive list | done | `tests/e2e/memory.spec.ts` (10,000 archived tabs) | — |

### Settings and privacy

| Item | Status | Evidence | Closed by |
|---|---|---|---|
| Lifecycle presets plus advanced thresholds | **done** (M5.1) | `veltriva://settings`: presets with plain descriptions, every advanced value and the pressure thresholds; main checks each change (`tests/e2e/settings.spec.ts`, `settings.test.ts`) | M5.1 |
| Site rules: protect | **done** (M5.1) | the `site_rules` table (migration 3 moved M3.4's list there); Settings lists, adds and removes rules; the tab menu sets them | M5.1 |
| Site rules: exclude from the memory | **done** (M5.1) | never recorded (the worker refuses the visit), never auto-archived (the `excluded-site` protection), and closing keeps no record (`keepsNoRecord`); `settings.spec.ts` | M5.1 |
| Clear memory and site data | **done** (M5.2) | Settings: a time range or a site, with Chromium's cookies, storage and cache; Shift+Delete in the palette for one entry. Deletion verified by `src/data/repos/forget.test.ts` and `tests/e2e/privacy.spec.ts` | M5.2 |
| Default search engine | **done** (M5.1) | chosen on the welcome page at first run (DuckDuckGo preselected), changed in Settings, with a custom template checked by main | M5.1 |
| Startup behavior | **done** (M5.1) | "Continue where you left off" or "Start with a new tab" (open tabs go to the Archive) | M5.1 |

### Release (Phase 6)

| Item | Status | Evidence | Closed by |
|---|---|---|---|
| NSIS installer | **done** (M6.3) | `npm run package:installer`: per user, shortcuts with the AppUserModelID, an uninstaller that asks about the profile (`build/installer.nsh`). `scripts/installer-test.ps1` installed, launched, uninstalled (both answers, and silently) and reinstalled it on this machine; clean Windows 10 and 11 VMs are in the final manual checklist (ADR-0007 item 8) | M6.3 |
| Fuses | done | `electron-builder.yml` `electronFuses`; read back from the binary by `scripts/check-packaged-app.mjs` since M6.1 | — |
| About page with versions and licenses | **done** (M6.3) | `veltriva://about`: Veltriva, Electron, Chromium, Node.js and V8; the MIT license; `THIRD_PARTY_NOTICES.txt` (M6.1); `tests/e2e/about-updates.spec.ts` | M6.3 |
| Update-available notification before any public release | **done** (M6.3) | `src/main/updates`, off by default and silent while off; Settings ▸ Updates; a notice with View release and Skip; `tests/e2e/about-updates.spec.ts` | M6.3 |

## Should

| Item | Status | Evidence | Closed by |
|---|---|---|---|
| HTTP-auth prompt | done | `tests/e2e/sign-in.spec.ts` | — |
| Scroll position restored across restarts (non-sensitive pages) | **done** (M5.3) | Within a run, Chromium's page state (M3.1). Across a restart, the app_state document `scroll` (`main/session/scroll-keeper.ts`, ADR-0004 item 15): never for a page with a password or payment field (`tests/e2e/diagnostics.spec.ts`) | M5.3 |
| "Pause memory" toggle | **done** (M5.1) | Settings; the history recorder sends nothing while it is on (`history-recorder.test.ts`, `settings.spec.ts`) | M5.1 |
| Per-tab memory display | **done** (M5.3) | `veltriva://diagnostics`: each tab's renderer memory (private bytes, S8), and what it shares | M5.3 |
| Dark theme | done | follows Windows' setting (`nativeTheme`, the `app.themeChanged` event), light and dark throughout the shell. A choice in Settings is M5.1's, optionally. | — |
| First-run onboarding (search engine, preset, preview mode) | **done** (M5.1) | `veltriva://welcome` on a new profile (`settings.spec.ts`) | M5.1 |
| The freeze experiment behind a flag | done | `lifecycle.freeze`, off by default (M3.1), switched in Settings (M5.1) | — |
| Regret rate on a diagnostics page | done | `veltriva://diagnostics` (M3.4) | — |
| Silent auto-update once builds are signed | not built: builds are unsigned (signing is the user's decision, `docs/distribution/signing.md`) | — | after signing |

## Also from §5.7 and §6.6

| Item | Status | Closed by |
|---|---|---|
| Retention of visits, configurable (default 365 days) | **done** (M5.2): pruned while idle (M2.2b); the number is in Settings | M5.2 |
| Clear data: one entry, forget a site, time ranges; secure delete and file shrink | **done** (M5.2) | M5.2 |
| Managing stored permission decisions | **done** (M5.2): Settings lists, changes and revokes decisions, apps' "always open" and client-hint opt-ins | M5.2 |
| Diagnostic logging opt-in, URLs only when on, 5 × 5 MB rotation | **done** (M5.3): `main/platform/file-logger.ts`; the switch is in Settings | M5.3 |

## The JS-dialog decision: native dialogs for v1.0 (accepted)

Electron 45 runs a page's `alert` and `confirm` through its own dialog manager. It offers no API to replace them, and as measured above it bypasses the DevTools protocol's dialog events.

**What can be changed without patching Electron:**

1. **Keep the native dialogs** (today's behavior).
   - **For:** pages work as written.
   - **Against:**
     - a dialog blocks the whole window, from any tab;
     - it doesn't name the site;
     - `prompt()` doesn't work.
   - **Mitigation:** `safeDialogs` lets the user stop a page's further dialogs.
2. **Turn dialogs off for tabs** (`webPreferences.disableDialogs`).
   - **For:** nothing can block or spoof.
   - **Against:** `alert` becomes a no-op and `confirm` always answers "Cancel", so a page's "Delete this?" silently never happens. That breaks pages without telling anyone.
3. **Replace them in the page:** a document-start script in the page's own world, plus a synchronous request to main that waits for our own per-tab question.
   - **For:** Chrome-like.
   - **Against:**
     - it injects into every page's main world, which ADR-0002 rules out;
     - a page can see or undo it;
     - it relies on synchronous XHR;
     - it would be the most fragile code in the browser.

**Decision: (1) for v1.0, stated plainly.** M5.0 recommended it, and it was accepted on review on 2026-10-23. Option (2) silently breaks `confirm()`, and option (3) breaks ADR-0002.
- **Where it's stated:** the README's known limitations, ADR-0002 item 12, the assessment's threat T6 and §6.7, and the Phase 5 manual checks (B1–B3).
- **What to watch:** Electron, for a dialog-handler API. Phase 6 checks each Electron release for one; the change would be small once it exists.

The spoofing risk is real but bounded:
- the box can't take input (`prompt` doesn't work);
- it never shows a password field;
- `safeDialogs` stops a page after its second dialog.

## M5.0's changes

- **"Leave page?" for navigations** (`src/main/tabs/tab-manager.ts`, `tab-runtime.ts`): the user's own navigation or reload that a page's `beforeunload` stops is asked about, in the toolbar as for a close. Leave overrides the page once and does it again.
- **Print:** Ctrl+P (page-first) and the page menu's "Print…" open the system print dialog. Test builds record the request (`src/main/testing/print-requests.ts`).
