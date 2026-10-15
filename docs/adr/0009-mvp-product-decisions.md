# ADR-0009: MVP product decisions: roadmap order, layout, search engine, single window

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | D3, D4, D5 and D8 |
| **Details** | Technical assessment §3.6, §7.3, §8.1 |

## Decision

1. **Roadmap order (D3).** Persistence and session restore (Phase 2) come before lifecycle automation (Phase 3), for three reasons:
   - archiving needs durable storage;
   - the restore snapshot is a persisted format;
   - session restore makes daily dogfooding possible from Phase 2, and dogfooding is how the lifecycle defaults get tuned.
2. **Layout (D4).**
   - A vertical sidebar with three sections: **Tabs** (pinned first), **Sleeping** and **Archive**. It collapses to icons.
   - The toolbar sits on top.
   - The MVP uses the native window frame. A custom title bar waits until Electron's fix for drag regions under stacked views ships in a release.
3. **Search engine (D5).**
   - Chosen at first run, with DuckDuckGo preselected. Other presets plus a custom template are available in settings.
   - Address-bar suggestions are local only, so no keystrokes leave the machine.
4. **Single window (D8).**
   - Multi-window and private windows come after the MVP.
   - Invariant I6 (ephemeral tabs never reach persistence) is enforced from day one, so private windows can slot in later.

## Consequences

- **Positive:** a focused MVP whose central idea (Tabs, Sleeping, Archive) is visible on screen.
- **Positive:** a privacy-first default search engine.
- **Negative:** a single window limits multi-monitor users.
- **Negative:** a vertical sidebar is less familiar to people coming from Chrome.

## Alternatives considered

- **A horizontal tab strip plus a separate memory panel.** Familiar, but it hides the Tabs, Sleeping and Archive model.
- **Google as the preselected engine.** Better results for many people, but at odds with the privacy-first positioning. Users can still pick it at first run.
