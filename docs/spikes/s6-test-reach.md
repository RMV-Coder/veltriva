# S6: Test reach (Playwright + WebContentsView)

| Question | Status | Result | Environment | Code |
|---|---|---|---|---|
| Can Playwright (`_electron`) reach the shell view and every tab `WebContentsView` of one `BaseWindow`, plus the main process? | Done | **Partly confirmed.** All three web contents are Pages and can be driven, and `electronApp.evaluate` reaches main. But Playwright makes hidden and detached tabs look visible, and the Page order is random. | Windows 11 10.0.26200, Electron 44.7.2 / Chromium 152, Node 24.13, playwright-core 1.64.1 | [`../../spikes/s6-test-reach`](../../spikes/s6-test-reach) |

## What we tested

- **The app** (`app-main.js`) is one `BaseWindow` (900×600) with three `WebContentsView`s. The shell loads a local `shell.html`. Tab A loads `form.html` from `a.test` and tab B loads `timers.html` from `b.test`, both from the shared fixture server. Tab B starts hidden with `setVisible(false)`.
- **The registry** is `globalThis.__veltrivaTest` (`tabs`, `shell`, `detach`, `attach`, `destroy`, `activate`, `createTab`, `load`, `isChild`, `executeIn`, `mainInfo`, ...). Tests call it through `electronApp.evaluate`.
- **The driver** (`run.js`) is a plain Node script using `playwright-core` 1.64.1. It launches the app as `_electron.launch({ executablePath: <spikes/node_modules/electron>, args: [app-main.js], env })`, with `ELECTRON_RUN_AS_NODE` removed from `env`.
- **Checks per launch** (question 2 a–e):
  - **a:** `windows()`, `context().pages()`, `firstWindow()`, telling pages apart, and `browserWindow(page)`.
  - **b:** interaction with the shell and the tabs, with a cross-check from the main process.
  - **c:** `electronApp.evaluate` against main.
  - **d:** detached versus destroyed tabs.
  - **e:** tabs created after launch.
- **Stability:** the full launch → checks → close cycle ran 10 times.
- **Environment pitfalls:**
  - A launch with `ELECTRON_RUN_AS_NODE=1`.
  - A launch without `executablePath`, where Playwright injects its own `loader.js`.
- **Two extra experiments**, added after the first results looked odd:
  - A control run with plain `spawn`, no Playwright and no inspector flags.
  - A raw-CDP bisect, with no Playwright, that toggles `Emulation.setFocusEmulationEnabled`.

## Results

All 10 cycles passed (0 failed cycles, 0 forced kills, 0 non-zero exit codes). No Electron process was left running. Raw data is in `spikes/s6-test-reach/results/` (`s6-test-reach.json`, `control-no-playwright.json`).

| Check | Observed | Verdict |
|---|---|---|
| a. `windows()` and `context().pages()` | Both list shell + tab A + tab B (3 Pages, identical sets). All 3 already exist when `launch()` resolves (10/10). A `window` listener added after launch never fires for them, so initial pages come from `windows()`. | Confirmed |
| a. Telling pages apart | URL and title are unique: shell `file://…/shell.html` "Veltriva Shell", A `http://a.test:PORT/form.html` "form", B `http://b.test:PORT/timers.html` "timers". `context.newCDPSession(page)` + `Target.getTargetInfo` returns a `targetId` equal to the app's `webContents.getOrCreateDevToolsTargetId()` for all 3 pages in 10/10 launches. | Confirmed |
| a. `firstWindow()` | Returns at once (about 0 ms), but which page it returns is arbitrary: shell 2, A 2, B 6 of 10 launches. `windows()` order took all 6 possible permutations in 10 launches. It does not throw or hang. | Refuted as a way to find the shell |
| a. `browserWindow(page)` | Resolves for the shell and both tabs to the owning `BaseWindow` (constructor name `BaseWindow`, same title). `BrowserWindow.getAllWindows()` is 0 and `BaseWindow.getAllWindows()` is 1. | Confirmed |
| b. Interaction | Shell: `click` + `textContent` work. Tab A: `fill`, `check` and `pressSequentially` work, and the values match what `webContents.executeJavaScript` reads from the main process. Tab B: `evaluate(window.__t)` works. `screenshot()` of the shell and of the visible tab A works. | Confirmed |
| c. `electronApp.evaluate` | Runs in main (`process.type === 'browser'`, `typeof document === 'undefined'`) and sees `globalThis.__veltrivaTest`. Arguments pass, a returned promise is awaited, and the `electron` module is the first parameter. `require` is **not** defined inside the evaluated function. Main-process `console.log` arrives as `electronApp` `console` events. | Confirmed |
| d. Detached tab (`removeChildView`, `WebContents` alive) | Still in `windows()` (same Page object), not closed, URL and title unchanged, `evaluate` works, timers advance. Not usable for rendering-dependent actions: `screenshot()` times out and `click()` times out (10/10). rAF delta is 0 over 1.3 s, so no frames are produced. After `attach`, the same Page works again, including `click()`. | Partly confirmed |
| d. Destroyed tab (`webContents.close()`) | The Page `close` event fires 6–14 ms after the call. `isClosed()` is true. The Page leaves `windows()` and `context().pages()`. `evaluate` rejects with "Target page, context or browser has been closed". Other pages are unaffected. `removeChildView` on an already-detached view did not throw. | Confirmed |
| e. Tab created after launch | `electronApp.on('window')` and `context.on('page')` each fire exactly once, about 100–160 ms after the view navigates. `waitForEvent('window')` registered before the action returns a usable Page that can be filled. A view that has **never navigated** is not reported (10/10, observed for 1.5 s) and appears only after `loadURL`. A navigated view that was **never attached** to the window is reported too (10/10). | Confirmed, with a navigation prerequisite |
| e. `page.close()` on a tab Page | Closes the `WebContents` through `webContents.close()` and the Page emits `close`. Electron also drops the dead view from `contentView.children` (10/10). It skips any app-side bookkeeping. | Info |
| Hidden tab, as seen by the page | Under Playwright, tab B hidden with `setVisible(false)` reports `visibilityState === 'visible'`, its 100 ms timer ticks 13 times per 1.3 s (unthrottled), rAF runs at about 60 per second, and `click()` works in about 100 ms (10/10). Detached views also report `visible` with unthrottled timers. **Control without Playwright:** the same states are `hidden`, 1 tick per 1.3 s and 0 rAF. **Bisect:** with a raw CDP session, `Emulation.setFocusEmulationEnabled(true)` flips `hidden` to `visible`, 13 ticks and 84 rAF. Setting it back to `false` restores `hidden`. Playwright's source (`crPage`) sends that command to the main-frame session of every page it attaches to. Calling it with `false` from a second CDP session on a Playwright-driven page did not help (still `visible`, 10/10). | Refuted: Playwright hides hidden-ness |
| Stability, 10 full cycles | 10/10 OK. `launch()` resolves in median 566 ms (min 503, max 762). All 3 Pages are visible by median 567 ms (504–763). `close()` takes median 207 ms (199–671). A whole cycle takes median 12.3 s (12.1–12.9), mostly deliberate waits. | Confirmed |
| `ELECTRON_RUN_AS_NODE=1` | `_electron.launch` rejects after about 1.1 s with `electron.launch: Process failed to launch!`. The log shows `electron.exe: bad option: --remote-debugging-port=0` and exit code 9 (raw spawn gives the same). Playwright also leaves 3 unhandled promise rejections ("Process failed to launch!"). In a bare Node script without a handler this terminated the whole process with a stack trace in an earlier run. | Confirmed (expected failure, plus the unhandled-rejection detail) |
| Launch mode: with and without `executablePath` | Both reach all 3 Pages. With `executablePath` (used here) there is no loader: the app sees `--inspect=0 --remote-debugging-port=0` in `process.argv`, and `disable-renderer-backgrounding` and `disable-backgrounding-occluded-windows` are **not** set. Without `executablePath` Playwright adds `-r loader.js`: those flags are stripped from `argv` and the two Chromium switches **are** set. | Info |

## What this means for the design

**Keep ADR-0008 item 4 as written.** `WebContentsView`s are reachable as Pages, `electronApp.evaluate` reaches main, and `ELECTRON_RUN_AS_NODE` must be cleared. Add the following rules to it.

1. **Find pages by identity, never by position.** `firstWindow()` and `windows()[0]` are random, so they must not be used to get the shell.
   - Shell page: the one whose URL is the shell URL (a custom-protocol prefix in the real app), optionally confirmed with a `window.__shell`-style marker.
   - Tab page: have the test hook `getTabStates()` return each tab's `webContents.getOrCreateDevToolsTargetId()`. A test helper maps that to a Page with `context.newCDPSession(page)` and `Target.getTargetInfo`. Matching on URL is fine when URLs are unique in the test.
   - Helper shape: `pageForTab(app, tabId)` and `shellPage(app)`, each polling `app.windows()` until found.
2. **New tabs.** Register `electronApp.waitForEvent('window')` *before* the action that opens the tab. The Page arrives once the view first navigates, so a tab with no navigation is invisible to Playwright. A real new tab loads a new-tab page, so this should hold. Pages that exist at launch come only from `windows()`.
3. **Do not assert hidden-tab behavior through a Playwright Page.** Playwright's per-page focus emulation makes `visibilityState`, timer throttling and rAF look "visible" for tabs the app has hidden or detached.
   - Check these in main-process-only runs (the control in this spike, and S1's approach) or in the model-based tests.
   - E2E should assert app state (`getTabStates()`, tab strip in the shell), not renderer-observed throttling.
   - A second CDP session cannot undo the emulation.
4. **Act on a tab only while it is attached to the window.** `click()` and `screenshot()` time out on a detached view (no frames), while `evaluate` still works. Tests should switch to the tab through the shell, as a user does, before driving it. Reading state from a parked tab with `evaluate` is fine.
5. **Do not call `page.close()` on a tab Page.** It closes the `WebContents` behind the app's back. Close tabs through the shell UI or a test hook that goes through TabManager.
6. **Launch with `executablePath`** (the unpackaged `electron.exe` plus `args: [mainJs]`). That keeps Chromium's background and occlusion behavior closer to the shipped app, because the loader mode adds `disable-renderer-backgrounding` and `disable-backgrounding-occluded-windows`. The app's argument parsing must tolerate `--inspect=0 --remote-debugging-port=0`.
7. **Guard the environment.** Add a pre-launch assertion that `ELECTRON_RUN_AS_NODE` is unset. When it is set, the failure is a generic "Process failed to launch!" plus stray unhandled rejections, which is hard to diagnose.
8. **Fuse requirement.** Playwright's documentation says the `EnableNodeCliInspectArguments` fuse must not be `false` ([class Electron](https://playwright.dev/docs/api/class-electron)). I did not touch fuses or the Electron binary. If release builds turn that fuse off (inferred, not checked), E2E cannot drive the packaged app. That is consistent with "built but unpackaged" in item 4, and the installer smoke test (item 5) then must read the fuses back.

## Caveats and follow-ups

- **One machine, one run of each experiment.** The timings are indicative only. Other spikes were running Electron concurrently. In an earlier complete run, before the final probe tweaks, two `close()` calls took 7.3 s and 10.6 s under load; all cycles still passed. Use at least a 30 s launch/close timeout in CI.
- **Unpackaged build only.** A packaged app with release fuses was not tested and no fuse was changed.
- **Inferred, not observed:**
  - Why a second CDP session cannot undo the focus emulation. The likely reason is that the state stays on while Playwright's own session has it on.
  - Why detached views make no frames. The likely reason is that they have no native surface.
  - The exact moment the `window` event fires relative to the `load` event. I only saw it fire after navigation starts and before the first 100 ms timer tick.
- **Not covered:** popups (`window.open`), cross-site iframes as `Frame`s, renderer crash (`crashRenderer` and `page.on('crash')`), `beforeunload` on `page.close({ runBeforeUnload })`, native dialogs, and multiple `BaseWindow`s.
- **Playwright's focus emulation also affects focus:** `document.hasFocus()` and focus-related tab behavior will differ from real use. This was not measured here.
- **Generated artifacts:** running the spike creates `spikes/s6-test-reach/user-data/` (an Electron profile, ignored by the repository's `spikes/**/user-data/` rule) and `spikes/s6-test-reach/results/` (small JSON files, committed on purpose as evidence).
- **Follow-up for S1:** the control experiment here (`setVisible(false)` and detach give `hidden`, 1 tick per 1.3 s and 0 rAF without Playwright) is a small data point for it, but S1 owns the full lifecycle matrix.

## How to reproduce

From `C:\GitHub\Veltriva\spikes` (dependencies already installed; no `npm install` needed):

```
cd C:/GitHub/Veltriva/spikes
timeout 300 node s6-test-reach/run.js
```

It takes about 2.5 minutes. It runs the 10 cycles, then the `ELECTRON_RUN_AS_NODE=1` launch, the launch without `executablePath`, the no-Playwright control, and the raw-CDP bisect. Results go to `spikes/s6-test-reach/results/s6-test-reach.json` (and `control-no-playwright.json`). The exit code is 0 when all cycles pass.

Shortcuts for development:

- `S6_CYCLES=1 node s6-test-reach/run.js` runs a single cycle.
- `S6_ONLY=bisect|control|runAsNode|loader node s6-test-reach/run.js` runs just one extra phase.
