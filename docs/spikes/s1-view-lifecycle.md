# S1: View lifecycle

| | |
|---|---|
| **Question** | On Windows, do hidden `WebContentsView`s report `hidden` and get throttled? Does `removeChildView` + `webContents.close()` release renderers? Do media events behave as documented? |
| **Status** | Done |
| **Result** | **Confirmed.** Detaching hides and throttles a page, and re-attaching restores it. Only `close()` releases a renderer deterministically. One important addition: an *opaque* view or window covering a page also makes it `hidden` (occlusion) |
| **Environment** | Windows 11 10.0.26200, Electron 44.7.2 (Chromium 152), Node 24.13, one display at 125% |
| **Code** | [spikes/s1-view-lifecycle](../../spikes/s1-view-lifecycle) |

## What we tested

- **Setup.** A 900×600 `BaseWindow` kept **always on top**. The first run showed why that's needed: a spike window that opened behind another app was fully covered, and Chromium's native occlusion tracking reported its pages `hidden` even while attached.
- **Visibility and throttling.** The fixture `timers.html` counts a 100 ms interval and animation frames, and logs `visibilitychange`. It was measured while attached, detached, re-attached, `setVisible(false)`, covered by an opaque view in the same window, covered by another window, and with the window minimized.
- **Renderer release.** Eight cross-site tabs (`/page?heapMB=20`, sites `t0.test`–`t7.test`), measured with `app.getAppMetrics()`. Four were detached only, then detached and closed. The other four had their references dropped without `close()`, followed by forced garbage collection.
- **Media.** `audio.html` muted (`setAudioMuted(true)`), played and paused with `executeJavaScript(…, true)`.
- **Back/forward cache.** A JS marker set before navigating away, checked after Back.

## Results

| Check | Observed | Verdict |
|---|---|---|
| Attached view, window shown and un-occluded | `visible`, interval 10/s, 64 frames/s | Confirmed |
| `removeChildView` | `hidden`, interval throttled to 1/s, 0 frames/s | Confirmed |
| Detached + `setBackgroundThrottling(false)` | interval back to 10/s, still 0 frames/s | Info |
| Re-added with `addChildView` | `visible` again, 10/s and 64 frames/s (Linux's 44.x regression doesn't reproduce on Windows) | Confirmed |
| `setVisible(false)` on an attached view | `hidden` | Info: equivalent to detaching for visibility |
| **Covered by an opaque view in the same window** | `hidden`, 1/s, 0 frames/s | **New:** occlusion is computed per view (see [S4](s4-overlay-strategy.md)) |
| **Whole window covered by another window** | `hidden`, 1/s, 0 frames/s; `visible` again once uncovered | **New:** native window occlusion, as in Chrome |
| Window minimized | `hidden` | Confirmed |
| 8 live tabs, each with a 20 MB JS heap | 8 renderers, 442 MB renderer private memory, 547 MB in total (about 55 MB per tab) | Info |
| Detach only (4 tabs) | Nothing released: still 8 renderers, 547 MB | Confirmed |
| Detach + `close()` (4 tabs) | 4 renderers gone, **219 MB freed** | Confirmed |
| References dropped without `close()`, then 2 forced GCs over 5 s | 3 of 4 renderers released, **1 still alive** | Release by GC is non-deterministic |
| Media while muted | `media-started-playing`, `audio-state-changed: true`, `media-paused`, `audio-state-changed: false`; `isCurrentlyAudible()` is **true while muted** | Confirmed, with a nuance |
| Back/forward cache | Not used: the page reloaded on Back | Info (consistent with Electron's source) |

A first run without always-on-top was invalid, and its results weren't kept: every "attached" check read `hidden`, because another window covered the spike window. That run is what exposed native occlusion as a factor.

## What this means for the design

- **Keep detaching as the way to hide a live tab** (ADR-0002). It gives the expected visibility and throttling, and re-attaching restores both on Windows.
- **Keep the explicit-destruction rule** (ADR-0002). `close()` is the only predictable release. Dropping references leaves renderers alive until GC happens to run.
- **Discards free real memory:** about 55 MB per tab for these fixtures, confirmed at larger scale by [S8](s8-measurement-method.md).
- **Occlusion is a feature for us, and a trap for overlays.** Pages in covered windows get throttled for free. But an opaque view raised above a tab makes it `hidden`, which ruled out snapshot takeover (ADR-0006).
- **Muted but playing tabs report audible.** The audio protection in §4.10 therefore covers muted video too. Treating muted-but-playing as a *soft* protection is a Phase 3 tuning question.
- **Tests:** visibility assertions need an un-occluded window. CI keeps the test window always on top (ADR-0008, 4a).

## Caveats and follow-ups

- One machine and one display. Intensive wake-up throttling (after 5 minutes hidden) wasn't measured; Chromium documents it.
- Input-event behavior is covered by [S3](s3-unsaved-work-detection.md), not here.
- **Open follow-up, owned by Phase 3:** whether *real OS input* typed inside a cross-site iframe reaches the main-process input observers. S3 could only use `sendInputEvent`, which never reaches a cross-process child, and CDP-routed input. The design no longer depends on the answer, because `hasBeenActive` and the iframe's own `beforeunload` cover iframe edits. It still needs a manual check, or OS-level input automation, before the protection table claims more.

## How to reproduce

```bash
cd spikes
./node_modules/.bin/electron s1-view-lifecycle/main.js
```

Results go to `spikes/s1-view-lifecycle/results/s1-view-lifecycle.json`. The run takes about 90 s and briefly opens a second window to test occlusion.
