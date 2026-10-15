# S2: Restore fidelity of navigationHistory.restore()

| Question | Status | Result | Environment | Code |
|---|---|---|---|---|
| Does `navigationHistory.restore()` bring back the back/forward stack, scroll position and form values, both from in-memory page state and from persisted URL/title-only entries? | Done | **Partly confirmed.** The stack, titles and URLs come back from both kinds of entries. Scroll and plain form values (text, textarea, select, checkbox) come back only from in-memory `pageState`, and only if the view is attached to the window before `restore()` and `pageState` is fresh. Controlled inputs that sync their `value` attribute and `contenteditable` content are never restored. | Windows 11 10.0.26200, Electron 44.7.2 / Chromium 152, Node 24.13 | [`../../spikes/s2-restore`](../../spikes/s2-restore) |

## What we tested

- **Fixtures.** The shared fixture server only: `/article?n=200&title=…` (200 paragraphs with ids `p0`…`p199`) and `form.html`. A small (800×600) always-on-top window, so Windows occlusion tracking does not mark the page `hidden` and skew timings. Every timing below is recorded together with `document.visibilityState`. A session permission handler denies everything, including `openExternal`, `window.open` is denied, and non-local requests are cancelled. The run recorded 0 blocked requests and 0 permission requests.
- **Two 3-entry layouts.**
  - `formMiddle`: `/article?n=200&title=A` → `/form.html` → `/article?n=200&title=C`. This is the layout from the brief. Edits: A scrolled to `#p60`, the form filled in, C (active) scrolled to `#p120`.
  - `formActive`: A → C → `/form.html`. The form is the active entry, filled in and scrolled to y = 1500. This tests the active entry's form state directly. (A first version scrolled to the bottom of the form page. That position is clamped by the page height, so it proved little and was replaced.)
- **Form edits** are made through `webContents.executeJavaScript` in the page's main world: set `.value`/`.checked`/`.textContent`, then dispatch `input` and `change` events. `#reactish` syncs its `value` attribute on every input event (React emulation).
- **Discard and restore.** Snapshot `getAllEntries()` + `getActiveIndex()`, then the shared `destroyView` plus a wait for `destroyed`, then a brand-new view with `restore({ entries, index })`. Verification walks the restored tab: the active page, `goBack()` twice, `goForward()` twice. Scroll is compared within ±1 px and polled for 400 ms. Each configuration ran 3 times (2 for the attach-order variants), reported as k/n.
- **Snapshot modes.**
  - `full-settled`: wait until the active entry's `pageState` reflects the edit, then snapshot.
  - `full-flushed`: force an update with `history.replaceState(history.state, '')` and snapshot about 50 ms later (found in Q4).
  - `full-immediate`: snapshot right after the edit (the "Archive now" case).
  - `persisted`: `{ url, title }` only.
- **Marker technique.** `pageState` is a base64 string of Chromium's serialized page state. Form values are stored in it as UTF-16 text, so `psHas(pageState, value)` shows whether a value has been captured.
- **Freshness (Q4).** After each load, wait until the active entry's `pageState` has been quiet for 1.3 s. Apply one edit, then poll `getAllEntries()` every 100 ms for up to 10 s. Trials: 5 attached (visible) and 3 detached (`removeChildView`, hidden) for each of scroll and form. Then 14 trigger configurations were checked for an immediate flush (polled every 25 ms for 1.5 s).
- **Failures (Q5).** A closed loopback port, an HTTP 404 URL, a slow URL, a retry on the same web contents, and damaged input (bad index, empty entries, unparsable or empty URL, missing title, garbage or empty `pageState`).
- **Order (Q6).** The same snapshot restored on a brand-new view, after `await loadURL('about:blank')`, right after an un-awaited `loadURL('about:blank')`, after loading a real page, and after an earlier `restore()`.
- **Display.** The only display is 1920×1080 at 125 % (device scale factor 1.25). Extra runs forced the factor to 1 and 2 with `--force-device-scale-factor`.

## Results

Raw data is in `spikes/s2-restore/results/`. "Settled" means the active entry's `pageState` had caught up with the edit before the snapshot.

### Q1: what `navigationHistory` reports

| Check | Observed | Verdict |
|---|---|---|
| `getAllEntries()` for A → form → C | 3 entries, each with exactly the keys `url`, `title`, `pageState`: `/article?n=200&title=A` "A", `/form.html` "form", `/article?n=200&title=C` "C". | Confirmed |
| `pageState` present? Size? | A string (base64) on every entry. Decoded size after scrolling/typing: A 700 B, form 1852 B, C 652 B. A bare tab with no interaction: 716 / 1684 / 652 B, the same sizes immediately after load and 1.5 s later. | Confirmed |
| Size of the whole snapshot as JSON | 4590 B with `pageState`, 193 B with only `url` and `title`. | Info |
| Does size depend on content? | Yes. Typing 50 KB into the textarea took the form entry from 628 B to 101 732 B (about 2 B per character, UTF-16). | Info |
| Counters | `length() = 3`, `getActiveIndex() = 2`, `canGoBack() = true`, `canGoForward() = false`. After `goBack()`: index 1, back and forward both true. After a second `goBack()`: index 0, back false, forward true. `goForward()` → 1, `goToIndex(2)` → 2. `getEntryAtIndex(3)` and `getEntryAtIndex(-1)` return `null`. | Confirmed |

### Q2: restore with full entries (url, title, pageState)

All runs resolved. The view was attached (visible) before `restore()` unless noted. `restore()` resolved in 89–206 ms, median 130 ms (38 restores, local fixture, 200-paragraph article).

| Check | Observed | Verdict |
|---|---|---|
| (a) Stack | `full-settled`, `full-flushed` and `full-immediate`, both layouts: length 3, active index 2, `canGoBack` true, `canGoForward` false, titles A / form / C and URLs preserved, 3/3 each. `goBack()` loads `/form.html`, then A, and two `goForward()` return to C; every URL correct 3/3. | Confirmed |
| `pageState` round trip | For the non-active entries of a full restore, `getAllEntries()` returned `pageState` strings identical to the snapshot (3/3 entries equal). | Confirmed |
| (b) Scroll of the active entry, settled | `formMiddle`: C at 6416 px restored to 6416 (3/3, no polling needed). `formActive`: form page at 1500 px restored to 1500 (3/3). Same when the view is attached but hidden with `setVisible(false)`. | Confirmed |
| (b) Scroll of non-active entries | After `goBack()`: A (p60) restored 3/3 in `formMiddle`, C (p120) restored 3/3 in `formActive`. After `goBack()` ×2 and `goForward()` ×2, the active page's scroll is restored again 3/3 in the settled and flushed runs. | Confirmed |
| (b) Scroll when `restore()` runs on a view **not attached** to the window | scrollY is exactly the expected value × the display scale factor and never self-corrects after attaching. At 125 %: expected 6416, got 8020 (0/2); expected 1500, got 1875.2 (0/2). Forced scale 2: expected 1500, got 3000; expected 6440, got 9989 (probably clamped at the page's maximum scroll; 6440 × 2 would be 12 880). Forced scale 1: exact (2/2 each). Attached but invisible (`setVisible(false)`): exact 2/2. An exploratory probe (not in the committed results) found zero-size bounds, off-screen bounds and a 1×1 view also exact; detached was the only wrong case. | Refuted for the ADR order (restore, then attach) |
| (c) Form values on `form.html` | `#text`, `#area` (two lines), `#sel` (value `b`) and `#chk` restored 3/3 in every settled and flushed run, both from the active entry (`formActive`) and after `goBack()` to a non-active entry (`formMiddle`). `#reactish` came back as its initial `''`: 0/3 everywhere. | Partly confirmed |
| (d) `contenteditable` `#ce` | Reset to the fixture's original text, 0/3 everywhere. The text never appears in `pageState` (marker search, 5 + 3 trials). | Refuted |
| Why `#reactish` is lost | Chromium only stores a control's state when its value differs from its default value. The emulated React `input` handler updates the `value` attribute, so the default tracks the value and nothing is stored. Marker search confirmed `#reactish` is absent from `pageState` while `#text` and `#area` are present (8/8 trials). This is an inference from the matching observations, not a source reading. | Info |
| Snapshot taken right after the edit (`full-immediate`) | The active entry has no edit: its scroll is lost 0/3 and, for `formActive`, none of its form values come back (0/3 each). Non-active entries are intact: A's scroll and the form values on a non-active `form.html` are restored 3/3. | Confirmed (a real loss window) |
| Snapshot after a forced flush (`full-flushed`) | Identical to `full-settled`: every check that passes there passes here, 3/3, for both layouts, also when the source view was detached and hidden while edited. | Confirmed |

### Q3: restore with persisted-style entries (url, title only)

| Check | Observed | Verdict |
|---|---|---|
| (a) Stack | All stack checks 3/3 in both layouts: length 3, active index 2, `canGoBack`, no `canGoForward`, titles A / form / C, URLs, and correct URLs on `goBack()` ×2 and `goForward()` ×2. | Confirmed |
| (b) Scroll | Lost everywhere: the active page loads at 0 (expected 6416 / 1500), and A, C and the form page after `goBack()` are also at 0 (0/3 each). | Refuted (expected) |
| (c) Form values | All six fields reset to their initial values, 0/3, on the active entry and after `goBack()`. | Refuted (expected) |
| (d) `#ce` | Reset, 0/3. | Refuted (expected) |
| `pageState` afterwards | `getAllEntries()` after the restore returns a `pageState` string for every entry even though none was passed: 436 B, 412 B and 652 B for A, form and C. After the walk through the history (each page loaded and left) they hold 716 / 1684 / 716 B. | Info |

### Q4: pageState freshness

Polled every 100 ms for up to 10 s after the edit. Attached = in the window and `visibilityState = "visible"` on every trial. Detached = `removeChildView` before the edit, `visibilityState = "hidden"` on every trial.

| Check | Observed (ms from the edit until `getAllEntries()` shows it) | Verdict |
|---|---|---|
| Scroll, attached (n = 5) | 1083, 1095, 1087, 1088, 1082. Median 1087, range 1082–1095. | Confirmed |
| Form edit, attached (n = 5) | 1095, 1094, 1089, 1094, 1086. Median 1094, range 1086–1095. The text value appears in the same poll as the first change. | Confirmed |
| Scroll, detached (n = 3) | 5128, 5023, 5022. Median 5023, range 5022–5128. | Confirmed |
| Form edit, detached (n = 3) | 5115, 5025, 5110. Median 5110, range 5025–5115. | Confirmed |
| Which fields reach `pageState` (3 s after a full edit) | `#text` and `#area` yes, `#reactish` and `#ce` no, in all attached and detached trials. | Confirmed |
| Hiding the view after the edit (`removeChildView`, `setVisible(false)`) | No flush. The update still arrives after the usual delay: `removeChildView` form 1040 / 1039 / 1044, scroll 1043 / 1027 / 1041; `setVisible(false)` 1042 / 1028; control without any trigger 1029 / 1026. | Refuted as a flush |
| Blur of the focused element | No flush: 1016 / 1026. | Refuted |
| Navigating away | The previous entry is stale at `did-start-navigation` (6/6) and fresh at `did-navigate` (6/6: 3 form, 3 scroll), and still fresh when `loadURL` resolves. | Confirmed |
| `history.replaceState(history.state, '')` | Flushes within 4–11 ms for scroll and form, from the page's main world (4–6 ms) and from an isolated world (6–11 ms), and also when the view was detached and hidden while edited (isolated world, 4–8 ms; without the call a hidden view had nothing after 1.5 s). Side effects observed: one `did-navigate-in-page` event in the main process, the navigation `length()`, the URL and the page's `history.length` unchanged. | Confirmed |

### Q5: failures and invalid input

| Check | Observed | Verdict |
|---|---|---|
| Good entry | Resolves 119 ms after the call, at the same millisecond as `did-finish-load` (+0.1 ms). `did-navigate` reported 200. | Confirmed |
| Active entry at a closed port | **Rejects** with `ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:…/never-served'`. Event order: `did-fail-load` (errorCode -102, main frame), then `dom-ready`, `did-frame-finish-load` and `did-finish-load` for the error page, then the rejection (6–8 ms after `did-fail-load`). The first refused connection took 2178 ms; later ones in the same process 211 ms and 328 ms. | Confirmed |
| State after the failure | The history is intact (3 entries, active index 1, `canGoBack` and `canGoForward` true; 1 entry for a single-entry restore). `getURL()` is still the failed URL, the title is derived from it (`127.0.0.1:PORT/never-served`), the page is `chrome-error://chromewebdata/`, and `isLoading()` was still `true` when the promise settled. `goBack()` loaded A, and `goForward()` showed the error page again. | Confirmed |
| Retry on the same web contents | A second `restore()` **rejects** with `Cannot restore history on webContents that have previously loaded a page.` (also after a failure). `loadURL` on that web contents does work (it loaded C). | Info |
| Active entry is an HTTP 404 page | **Resolves** (133–140 ms). The only signal is `did-navigate` with `httpResponseCode: 404`. The stack is intact. | Refuted for "rejects on failure": HTTP errors are successes |
| Slow entry (`/slow?ms=1500`) | Resolves at 1552 ms, on `did-finish-load`, not on `did-navigate` (1538 ms) or `dom-ready` (1546 ms). | Confirmed |
| Index out of range (3, -1), empty `entries` | **Throws synchronously** `Invalid index. Index must be a positive integer and within the bounds of the entries length.` No promise is returned. The web contents is left at its initial blank entry. | Info |
| Entry without `url`, without `title`, or with `pageState: ''` | **Rejects** immediately (0 ms): `Failed to restore navigation history: Invalid navigation entry at index 0.` | Info |
| Unparsable URL (`not a url`) or empty URL | **Resolves** and the entry silently becomes `about:blank`. | Info |
| `pageState` absent, `undefined`, `null`, garbage base64 or non-base64 text; `title: ''` | All **resolve** and load the URL normally. Garbage is ignored. | Info |

### Q6: restore before vs after loadURL

| Check | Observed (3 runs each) | Verdict |
|---|---|---|
| `restore()` on a brand-new view | Resolves, length 3, active index 2, active scroll restored 3/3, A's scroll after `goBack()` ×2 restored 3/3, 4 of 6 form fields (the same four as above) restored after `goBack()`. 104–150 ms. | Confirmed |
| `restore()` after `await loadURL('about:blank')` | **Rejects** 3/3, at once, with `Cannot restore history on webContents that have previously loaded a page.` The tab is left on `about:blank` with 1 entry. | Refuted as "allowed" |
| `restore()` right after an un-awaited `loadURL('about:blank')` | **Rejects** 3/3 after 8–9 ms with `ERR_ABORTED (-3) loading 'about:blank'`, and the history is corrupt: 4 entries `[A, form, about:blank, about:blank]`, active index 3, entry C missing. | Refuted |
| `restore()` after loading a real page | **Rejects** 3/3 with the same message; the page stays, 1 entry. | Refuted |
| Second `restore()` on a view that already restored | **Rejects** with the same message; the restored history (length 3, index 2) is untouched. | Info |

## What this means for the design

Reference points: ADR-0003 decision 5 (discard procedure) and technical assessment §4.9 (procedures) and §4.10 (limits and recovery).

**Keep.**

- **Snapshot the entries and the active index; persist only `url` and `title`; keep `pageState` in memory.** The persisted-style restore rebuilt the whole stack with titles (Q3 stack checks 3/3), and `pageState` is large: ~0.65–1.9 KB per entry on these pages, ~2 B per typed character. §4.9 step 6 ("persist the snapshot, without page state") stands.
- **"Restore calls `restore()` before any `loadURL`" is a hard requirement, not just a recommendation.** After any load, even `about:blank`, `restore()` rejects. If the `about:blank` load is not awaited, the history is corrupt. TabManager must never load anything into a view it intends to restore into, and must create a new view for every restore attempt.
- **"A failing navigation leaves the tab LIVE on an error page"** (§4.9 restore step 4). Confirmed: the history stays intact and `goBack()` works.
- **"Page state trails the very latest edits. That doesn't matter for automatic discards"** (§4.9 step 4). Confirmed for tabs hidden for long: the commit arrives after about 1.1 s while visible and about 5.1 s while hidden. It matters for "Archive now", as the assessment says (see change 2).
- **The conclusion in §4.10 that `value` / `defaultValue` probing misses React-style inputs** is consistent with this spike: such values are not in `pageState` either.

**Change.**

1. **Attach the view before `restore()` (swap restore steps 2 and 3 in §4.9, and the last sentence of ADR-0003 decision 5).** Restoring into a detached view puts scroll in the wrong place by exactly the display scale factor and does not fix it later (125 %: 6416 → 8020). Attached works in the visible state and also with `setVisible(false)`, so background restores should be `addChildView` + `setVisible(false)` + `restore()`, then show on selection. The forced scale-factor runs back the cause: factor 1 is exact when detached, factor 2 doubles the scroll. Form values and the stack were unaffected by attachment.
2. **Flush `pageState` in the probe step instead of waiting.** In step 3 (probe) or just before step 4 (snapshot), run `history.replaceState(history.state, '')` in the isolated world. It updates `pageState` in 4–11 ms, including for hidden views, and the restored result is identical to waiting for the natural commit. Without it, a snapshot taken less than ~1.1 s (visible) or ~5.1 s (hidden) after an edit loses the active entry's scroll and form values. Handle its side effects: ignore the `did-navigate-in-page` event it triggers (it must not count as a navigation or as engagement), and wrap it in try/catch. If the flush fails, fall back to waiting. This is a recommendation to adopt after checking real sites (see caveats), not a measured production fact.
3. **Wrap `restore()` in handling for three failure shapes, not one.**
   - **Throws synchronously:** bad index or empty entries.
   - **Rejects:** load failures (`ERR_*`, after `did-fail-load`, history intact), invalid entries, or a used web contents.
   - **Resolves while wrong:** an unparsable or empty URL becomes an `about:blank` entry, and HTTP 404/500 pages resolve.
   - Validate persisted entries before calling: a parseable URL (and the scheme allow-list from ADR-0002), a string `title` (empty is fine), and **drop `pageState` instead of storing `''`**, which is rejected. A missing `pageState` (`undefined` or `null`) is fine.
   - Treat a rejection with a seen `did-fail-load` as "LIVE on an error page"; treat every other rejection and every throw as a creation failure: destroy the view, go back to UNLOADED, offer Retry with a new view.
   - Do not use `did-finish-load` or `isLoading()` as the success signal: error pages emit `did-finish-load`, and `isLoading()` was still true when the promise settled.
4. **Say less in the UI and in §4.10's recovery line.** "In-run page-state restoration brings plain form values and scroll position back" holds for text, textarea, select and checkbox. It does not hold for controlled inputs that sync their `value` attribute, and not for `contenteditable`. Since §4.10 specifies that the probe flags a focused or edited `contenteditable` as a hard protection, keep that protection rather than counting on recovery. Never describe restore as "your typing is back".
5. **Memory cap (suggestion, not measured at scale).** `pageState` grows with typed text (50 KB → 100 KB). When keeping snapshots in memory, consider dropping `pageState` above a per-tab limit and keeping `url` and `title`.

## Caveats and follow-ups

- **One machine, one display.** 125 % scaling is the only real display; the scale factor 1 and 2 results come from `--force-device-scale-factor`, not from a second monitor. Not tested: a window that moves between monitors with different scale factors, browser zoom levels (`setZoomFactor`), and restoring while the window is minimized.
- **Fixtures only.** No iframes, no SPA routers (`pushState` entries, monkey-patched `history.replaceState`), no POST entries, no real sites. The flush in Q4b is verified only on the fixtures. Untested inferences: `replaceState` may throw on opaque-origin documents, and some SPA frameworks wrap it.
- **Programmatic edits.** Values were set by script plus `input`/`change` events, as the brief asked. Trusted user input through `sendInputEvent` / `insertText` was not compared.
- **Why hidden pages commit at about 5 s** was not investigated; it looks like background timer throttling, which is an inference. In two exploratory runs (before `visibilityState` was recorded for the source tab) a visible-looking tab took about 5.0 s instead of about 1.05 s, probably because the window was occluded; no committed run shows it. Always-on-top was required to avoid it.
- **Three samples.** The 2178 ms for the first refused connection versus 211 and 328 ms later (Q5) is only three samples; the Windows connection-refused behavior was not explored.
- **Exploratory results.** The zero-size, off-screen and 1×1 attach variants in Q2 come from a scratch probe, not from the committed code or results.
- **Exploratory observation, not in the committed code:** `executeJavaScript` on a view that has never loaded did not resolve. Do not probe a view before its first navigation.
- **Follow-ups.**
  - Re-run Q2 and Q4b against real SPA pages (S7 fixtures) before adopting the `replaceState` flush.
  - Check what a `history.replaceState` flush does to sites that react to it.
  - Re-run the attach-order test on a 100 % display.
- **Shared code.** No change needed in `spikes/shared`. The `user-data/` folder that `prepareApp` creates inside `spikes/s2-restore` is already covered by `.gitignore`.

## How to reproduce

From Git Bash in `C:\GitHub\Veltriva\spikes`, with no other Electron window covering the spike window:

```bash
# every group, one Electron process each (about 6 minutes in total; this produced the committed results)
bash s2-restore/run-all.sh

# or one group at a time (each finishes in under 170 s)
timeout 180 ./node_modules/.bin/electron s2-restore/main.js --only=q1     # entries, sizes, counters
timeout 180 ./node_modules/.bin/electron s2-restore/main.js --only=q2     # full entries (--reps=N, default 3)
timeout 180 ./node_modules/.bin/electron s2-restore/main.js --only=q3,q2b # persisted entries; attach order
timeout 180 ./node_modules/.bin/electron s2-restore/main.js --only=q4     # pageState freshness
timeout 180 ./node_modules/.bin/electron s2-restore/main.js --only=q4b    # flush triggers
timeout 180 ./node_modules/.bin/electron s2-restore/main.js --only=q5     # failures and invalid input
timeout 180 ./node_modules/.bin/electron s2-restore/main.js --only=q6     # restore vs loadURL order

# forced scale factors for the detached-restore scroll error
timeout 180 ./node_modules/.bin/electron --force-device-scale-factor=2 s2-restore/main.js --only=q2b --tag=dsf2
```

Results are written to `spikes/s2-restore/results/s2-restore-<groups>[-<tag>].json`. Each run exits by itself (`app.exit`) and has a fail-safe timer.

Layout of the code: `lib.js` (sessions lock-down, page-state helpers, discard/restore helpers), `scenario.js` (build, snapshot, restore and verify a 3-entry tab), `q1-entries.js`, `q2q3-fidelity.js` (also the attach-order variants), `q4-freshness.js`, `q5-failure.js`, `q6-ordering.js`, `main.js` (group selection) and `run-all.sh`.
