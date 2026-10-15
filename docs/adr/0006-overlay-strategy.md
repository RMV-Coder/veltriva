# ADR-0006: Overlays above web content

| | |
|---|---|
| **Status** | **Proposed**; decided by spike S4 |
| **Date** | 2026-10-16 |
| **Details** | Technical assessment §3.3 |

## Context

Web pages are native views painted *above* the shell, so HTML can't cover them. Two features have to: the omnibox suggestion list and the Ctrl+Shift+K memory palette. Menus use native `Menu.popup()`, and permission prompts sit inside the toolbar.

## Options

| Option | How it works | Trade-offs |
|---|---|---|
| **A. Snapshot takeover** | `capturePage()` the tab, raise the shell view above it (re-adding a child view moves it to the top), and paint the snapshot plus the overlay in React | One renderer and no transparency dependency. But the page appears frozen while the overlay is open, and capture adds latency |
| **B. Overlay view** | A second trusted, transparent `WebContentsView` sized to the overlay | The page stays live underneath. But it costs an extra renderer, needs cross-view focus and state sync, and there are reports of transparency quirks |
| **C. Child popup window** | What Chrome does for its omnibox popup | Can extend outside the window. But it has window-tracking and DPI edge cases |

## Proposed decision

Start with **A**, keeping **B** as the fallback. Spike S4 measures:

- capture latency;
- flicker;
- focus handling;
- whether the page observes a visibility change when the shell is raised above it.

This ADR becomes *Accepted*, or is revised, when the S4 report lands.
