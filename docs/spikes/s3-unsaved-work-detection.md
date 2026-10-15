# S3: Unsaved-work detection

| Question | Status | Result | Environment | Code |
|---|---|---|---|---|
| **A.** Does `webContents.close({ waitForBeforeUnload: true })` plus `will-prevent-unload` report a page that objects to unloading, with no dialog, even for a page the user never touched? | Done | **Confirmed.** `will-prevent-unload` fires within 1–18 ms (typically under 10), the page stays alive and usable, no dialog appears, and `close()` itself grants the user activation that lets untouched pages object. | Windows 11 10.0.26200 (125% display scaling), Electron 44.7.2 / Chromium 152, Node 24.13 | [`../../spikes/s3-unsaved-work`](../../spikes/s3-unsaved-work) |
| **B.** Do `input-event`, `before-input-event` and `before-mouse-event` report scripted input, including inside a cross-site iframe? | Done | **Partly confirmed.** All three fire for scripted input in the top frame, with different `type` names and `input-event` including `mouseMove`. `sendInputEvent` cannot reach a cross-site iframe at all. Routed (CDP) input in the iframe fires only `before-mouse-event` in the parent. | same | same |
| **C.** Does the isolated-world probe flag unsaved form input, stay isolated from the page, and fit its 100 ms budget? | Done | **Partly confirmed.** It detects `input`, `textarea`, `select` and checkbox changes, is isolated, and costs 0.3 ms warm and 11 ms cold. It misses React-style inputs (predicted) and also misses `contenteditable` edits once the field is blurred (not predicted). It sees the top frame only. | same | same |

Labels used below: **observed** means measured in this spike; **inferred** means reasoned from observations and not tested directly.

## What we tested

- **Setup.** One 900x600 always-on-top `BaseWindow`, tabs created with the shared hardened preferences (`TAB_PREFS`), the shared loopback fixture server, and `a.test` / `b.test` as two different sites. A session permission handler denied everything before any page loaded (the only denial logged was a `background-sync` permission check, probably from `sendBeacon`, not investigated; no `openExternal`). A new view per scenario. "Detached" means `removeChildView`, our model of a hidden tab. Destroyed views are always removed from the window.
- **Real input.** Typing and clicking went through `webContents.sendInputEvent` (`mouseDown`/`mouseUp`, then `keyDown`/`char`/`keyUp` per character). Every helper checks that the text really arrived in the element and retries otherwise. In the three final runs the first attempt always worked.
- **Part A, `beforeunload.html?mode=always|dirty|never`.** `close({ waitForBeforeUnload: true })` with and without `event.preventDefault()` in the `will-prevent-unload` handler, on untouched pages, on `dirty` pages after real typing (attached and detached), on a page dirtied only by script, and on `never` pages. Plain `close()` on untouched pages. A cross-site child frame that holds the handler (A6). "No dialog" was checked three ways: the page stayed responsive, the run was never blocked, and `user32 EnumWindows` for the Electron main process listed the same single window before and during the wait. To see which page events a plain `close()` runs, handlers for `beforeunload`, `pagehide`, `unload` and `visibilitychange` wrote to `localStorage`, sent a beacon and logged to the console. Timing: 5 repetitions per scenario, attached and detached, repeated in 3 full runs (15 samples each).
- **Part B.** A scripted sequence on `form.html` (5 `mouseMove`, `mouseEnter`/`mouseLeave`, a click, 2 wheel events, typing "abc", a Tab key) with all three listeners attached, plus two controls (`executeJavaScript(code, true)` and page-synthesised DOM events). Then `iframe-parent.html` from `a.test` with the `b.test` child: `sendInputEvent` clicks at the iframe's coordinates, typing after focusing the child programmatically, and the same input through the Chrome DevTools Protocol (CDP) for comparison.
- **Part C, `PROBE_SOURCE` via `executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, ...)`.** Each field of `form.html` on a fresh page; `sensitive.html`; world isolation in both directions, including a page that overrides `HTMLInputElement.prototype.value` and `navigator.userActivation`; the cross-site iframe; `webFrameMain.executeJavaScript` world and API surface; things that could flip `hasBeenActive`; cost (cold, warm, hidden, 2000 inputs, busy renderer). Two exploratory extras that S3 did not ask for: a trusted-input tracker living in the isolated world, and CDP `Page.createIsolatedWorld` inside the cross-process child.
- **Protocol.** Three consecutive full runs of `main.js`, all with the same outcome (A: 0 unexpected results; C: 0; B: the three deliberate refutations below). Run time about 53 s each. Raw rows are in `spikes/s3-unsaved-work/results/*.json` (last run).

## Results

### A. `close({ waitForBeforeUnload })` and `will-prevent-unload`

| Check | Observed | Verdict |
|---|---|---|
| A1. Untouched page, `mode=always`, `close({ waitForBeforeUnload: true })`, handler present, no `preventDefault()`: is `will-prevent-unload` emitted? | Yes, once, 1.4–3.1 ms after the call. `navigator.userActivation.hasBeenActive` was `false` before the call; the fixture's `beforeunload` beacon says `objected=true`. | Confirmed |
| A1. Is the page still alive 3 s later? | Yes. `isDestroyed()` false, no `destroyed` event, page still answers `executeJavaScript`. | Confirmed |
| A1. Did any dialog appear? | No. The process's only top-level window was the spike window, before and 1.5 s into the wait; the run never blocked. | Confirmed |
| A1. Side effect of the attempt | `hasBeenActive` flipped `false` to `true` and stays true. | Observed; supports §4.9 step 5's reading of Electron's source |
| A2. Plain `close()` on the same (now activated) page | `isDestroyed()` is still `false` right after the call; `destroyed` arrives 4.2–5.2 ms later. No `will-prevent-unload`. | Confirmed |
| A2. What the page sees on plain `close()` | No `beforeunload`, `pagehide` or `unload`: no evidence in `localStorage` or in beacons (the fixture server received none of them), while `visibilitychange` did leave evidence on both. The console channel is lossy on plain `close()` (it missed even `visibilitychange`), so it proves nothing there. By contrast, `close({ waitForBeforeUnload })` on a page that does not object ran `beforeunload`, `visibilitychange`, `pagehide` and `unload`. | New finding |
| A3 control. `mode=dirty`, never touched | Closes normally, no objection, `destroyed` after 9–12 ms. | Confirmed |
| A3. `mode=dirty` after real typing ("hi"), `close({ waitForBeforeUnload: true })`, no `preventDefault()` | `will-prevent-unload` once, 0.9–1.2 ms. Page alive after 3 s, text intact, and it accepted more typing ("hi!"). No new window. Beacon: `dirty=true`, `objected=true`. | Confirmed |
| A3. Same page, second attempt with `event.preventDefault()` in the handler | Handler ran, page closed: `destroyed` 5.2–6.3 ms later; `pagehide` beacon delivered. | Confirmed |
| A3h. Same as A3 with the view detached (hidden tab) | `will-prevent-unload` at 1.3–1.8 ms, page alive; with `preventDefault()` it was destroyed in 2.6–3.1 ms. | Confirmed |
| A3s. Page dirtied by script only (no input, `hasBeenActive` false), `close({ waitForBeforeUnload })` | `will-prevent-unload` still emitted (1.4–2.4 ms): `close()` supplies the activation. | Confirmed |
| A4. `mode=never`, even after real typing | Closes normally: no `will-prevent-unload`; `beforeunload` (`objected=false`) and `pagehide` ran; `destroyed` after 6.0–6.7 ms. | Confirmed |
| A6a. Handler in a cross-site child frame (`b.test`), nobody touched anything | The child's `beforeunload` ran and objected, but **no** `will-prevent-unload`; the page was destroyed after 6.9–7.8 ms. `close()` activates only the top frame, so the child's objection is ignored. | Observed |
| A6b. Same, child `mode=dirty`, typed into via CDP-routed input | `will-prevent-unload` at 1.1–2.4 ms, page kept alive. | Observed |

**A5. Timing** (ms, pooled over 3 full runs x 5 repetitions: median [min-max], n = 15; per-run medians in the JSON):

| From `close()` to ... | Attached view | Detached view |
|---|---|---|
| `will-prevent-unload`, `mode=always`, untouched | 3.9 [3.3-8.5] | 5.4 [4.0-17.7] |
| `will-prevent-unload`, `mode=dirty` after real input | 0.9 [0.6-1.6] | 1.7 [1.1-6.8] |
| `destroyed`, `mode=never`, `waitForBeforeUnload` | 12.6 [8.9-17.7] | 9.5 [5.8-136.9] |
| `destroyed`, `mode=always`, `waitForBeforeUnload` + `preventDefault()` | 14.6 [11.2-17.9] | 9.9 [7.3-78.7] |
| `destroyed`, plain `close()` | 4.9 [3.7-6.2] | 1.4 [0.9-2.2] |

The detached outliers (up to 137 ms) happened while other spikes' Electron processes were running on the same machine; the typical value is under 20 ms.

### B. Input observation in the main process

| Check | Observed | Verdict |
|---|---|---|
| Idle page, controls | 0 events while idle; 0 events for `executeJavaScript(code, true)`; 0 events for page-synthesised `MouseEvent`/`KeyboardEvent`. | Confirmed (events come only from the browser's input path) |
| `mouseMove` x5 | `input-event` `mouseMove` x5 **and** `before-mouse-event` `mouseMove` x5. | Confirmed: `input-event` includes `mouseMove` |
| `mouseEnter` / `mouseLeave` | Both listeners fire for each. | Observed |
| Click (`mouseDown` + `mouseUp`) | Order: `before-mouse-event:mouseDown`, `input-event:mouseDown`, `before-mouse-event:mouseUp`, `input-event:mouseUp`. | Confirmed |
| `mouseWheel` x2 | `input-event` only: `mouseWheel` x4, `gestureScrollBegin` x2, `gestureScrollUpdate` x2, `gestureScrollEnd` x2. `before-mouse-event` does not fire for wheel. So `input-event` also reports events the browser synthesises. | Observed |
| Typing "abc" (`keyDown`, `char`, `keyUp` each) | `before-input-event`: `keyDown` x3, `keyUp` x3 (never `char`). `input-event`: **`rawKeyDown`** x3, `char` x3, `keyUp` x3. The `type` names differ between the two events. | Partly confirmed: both fire, names differ |
| Tab key (`keyDown` + `keyUp`) | `before-input-event` `keyDown`/`keyUp`; `input-event` `rawKeyDown`/`keyUp`. | Observed |
| Totals for the whole scripted sequence | `before-mouse-event` 9 (5 move, 1 enter, 1 leave, 1 down, 1 up); `before-input-event` 8 (4 `keyDown`, 4 `keyUp`); `input-event` 30 (5 `mouseMove`, 1 `mouseEnter`, 1 `mouseLeave`, 1 `mouseDown`, 1 `mouseUp`, 4 `mouseWheel`, 2+2+2 gesture scroll, 4 `rawKeyDown`, 3 `char`, 4 `keyUp`). | Observed |
| Cross-site iframe, geometry | The child is a separate process (`processId` differs). The target point (102.8, 177.9) hit-tests to the `<iframe>` in the parent; the display scale is 1.25 and CSS pixels matched `sendInputEvent` coordinates. | Observed |
| Route 1: `sendInputEvent` click at the iframe's coordinates, 3 clicks after a 1 s wait, then "xy" | The child's input never got focus (child `activeElement` stayed `BODY`; the parent's `activeElement` became the `<iframe>`), the child value stayed "child initial", 0 `child-input` beacons. The parent fired `before-mouse-event` and `input-event` (`mouseDown`/`mouseUp` x3) and the keyboard events for "xy", although the child received nothing. | **Refuted** |
| Route 3: child input focused via `frame.executeJavaScript`, then "pq" with `sendInputEvent` | The child value did not change. Parent keyboard events fired as above. | **Refuted** |
| Route 2: CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` | The click focused the child input on the first try; "rs" reached it (value "child initialrs", 2 beacons). Parent events: **`before-mouse-event` only** (`mouseMove`, `mouseDown`, `mouseUp`); **no `input-event`**; typing produced **no event at all** in the parent. | Observed |

### C. Isolated-world probe

| Check | Observed | Verdict |
|---|---|---|
| `form.html` untouched | `{ dirty: [], focusedEditable: false, sensitive: false, hasBeenActive: false }`; the same after a second probe and after real `mouseMove` only. | Confirmed |
| Click into `#text` with no edit | `focusedEditable: true`, `dirty: []`, `hasBeenActive: true`. | Observed: focus alone is not dirty |
| `#text`, `#area` typed (real input) | `dirty: ["text"]`, `dirty: ["area"]`. | Confirmed |
| `#sel` changed by a real ArrowDown key (select focused programmatically, because clicking opens a native popup) | `dirty: ["sel"]`. | Confirmed |
| `#chk` toggled by a real click | `dirty: ["chk"]`. | Confirmed |
| `#reactish` typed ("hello") | `value` and `defaultValue` both "hello"; `dirty: []`. | Confirmed: false negative |
| `#ce` (`contenteditable`) focused by a real click | `focusedEditable: true`, `hasBeenActive: true`; before any input both were `false`. | Confirmed |
| `#ce` typed into, then blurred (click on a heading) | While focused, `dirty` stays `[]`; after blur `focusedEditable: false` and `dirty: []`. The probe never reads `contenteditable` content, only its focus. | **Refuted** (the §4.10 wording "a focused or edited `contenteditable`") |
| Programmatic `.value` change with no events, then restoring the original value | `dirty: ["text"]`, then `dirty: []`. The probe needs no `input` events. | Observed |
| `sensitive.html` | `sensitive: true`. Removing the password field keeps it `true` (via `autocomplete="cc-number"`); removing both gives `false`. | Confirmed |
| Isolation: `window.__secret = 1` in the main world | Main world `'number'`, probe world `'undefined'`; a variable set in the probe world is `'undefined'` in the page. | Confirmed |
| Isolation under attack: the page overrides `HTMLInputElement.prototype.value` and `navigator.userActivation` | The page reads "initial" and `hasBeenActive: false`; the probe still reports `dirty: ["text"]` and `hasBeenActive: true`. | Confirmed |
| Cross-site iframe: child input edited (CDP-routed input), main-frame probe | `dirty: []`, `focusedEditable: false`: blind to the child. The same source run through the child's `webFrameMain.executeJavaScript` sees `dirty: ["child-text"]`. | Confirmed (expected no) |
| Activation across frames | Before the child edit: top frame `false`, child `false`. After: both `true`. The top-frame probe's `hasBeenActive` covers iframe interaction its DOM scan cannot see. | Observed |
| `webFrameMain.executeJavaScript` in a cross-process subframe | Runs, in the **main world** of that frame: `typeof report` is `'function'` and `typeof mode` is `'string'` (page globals of the injected `beforeunload.html`). On the main frame it shares the world of `webContents.executeJavaScript`. `WebFrameMain` has no isolated-world method (only `executeJavaScript` matches /execute\|isolated\|world/). | Confirmed |
| Exploratory: CDP `Target.setAutoAttach` (flatten) + `Page.createIsolatedWorld` + `Runtime.evaluate` | The probe ran inside the cross-process child in an isolated world (`dirty: ["child-text"]`, 0.8–1.5 ms); a main-world variable in the child was invisible to it. | Observed |
| `hasBeenActive` pollution | Stays `false` after isolated-world calls and `webContents.focus()`; becomes `true` after `executeJavaScript(code, true)`. A cancelled `close({ waitForBeforeUnload })` also sets it (A1). It survives `history.pushState` and resets on a cross-document navigation to the same site. | Observed |
| Exploratory: trusted `input` listener installed in the isolated world right after load | After typing in `#reactish` and `#ce` (then blurring) the tracker had 4 trusted events (targets `reactish`, `ce`) while the value probe said `dirty: []`. A page-registered `window` capture listener with `stopImmediatePropagation()` hides the input from it (0 events). | Observed |
| Cost (ms, 3 runs, n = 30 each): median [min-max] | `executeJavaScript("1")` baseline 0.32 [0.16-0.68]. Probe warm, attached: 0.29 [0.14-1.11]. Warm, detached: 0.47 [0.27-43.3]. **Cold, first call on a fresh page: 10.9 [7.1-16.8]** (world creation). Page with 2000 inputs and 200 selects: 4.0 [2.3-10.8]. | Observed |
| Renderer busy for 700 ms | A `Promise.race` with a 100 ms timer fired at 100 ms; the probe itself returned only after 673-682 ms. The probe cannot pre-empt page JavaScript. | Confirmed: the budget must be enforced by the caller |

## What this means for the design

Reference points: technical assessment §4.9 (procedures, step 5), §4.10 (protection table and limits) and ADR-0003 decision 5.

**Keep.**

- **§4.9 step 5, both branches and the reason for the split.** An untouched page that always objects does pin itself under `waitForBeforeUnload` (A1: objection surfaced after 1.4-3.1 ms, page alive after 3 s), and a plain `close()` destroys it in about 5 ms. The assessment's reading of Electron's source is correct: `close()` supplies the user activation (A1, A3s).
- **"We don't override it."** Without a `preventDefault()` the close is silently cancelled, no dialog appears, and the page stays fully usable: typed text intact, input still accepted (A3). Calling `preventDefault()` closes the page (A3), so the handler must not do it.
- **The *page reports unsaved changes* row of §4.10.** Works for detached (hidden) views (A3h) and, when the child frame has had its own user interaction, for a cross-site iframe (A6b). It is blind to a child that has not been interacted with (A6a), which fits the gating below.
- **The form probe as a hard protection for `input`, `textarea`, `select` and checkbox**, and the stated false negative for React-style controlled inputs (confirmed). Isolation holds even against prototype tampering. `sensitive` works for password and `cc-*` fields.
- **The 100 ms budget** is ample for normal pages (0.3 ms warm, 11 ms cold, 4 ms for a 2200-control page).
- **"Top frame only"** for isolated-world scripts through the `webFrameMain` API: confirmed (only `executeJavaScript`, main world).

**Change.**

1. **Gate step 5 on user activation read in the step 3 probe, not only on "real input observed".** `hasBeenActive` is exactly Chromium's own rule for whether an objection counts. It stays `false` for hover and focus (section C), flips on a click or key press, resets on a cross-document navigation and survives `pushState` (which matches "since its last navigation"), and it also flips in the top frame when a cross-process child is used (see "Activation across frames" in section C), which the input observers cannot be shown to cover (section B). Rule: read it from the probe result **before** any close attempt; `true` takes the `waitForBeforeUnload` path, `false` takes plain `close()`. Keep the observer-based flag for the soft *recent interaction* guard only. Two things corrupt the gate: a cancelled `close({ waitForBeforeUnload })` sets it permanently (A1), and `executeJavaScript(code, true)` sets it (section C), so no code path may pass `userGesture = true` to a tab it later gates on.
2. **Treat `will-prevent-unload` as the decisive signal, and clean up listeners.** `will-prevent-unload` is the decisive signal: it arrived within 0.6-8.5 ms attached and 1.1-17.7 ms detached, while `destroyed` arrived within 9-18 ms (detached outliers to 137 ms under load). The 5 s "no `destroyed`" rule can stay as a backstop for slow handlers, but register `will-prevent-unload` before `close()` and remove both listeners after the outcome. A leftover `destroyed` listener from a cancelled attempt fires on a later close of the same page; this bit the spike's own harness.
3. **Treat a plain `close()` as a hard unload with almost no page callbacks.** The page gets `visibilitychange` but no `beforeunload`, `pagehide` or `unload` (A2). Autosave code that only listens to `pagehide` will not run on an untouched tab. §4.9 and §4.10's "limits we state openly" should say so.
4. **Correct the §4.10 wording for `contenteditable`.** Replace "a focused or edited `contenteditable`" with "a focused `contenteditable`; edits are not detected after blur". The probe also reports `focusedEditable: true` after a plain click into an empty, untouched field, so treat `focusedEditable` alone as a weaker (soft) signal than `dirty`.
5. **Consider a trusted `input` tracker in the isolated world** (exploratory, see the tracker row in section C). Installed on every `dom-ready`, it caught both false negatives (`#reactish`, blurred `#ce`) with 4 of 4 trusted events and no discard-time cost. It is blind to pages that stop propagation at the window in the capture phase, resets with the document, and was not tested across navigations. Use it in addition to the value probe, not instead of it.
6. **Fix the type names in the §4.10 *Recent interaction* row.** `input-event` reports `rawKeyDown` / `char` / `keyUp` and mouse types including `mouseMove`, `mouseEnter`, `mouseLeave`, `mouseWheel` and browser-synthesised `gestureScroll*`; `before-input-event` reports `keyDown` / `keyUp` only; `before-mouse-event` reports mouse types but not wheel. The handlers must be O(1): a stamp, nothing else. Register all three and stamp on any of them.
7. **Do not claim iframe input is covered by the observers.** We could not feed real input to a cross-process child with `sendInputEvent`; with CDP-routed input the parent saw only `before-mouse-event` for the click and nothing for the keystrokes, and no `input-event` at all. Real OS input needs a check (see caveats). Until then, the iframe protection rests on `hasBeenActive` (change 1) and the child's own `beforeunload` (A6b).
8. **If iframe forms matter, a CDP route exists.** `webContents.debugger` with `Target.setAutoAttach` and `Page.createIsolatedWorld` ran the probe in a cross-process child in about 1 ms. That lifts the *top frame only* limit, at the price of attaching the debugger to every tab it probes. Needs a security and compatibility review before it goes into the design.
9. **Enforce the probe budget in the caller.** A busy renderer delays the probe by the length of the busy loop (about 680 ms for a 700 ms loop). Wrap it in a timeout and treat a timeout as "unknown, keep the tab" (a hard protection for that attempt).
10. **For E2E tests (S6 relevance).** `sendInputEvent` cannot drive a cross-site iframe, and it needs a focused window: in early runs input was silently dropped, intermittently, while other spikes' Electron processes were running (cause not established). Use CDP for iframe input and verify that input arrived.

## Caveats and follow-ups

- **`sendInputEvent` is not OS input.** It goes straight to the root widget and, by observation, never reaches a cross-process child. Real mouse and keyboard input takes Chromium's normal path with its frame router, so whether `input-event`, `before-input-event` and `before-mouse-event` fire for real typing inside a cross-site iframe is **not verified**. The assessment assigns this check to S1. IME composition, autofill, paste via the context menu and drag-and-drop were not tried either.
- **Why the iframe results are inferred.** That `sendInputEvent` feeds only the root widget is inferred from the refuted routes 1 and 3 plus Chromium's design; we did not read the source. The CDP route is also not identical to OS input, so the "only `before-mouse-event`" observation may differ for real input.
- **Fixtures, not real sites.** `beforeunload.html` is the simplest possible handler. Google Docs, GitHub, Jira and mail compose were not tested (external sites were out of scope). Handlers that run long, call `confirm()`, or register only after the first edit may behave differently.
- **Hidden means detached here.** `setVisible(false)` and a fully occluded window were not measured. The window was kept always-on-top so occlusion would not hide pages.
- **One machine, shared with other spikes.** Timings come from a single 125%-scaling display with other Electron processes running at times. Medians are stable across the three runs; the maxima are not.
- **Focus dependence of the test method.** Electron documents that `sendInputEvent` needs a focused window. In early runs input was dropped intermittently while other spikes' Electron processes were running (`win.isFocused()` and `document.hasFocus()` still reported `true`; the cause was not established). The final code verifies input and retries; every final-run check passed on the first attempt. Not diagnosed further (occlusion, foreground changes or CPU contention are all plausible).
- **Not tested:** the isolated-world input tracker across navigations and reloads; the debugger's side effects on pages and DevTools; autofill-filled fields and the probe; `webContents.close()` on a page with a long-running `beforeunload`; behavior after `render-process-gone`.
- **Recorded Node version.** The result files record `node` 24.21.0, the Node bundled in Electron 44.7.2. The system Node used to launch scripts is 24.13.0.
- **Shared code.** No change to `spikes/shared/` is needed. The run leaves a `user-data/` folder in the spike directory, already covered by `.gitignore`.

## How to reproduce

From Git Bash, in `C:/GitHub/Veltriva/spikes` (dependencies already installed):

```bash
cd C:/GitHub/Veltriva/spikes
timeout 180 ./node_modules/.bin/electron s3-unsaved-work/main.js              # parts A, B and C, about 55 s
timeout 180 ./node_modules/.bin/electron s3-unsaved-work/main.js --part=a     # or b, c, or a,c
```

- Output lines are `PASS`, `FAIL` or `INFO`. `FAIL` means "the pre-run expectation was not met", not "the run broke". The three `FAIL` rows in part B are the refuted `sendInputEvent`-into-iframe routes. Exit code 0 means the run finished; 2 means it crashed; 3 means the fail-safe (175 s) fired.
- Results: `spikes/s3-unsaved-work/results/a-before-unload.json`, `b-input-events.json`, `c-probe.json`.
- Files: `main.js` (runner), `a-before-unload.js`, `b-input-events.js`, `c-probe.js`, `lib.js` (helpers: input, focus, CDP input, close observer, statistics), `list-windows.ps1` (window enumeration for the "no dialog" check; its one-off compile takes a few seconds in the background).
- Keep the machine otherwise idle while it runs, and do not touch the spike window: input is delivered by `sendInputEvent`, which needs the window focused.
