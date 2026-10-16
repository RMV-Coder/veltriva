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
- **As built in M1.3a:** nothing overlays web content yet. The omnibox shows no suggestion list, and the sidebar uses inline buttons and native `title` tooltips, so nothing in the shell reaches into the content area. A′ lands with the first overlay that needs it.
- **As built in M1.3b:** the first overlay is the HTML-fullscreen notice (threat T6).
  - While `fullscreen.notice` is set, the shell renders only the notice, on a transparent page.
  - It then sends `fullscreen.noticeShown`, and only then does main re-add the shell view above the tab, so the shell's chrome never flashes over the page. A 500 ms fallback raises it anyway, so the notice is never skipped.
  - After 4 s, or on a click, main re-adds the tab view on top and gives the page its keyboard focus back. Keyboard focus never leaves the page while the shell is raised.
  - The find bar sits in the toolbar row, and context menus are native, so neither needs A′.
  - **Measured constraint:** A′ works only while the shell's document root (html and body) is transparent. Chromium takes a view's opacity from its document's root background color. A shell raised in its normal, opaque state counts as occlusion and hides the page, whatever its view background is. The lifecycle check found this.
    - The notice mode clears html, body and `#root`, and the handshake raises the shell only after that has painted.
    - The lifecycle check (ADR-0008, 4a) now takes this real path and requires the page under the notice to stay `visible` and unthrottled.

## Consequences

- **Positive:** the fastest option measured (12 ms), with no extra process, and the page underneath keeps running. Video, calls and timers aren't disturbed by opening the palette.
- **Negative:** while the shell is raised, it receives all mouse input over the content area. That's correct for the modal palette. For the omnibox dropdown, a click on the page area closes the dropdown and the click is consumed rather than passed to the page; we accept that.
- **Risk:** A′ relies on Chromium treating a view with a transparent background as non-occluding. A lifecycle behavior test (ADR-0008, 4a) asserts that the page stays `visible` while the palette is open. If an Electron upgrade breaks this, option B is the drop-in fallback.
