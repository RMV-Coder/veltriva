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

5. **As built in M5.1.**
   - **D5's first-run choice is the welcome page.** It shows on a new profile (no earlier run and no saved tabs); test builds show it only when a test sets `VELTRIVA_TEST_FIRST_RUN`.
   - **What it asks:** the search engine (DuckDuckGo chosen), the preset (Balanced) and whether automation shows its moves first (preview mode, §4.13). "Start browsing" sends the choices in one change and opens the new-tab page.
   - **Settings offers the rest:** DuckDuckGo, Google, Bing, Brave Search, Ecosia and Startpage, or another engine's address with `{searchTerms}`, which main checks (https, or http to this machine).

6. **The sidebar's semantics, as built (M6.2).** Assessment §7.3 named the ARIA `tree` pattern for the sidebar. It is built from patterns that say more precisely what each part does, and stays that way:
   - **The open tabs are a vertical `tablist`.** Each row is a `tab` that is `selected` when its page shows, and `controls` the content area. That is what a row does: choosing it shows its page, and only one shows at a time. A screen reader announces a tab, its position and whether it is selected, as for the tab strips of Chrome and Edge, whose vertical tabs are a tab list too.
     - **The keys:** Up, Down, Home and End move focus without switching; Enter or Space switches; Delete closes; Alt+Shift+Up/Down moves the tab; Shift+F10 opens its menu.
   - **Sleeping and Archive are disclosure sections.** A heading button says `expanded` or `collapsed` and the count, over a list of rows that restore their tab. A row there doesn't show a page in place, so it isn't a `tab`.
   - **Why not a tree:** a tree would announce every tab as an item "at level 2" of a section, lose "selected" for the page that shows, and present restoring a row as expanding a node. Nothing in the sidebar nests deeper than one level.
   - **Reaching it:** F6 cycles the address bar, the sidebar's selected tab, and the page (M6.2).

## Consequences

- **Positive:** a focused MVP whose central idea (Tabs, Sleeping, Archive) is visible on screen.
- **Positive:** a privacy-first default search engine.
- **Negative:** a single window limits multi-monitor users.
- **Negative:** a vertical sidebar is less familiar to people coming from Chrome.

## Alternatives considered

- **A horizontal tab strip plus a separate memory panel.** Familiar, but it hides the Tabs, Sleeping and Archive model.
- **Google as the preselected engine.** Better results for many people, but at odds with the privacy-first positioning. Users can still pick it at first run.
