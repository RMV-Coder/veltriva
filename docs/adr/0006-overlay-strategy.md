# ADR-0006: Overlays above web content: raise the transparent shell

| | |
|---|---|
| **Status** | **Accepted** (2026-10-16, after spike S4) |
| **Date** | 2026-10-16 |
| **Validated by** | [Spike S4](../spikes/s4-overlay-strategy.md) and [S1](../spikes/s1-view-lifecycle.md) |
| **Details** | Technical assessment §3.3 |

## Context

Web pages are native views painted *above* the shell, so HTML can't cover them. Two features have to: the omnibox suggestion list and the Ctrl+Shift+K memory palette. Menus use native `Menu.popup()`, and permission prompts sit inside the toolbar.

## Options evaluated

| Option | How it works | Result in S4 (10 runs) |
|---|---|---|
| A. Snapshot takeover | `capturePage()` the tab, paint the snapshot and palette in the shell, raise the shell above the tab | Overlay on screen in 24 ms, but **the page goes `hidden`**: an opaque view above it counts as occlusion, so its timers are throttled and it stops painting. Every omnibox use would pause or degrade visibility-sensitive pages, video calls included |
| **A′. Raise the transparent shell** (found during S4) | The shell view's background is `#00000000`. While an overlay is open, a CSS class clears the shell's content-area background and the shell is re-added on top | **Overlay on screen in 12 ms. The page stays `visible` and live** (10 timer ticks and 64 frames per second). No extra renderer. Keyboard focus stays in the shell's own input |
| B. Separate overlay view | A second trusted, transparent `WebContentsView` above the tab | The page stays live, but it costs an extra renderer (about 23 MB), cross-view focus and state sync, and 33 ms warm or 149 ms cold to show |
| C. Child popup window | What Chrome does for its omnibox popup | Not pursued: A′ meets every need without window tracking or DPI edge cases |

## Decision

**Option A′.**

- **The shell view is created with a transparent view background.** Its normal state is opaque through CSS. While the omnibox dropdown or the palette is open:
  1. the shell adds an `overlay-live` class, which clears the content-area background and shows the scrim and the panel;
  2. main re-adds the shell view so it sits above the active tab;
  3. focus goes to the shell.
- **Closing reverses it:** remove the class, then re-add the tab view on top.
- **The scrim, palette and dropdown are ordinary React components** in the shell's single tree, with no second renderer and no cross-view state.

## Consequences

- **Positive:** the fastest option measured (12 ms), with no extra process, and the page underneath keeps running. Video, calls and timers aren't disturbed by opening the palette.
- **Negative:** while the shell is raised, it receives all mouse input over the content area. That's correct for the modal palette. For the omnibox dropdown, a click on the page area closes the dropdown and the click is consumed rather than passed to the page; we accept that.
- **Risk:** A′ relies on Chromium treating a view with a transparent background as non-occluding. A lifecycle behavior test (ADR-0008, 4a) asserts that the page stays `visible` while the palette is open. If an Electron upgrade breaks this, option B is the drop-in fallback.
