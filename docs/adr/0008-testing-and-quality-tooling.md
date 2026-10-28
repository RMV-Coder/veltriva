# ADR-0008: Testing strategy and quality tooling

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | The approved architecture (testing) |
| **Validated by** | [Spike S6](../spikes/s6-test-reach.md) (test reach: partly confirmed; rules added to item 4, plus a new non-Playwright layer, 4a). The M1.1 smoke test added two more rules to item 4 |
| **Details** | Technical assessment Part 9 |

## Decision

1. **Unit tests.** Vitest 5 on Node 24, with `*.test.ts` files next to the code. `src/core` needs at least 90% line and branch coverage.
   - **As built (v0.1.0): coverage isn't measured.** No coverage provider (such as `@vitest/coverage-v8`) is installed, and CI doesn't check the 90% target. The pure layers are tested heavily (8,576 tests at v0.1.0, with fast-check model and property tests), but the number is unmeasured. Adding the provider and a threshold is a follow-up.
2. **Model-based tests (fast-check 4).**
   - Random command sequences run against TabManager with fake tab runtimes.
   - Async completions are reordered with `fc.scheduler()` and `scheduledModelRun`.
   - Invariants I1–I8 are checked after every step.
   - **As built in M3.1:** fast-check **4.10.2** (MIT, a dev dependency only; its one dependency is pure-rand). `src/main/tabs/tab-manager-model.test.ts`:
     - Fake runtimes follow the Electron runtime's contract, and their probes, closes, restores, loads and freezes, and TabManager's own deadline timers, are tasks of `fc.scheduler()`. `fc.scheduledModelRun` interleaves them with the commands in random order.
     - The scheduler's `act` wraps every released task: it lets the continuations run (`setImmediate`), then checks I1–I8. Each command checks them too. I5 is also checked inside the fake at the moment a discard closes a page.
     - Three properties: 250 sequences on a fixed seed, which must reach every discard outcome and every runtime transition, so the coverage is stable; 250 on a new seed each run; and three runs of exactly 10,000 commands. The strip stops growing at 40 tabs, so long runs stay realistic and the checks cheap.
3. **Integration tests** cover the data worker and migrations on Node, using the same N-API SQLite binary as the app:
   - every historical schema version is upgraded;
   - FTS integrity;
   - secure deletion;
   - crash consistency, using child processes killed mid-transaction.
4. **End-to-end tests (Playwright, pinned version).**
   - Tests drive the **built but unpackaged** app through `_electron.launch()`, using `executablePath`. Without it, Playwright's loader adds `disable-renderer-backgrounding` and `disable-backgrounding-occluded-windows`, which changes the behavior under test.
   - `WebContentsView`s are reachable as Pages, and main-process assertions use `electronApp.evaluate`.
   - Test hooks (`advanceClock`, `getTabStates`, `setMemoryPressure`, `crashRenderer`) exist only in test builds.
     - **How (M1.2):** a test build is `electron-vite build --mode test` (`npm run build:test`; `npm run test:e2e` runs it first). The hooks sit behind `import.meta.env.MODE === 'test'`, which a production build folds to `false` and drops.
     - `npm run package:dir` runs `scripts/check-production-build.mjs`, which refuses an `out/` that still contains them.
     - M1.2's hooks are `openTestTab`, `closeTestTabs` and `webContentsRoles`, on `globalThis.__veltrivaTest`. M1.3a adds `tabStates`, `selectedTabId`, `contentRect`, `crashTab` and `setSearchTemplate`, which points omnibox searches at a local fixture.
     - M1.3b adds `contextMenuItems` and `invokeContextMenuItem`, because Playwright can't click a native menu: a test reads the entries for given params and runs one. `tabMenuItems` and `invokeTabMenuItem` do the same for a sidebar tab's menu. It also adds `viewStack` (the views from bottom to top) and `fullscreen`.
     - M1.4a adds `externalLaunches`, the URLs the external-protocol guard launched. Test builds never launch an app: `src/main/testing/external-launches.ts` records each URL instead of calling `shell.openExternal`. It also adds `popupWindows`, each popup window with its address-bar text and layout.
     - **M2.1a adds `dataCall`, `dataState` and `mainNativeModules`.**
       - `dataCall` calls the data worker through main's validating client, and returns the error code instead of throwing.
       - `mainNativeModules` lists the native addons in main's own module registry, which must be empty.
     - **M2.1b adds `dataReady`, `holdDataWorker`, `notices` and `showNotice`.**
       - `holdDataWorker` keeps the worker inside one long SQLite statement (`src/data/testing/hold.ts`), so a lifecycle check can quit while a statement runs.
       - The lifecycle harness can reuse one profile across launches and expect an exit code. Its scenarios print a `will-quit` event line with the data client's state.
       - Its checks cover a clean exit, a quit at the 3 s cap while the worker is stuck (exit 1, then a crash and a quick check on the next launch), and a damaged database restored from the daily backup.
     - **Data-layer integration tests** run on real files under Vitest (item 3). They include crash consistency: a child Node process killed five times mid-transaction, then startup and every check pass, committed rows survive and uncommitted ones are gone.
     - **The production check knows every test-only name** (M1.3b): the hooks' global and names, the lifecycle runner with its env and scenario names, and the fail-fast handler and its message. `setSearchTemplate` is exempt: production code exports it for the Phase 5 setting. CI runs the check right after its production build, and `package:dir` runs it before packaging.
     - **An uncaught exception in main exits a test build with code 70** (`src/main/testing/fail-fast.ts`). Electron's default opens a modal error dialog and keeps the app running, which every harness would only see as a hang.
   - Pages come from a deterministic local fixture server; no critical test depends on an external site.
   - Before launch, the test harness removes `ELECTRON_RUN_AS_NODE` from the app's environment and asserts that it's gone. An empty value still counts as set.
   - **Rules from [spike S6](../spikes/s6-test-reach.md):**
     - **Find pages by identity, never by position.** Page order and `firstWindow()` are random. Use helpers `shellPage(app)` (matched by shell URL) and `pageForTab(app, tabId)`, which matches `getOrCreateDevToolsTargetId()` from `getTabStates()` against the CDP target id.
     - **Register `waitForEvent('window')` before opening a tab.** A view becomes a Page only after its first navigation.
     - **Act on a tab only while it's attached.** `click()` and `screenshot()` time out on detached views. `evaluate` still works.
     - **Never `page.close()` a tab.** Close tabs through the shell or a TabManager hook.
     - **Never assert hidden-tab behavior through Playwright.** Its per-page focus emulation makes hidden and detached tabs report `visible`, with unthrottled timers.
   - **Rules found while building the M1.1 smoke test:**
     - **After the app cancels a navigation, check the page with `evaluate`.** Playwright never learns that `will-navigate` was cancelled, so actions such as `click()` wait forever ("waiting for navigation to finish"). `evaluate` and simple reads still work.
     - **Observe cancelled navigations on `will-frame-navigate`.** The guard cancels there (M1.2), and Electron then never emits `will-navigate`.
     - **Test CSP from a later task, not inside `evaluate`.** The inspector lets `eval` run during its own `page.evaluate` call even under `script-src 'self'`. The CSP test runs `eval` from a `setTimeout` callback instead.
     - **The PDF check looks for the document frame.** Under a guard that blocks the viewer's subframes, the viewer's toolbar frame (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html`) still appears. The proof that PDFs render is a child frame that commits the PDF's own URL.
     - **Don't measure shutdown through Playwright.** With its inspector and CDP attached, `close()` on a loaded laptop sometimes took about 100 s, against about 25 ms for the same `app.quit()` without Playwright. The harness kills the process tree after 30 s and records a warning instead of failing the test. Shutdown speed belongs to the lifecycle harness (4a).
   - **Rules found while writing the M1.3a suites:**
     - **Find a tab's Page with `pageForTab(app, tabId)`** (`tests/e2e/hooks.ts`), which matches the tab's DevTools target id through a short-lived CDP session per page.
     - **After a renderer crash, the tab's Page stays marked crashed**, even once "Reload tab" brings the page back. Check the reloaded page from main (`evaluateInTab`, `webContents.executeJavaScript`).
     - **Wait for the address bar to take focus after "New tab"** before typing. The shell focuses it when the new tab's snapshot arrives, and earlier keystrokes are lost.
     - **Point searches at the local fixture first** (`setSearchTemplate`), in every test that types: the default template is a real search engine. Never type a real domain; use `127.0.0.1` URLs and `.invalid` hosts.
     - **Playwright emulates `prefers-color-scheme: light`** in `_electron.launch` unless `colorScheme` says otherwise, so `nativeTheme.themeSource` alone doesn't change what the shell renders.
     - **Hit counts accumulate per worker.** The fixture server is shared by a worker's tests, so a spec uses its own paths or counts deltas.
     - **Chromium refuses some navigations before Electron sees them** (top-level `data:`, `blob:null/…`). Assert "refused by Chromium or the guard", plus an unchanged URL.
   - **Rules found while writing M1.3b:**
     - **Send browser shortcuts with `webContents.sendInputEvent`**, from main, to the web contents that has focus. Playwright's keyboard goes through CDP, which skips `before-input-event` (measured), so a reserved shortcut sent that way never reaches main.
     - **Fullscreen needs a user gesture.** Use `executeJavaScript('…requestFullscreen()', true)` from main, or a real click in an attached tab.
     - **A cancelled key has no keyUp.** Once `before-input-event` cancels a keyDown, Chromium drops the matching keyUp itself, so `before-input-event` never sees it (measured). A spec checks that the keyDown was cancelled; `recordInputs` (`tests/e2e/hooks.ts`) records each key in main after the app's own handler, with `prevented`.
     - **Ctrl+wheel needs `wheelTicksY`.** A synthetic `mouseWheel` event zooms only with `wheelTicksY` set. On Electron 44.7.2, one synthetic event gives two `zoom-changed` events, so the zoom spec checks the direction and the presets, not the number of steps. Real wheel notches are checked by hand.
     - **A popup or an app launch needs a gesture main has seen** (M1.4a). The tracker reads `input-event`, so the gesture must be a real input event: `sendInputEvent` mouse-down/up on the page's button, or a key. `executeJavaScript(…, true)` gives Chromium a user activation, but main sees no input, so the popup is blocked. That is how a "no gesture" case is tested.
     - **Never grant real devices or location in E2E** (M1.4a). Allowing `media` opens this machine's camera and microphone, and allowing `geolocation` starts a real location lookup. Allow paths are tested with `notifications` and `clipboard-read`; camera, microphone and location are tested through Block, Dismiss and the cases denied without asking.
     - **Playwright makes every page report `isBeingCaptured()`** (M3.2). It sends `Emulation.setFocusEmulationEnabled` on every attach, and Chromium counts that as a capturer; raw CDP against the app showed it false for every page until that one call. Test builds therefore read capture from marks set by the `setCaptured` hook (`src/main/testing/test-clock.ts`), which is also how the capture protection is tested without a real device.
     - **The lifecycle specs pin the memory pressure** with `setMemoryPressure`: the real monitor reads this laptop as under moderate pressure most of the time.
     - **More M1.4a facts:** Playwright's own click reaches main's `input-event`, but a `sendInputEvent` click at an out-of-process frame's coordinates does not reach that frame. `permissions.query` says `denied` before any decision. Chromium refuses `window.open('file:…')` before main's handler. The popup address bar loads after its window appears. `getUserMedia` reaches the broker about 2 s after the call.
     - **M1.4b facts:**
       - Chromium treats binary bytes labelled `text/plain` as a download, so inline fixtures serve real text.
       - Chromium cleans a download's name before main sees it: a right-to-left override becomes `_`, and `.lnk` becomes `.download`.
       - A Basic or Digest realm arrives as Latin-1, so bidi overrides can't appear in it.
       - Chromium never raises `login` for a cross-origin image.
       - `--ignore-certificate-errors-spki-list` (an `appSwitches` fixture) trusts exactly one throwaway key, which makes the client-certificate page reachable. Its server's refusal sometimes loses a race with the socket closing, so the spec retries.
       - The self-signed certificate is built in memory with Node's `crypto` and never touches disk.
     - **Read a page's selection from main, not through a Playwright page attached late** (Electron 45, Phase 4 Step 0). Attaching Playwright to a page clears its selection: after the find bar closed, `getSelection()` read from main gave the active match for 2 s, then `""` right after `pageForTab` attached. Read the selection with `executeJavaScript` (`evaluateInTab`), or attach before the selection is made.
     - **Ask main which web contents has the keyboard** (`webContents.getFocusedWebContents()`, `focusedWebContents` in the hooks). The shell keeps its `document.activeElement` while a page has the keyboard, and Playwright's focus emulation reports any element it focused as focused. Playwright's clicks and keys also move no OS-level focus, so a spec gives the shell the keyboard as a real click would (`focusWebContents`).
4a. **Lifecycle behavior tests (no Playwright).** A small Electron-script harness, like the Phase 0 spikes, asserts the behavior Playwright masks:
   - visibility and throttling of detached tabs;
   - renderer release after discard;
   - restore fidelity;
   - `beforeunload` handling.

   It runs in CI on `windows-latest`, with the test window kept always on top so native occlusion tracking can't skew results.

   **As built in M3.1:** `tests/lifecycle/discard.test.ts` starts the E2E fixture server and passes its origin to the app in `VELTRIVA_FIXTURE_ORIGIN`; the scenarios are in `src/main/testing/discard-scenarios.ts`. They cover what only real hidden tabs show: the page-state flush of a just-hidden tab, renderer release, `beforeunload` with real input, background restore at 125% scaling, and freezing.

   **As built in Phase 3 (the §9.3 memory benchmark):** `tests/benchmarks/memory.bench.ts` (`npm run bench:memory`, its own Vitest config, never part of `npm test`) runs the `memory-benchmark` scenario (`src/main/testing/benchmark-scenarios.ts`) through the same harness, with no Playwright attached, once per run: a fresh launch on a fresh profile, a warm-up per size, then the measured runs. The harness gained `switches` (here `--host-resolver-rules`, so each tab's page is on a site of its own, `m<i>.test`) and `timeoutMs`. The scenario pauses automation and makes every move itself; it is the only caller of `getAppMetrics()` while it runs, because the call resets the CPU interval for every caller (§9.3). The fixture server's `/cost/page` is spike S8's controlled-cost page. Raw readings go to `docs/benchmarks/data/`; the write-up reports them.

   **As built in M1.3a:**
   - **How it runs.** `npm run test:lifecycle` builds the test variant, then Vitest (`vitest.lifecycle.config.mts`, specs in `tests/lifecycle`) starts the app once per check with `VELTRIVA_LIFECYCLE_SCENARIO` set. The app runs that scenario (`src/main/testing/lifecycle-scenarios.ts`), prints one result line and exits. CI runs it after the E2E tests.
   - **Two checks so far:**
     - A tab that isn't selected reports `hidden` and is throttled: a 100 ms interval ticks about 3 times in 3 s, against about 30 times in the selected tab, which stays `visible`.
     - Closing the window with live tabs quits cleanly, with exit code 0, within 10 s. This check found a real bug: closing tabs after the window was destroyed threw, and Electron's error dialog kept the app open.
   - **M1.3b adds a third check:** a page under the raised shell (ADR-0006 A′) stays `visible` and unthrottled.
     - It takes the real path: a page goes fullscreen, the shell draws the notice and asks to be raised, and the page is measured under it.
     - Its first version raised the shell in its normal, opaque state, and the page went `hidden`. That is how we learned that A′ depends on a transparent document root.
5. **Installer smoke test**, without Playwright: install, launch, read back the fuses, assert that no test hooks exist, uninstall.
   - **As built in M6.1:** `package:dir` already refuses a build with test hooks (`check-production-build.mjs`). `check-packaged-app.mjs` now also reads the fuse wire back from `Veltriva.exe` (`scripts/fuse-wire.mjs`) and checks that the licenses ship. Installing and uninstalling come with the installer (M6.3).
   - **As built in M6.3:** `scripts/installer-test.ps1` runs an installer end to end on this machine. It covers install, the shortcuts and their AppUserModelID, the license files, the fuses read back from the installed `Veltriva.exe`, launch, both answers to the uninstaller's profile question, reinstall, `/S`, `/S --delete-app-data`, and with `-Upgrade` an upgrade over an install.
     - It presses the uninstaller's buttons with `BM_CLICK`, since UI Automation shows NSIS message-box buttons as panes, so the interactive path runs.
     - It renames the user's profile aside and restores it.
     - It is a script the user can run, not part of CI: it installs into the real per-user location.
6. **Security tests:**
   - a hostile fixture page;
   - malformed payloads for every IPC handler;
   - navigation guards;
   - the protocol blocklist.
7. **Accessibility:** `@axe-core/playwright` on shell views, plus a keyboard-only walkthrough.
   - **As built in M6.2:** `@axe-core/playwright` 4.13.0 (with axe-core 4.13.0), a dev dependency only. It is MPL-2.0, which is fine for a test tool that never ships; the license check covers what ships. 4.14.0 was eight days old, so the previous minor was taken.
   - **`tests/e2e/accessibility.spec.ts`** scans the shell page with WCAG 2.2 A and AA rules, in the light and the dark theme (`emulateMedia({ colorScheme })`), in each state a user reaches: the new-tab page with the toolbar and sidebar, Settings, Diagnostics, Welcome, the palette, the address bar's suggestions, a permission prompt, the downloads panel and an error page. Any violation fails the test with every node axe named.
   - **The keyboard-only walkthrough and the screen-reader checks** are the user's, in `docs/testing/accessibility.md` (Narrator).
8. **CI (GitHub Actions, `windows-latest`).**
   - Every PR: typecheck, lint, unit, integration and E2E tests, plus a license check (`scripts/third-party-notices.mjs --check`, M6.1).
   - `main`: also an unsigned NSIS build artifact.
   - Benchmarks run manually.
   - Releases are manual drafts; nothing is published automatically.
   - **As built in M6.3:** `ci.yml`'s steps are the local gates' npm scripts. Every step ran locally, in a fresh clone and as the milestone gates. `codeql.yml`, Dependabot and a draft-release `release.yml` were added, with actions pinned by SHA.
   - **As built in M6.4:**
     - **The memory benchmark records how loaded the machine was** at each run's start: free memory, commit charge, processor load and the ten largest processes. On a shared laptop a number means little without that. `BENCH_SIZES=100` runs the 100-tab size.
     - **The README's screenshots and GIFs are generated:** `npm run docs:images` runs `tests/docs-images/capture.spec.ts` (its own Playwright config, not part of E2E). It drives the test build on a demo web of `*.example` pages written for the project and served over TLS from this machine. It captures the whole window with `PrintWindow`, so the page under the shell is in the picture, and assembles the GIFs with ffmpeg when it is on the PATH.
9. **Tooling.**
   - TypeScript 6.0 with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
   - ESLint 10 (flat config), typescript-eslint (type-aware rules such as `no-floating-promises`) and Prettier.
   - TypeScript 7 and oxlint get revisited once typescript-eslint supports TypeScript 7.

## Consequences

- **Positive:** race conditions are explored systematically, not just through hand-written cases.
- **Positive:** no special test-runner tricks. Vitest can't run inside Electron, and with N-API it doesn't need to.
- **Negative:** packaged-build behavior is covered by a thinner smoke test rather than full E2E.

## Alternatives considered

- **Running Vitest under `ELECTRON_RUN_AS_NODE`.** Unsupported by Vitest, and unnecessary with N-API.
- **TypeScript 7 now.** Faster, but typescript-eslint doesn't support it yet.
