# S4: Overlay strategy

| | |
|---|---|
| **Question** | How should the omnibox suggestions and the Ctrl+Shift+K palette draw above a web page (ADR-0006)? |
| **Status** | Done |
| **Result** | **Option A′, newly found, wins.** Raise the shell view itself, with a transparent view background, above the tab. The page stays visible and live, there's no extra renderer, and the overlay shows in about 9 ms |
| **Environment** | Windows 11 10.0.26200, Electron 44.7.2 (Chromium 152), Node 24.13 |
| **Code** | [spikes/s4-overlay](../../spikes/s4-overlay) |

## What we tested

The setup: a 900×600 `BaseWindow` holding a shell `WebContentsView` (fake toolbar plus palette) and a tab view showing `timers.html`. The fixture counts a 100 ms interval and animation frames, and logs visibility. The window was kept always on top so Windows' native occlusion tracking couldn't skew results (see [S1](s1-view-lifecycle.md)).

| Option | Mechanism |
|---|---|
| **A**: snapshot takeover | `capturePage()` → JPEG → shell paints snapshot + palette → shell re-added on top |
| **A′**: transparent shell raise | Shell view background `#00000000`; CSS makes the content area transparent while the overlay is open → shell re-added on top. No snapshot |
| **B**: overlay view | A second trusted `WebContentsView` with a transparent background, above the tab |

For each option we measured what the page underneath experiences, time-to-overlay, keyboard focus, extra memory, and whether a capture of the whole window shows the page through the transparent region. That last check uses a solid red page and counts pixel colors.

## Results

Final run: 10 repetitions, window always on top, no other spike running. A functional pass with 3 repetitions earlier gave the same picture. Latencies are median (minimum–maximum).

| Check | A: snapshot takeover | **A′: transparent shell raised** | B: overlay view |
|---|---|---|---|
| Page under the overlay: `visibilityState` | **`hidden`** | `visible` | `visible` |
| Page under the overlay: timers / animation frames per second | 1.2 / 0 (throttled, not painting) | 10 / 64 (live) | 10 / 64 (live) |
| Time until the overlay is on screen | 24.1 ms (21–64) | **12.3 ms (6.6–20.8)** | 32.9 ms warm (20–37); 149 ms cold create |
| Breakdown | capture 4.6 ms + JPEG encode 4.0 ms (19 KB) + shell decode and paint 15.4 ms | show + raise | `setVisible(true)` → painted |
| Extra renderer process | none | **none** | +1 (about 23 MB private) |
| Keyboard focus in the overlay | shell focused | shell focused, palette input active | overlay focused, input active, tab not focused |
| Window capture through the transparent region | n/a | 71% red page visible, 20.5% white (palette and toolbar) | 69% red page visible, 14.5% blue palette |
| Page after the overlay closes | `visible`, 10 / 64 | — | — |

Two observations shaped the decision:

- **Raising an opaque view above a tab makes Chromium treat the page as occluded.** The page goes `hidden`, its timers are throttled and it stops painting. [S1](s1-view-lifecycle.md) saw the same in its "covered by another view" check. That was the core assumption behind option A, and it's refuted.
- **A view with a transparent background doesn't occlude.** This is true whether it's a separate overlay view (B) or the shell itself (A′). The page keeps running at full rate underneath.

## What this means for the design

- **Adopt option A′** (ADR-0006 is now *Accepted*). While an overlay is open, the shell view is raised above the active tab, with a transparent view background and a CSS class that clears the content-area background. The scrim, palette and dropdown are ordinary React components in the shell's single tree.
- **Option A is rejected.** An *opaque* view stacked above a tab makes Chromium treat the page as occluded: `visibilityState` becomes `hidden`, timers are throttled, and animation frames stop. Opening the omnibox would pause or degrade visibility-sensitive pages, video calls among them, on every use.
- **Option B is the fallback.** It keeps the page live, but costs an extra renderer process (about 23 MB private) and cross-view focus and state sync, for no benefit over A′.
- **Input routing while raised:** the shell receives all mouse input over the content area. That's correct for the modal palette. For the omnibox dropdown, a click on the page area closes the dropdown, and the click is consumed rather than passed to the page; we accept that.
- **Assessment §3.3** has been updated to match.

## Caveats and follow-ups

- Measured on one machine with the window always on top. Latency medians come from 10 runs, except the cold-create time, which is a single measurement.
- A′ depends on Chromium treating a view with a transparent background as non-occluding. If an Electron upgrade changes that, the overlay check in the E2E suite (page `visibilityState` stays `visible` while the palette is open) catches it, and B is the drop-in fallback.
- Real keyboard routing (OS keystrokes rather than injected events) was verified only through `webContents.isFocused()` and `document.hasFocus()`. Phase 1's E2E tests cover typing into the palette.

## How to reproduce

```bash
cd spikes
./node_modules/.bin/electron s4-overlay/main.js
```

Set `S4_RUNS` to change the repetition count. Results go to `spikes/s4-overlay/results/`.
