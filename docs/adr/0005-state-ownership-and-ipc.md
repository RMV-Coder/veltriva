# ADR-0005: Main-process-authoritative state and a typed IPC contract

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | The approved architecture (state ownership) |
| **Details** | Technical assessment §3.4, §3.5, §6.3 |

## Context

The tab lifecycle mixes asynchronous Chromium events, user commands, a scheduler and persistence. Splitting authority between processes invites state drift and races. The shell renderer is privileged, so everything it can call must be narrow and validated.

## Decision

1. **Single writer.** The main process is the only writer of domain state: TabManager and the services around it. The UI sends **intents** such as `tabs.archive({ tabId })`, never state patches.
2. **Snapshots.**
   - Main pushes **versioned, coalesced snapshots** of the workspace view model, at most one per animation frame.
   - High-frequency details, such as load progress, travel as separate events.
   - Archive lists and search results are paged queries, not part of the snapshot.
3. **The contract** lives in `src/shared/contracts`. Every command is a pair of `{ input, output }` Zod schemas, and every event has a name and a payload schema. Both sides derive their TypeScript types from it.
4. **The preload** builds a frozen API object from the contract and exposes it with `contextBridge`. It never exposes `ipcRenderer`, the IPC event object, or a generic `send`.
5. **The IpcRouter** handles each call in four steps:
   1. **Verify the sender.** The call must come from the main frame of the shell's web contents, with origin `app://shell` (or the dev-server origin, in development builds only).
   2. **Parse with a strict schema**, so unknown keys are rejected.
   3. **Run the handler.**
   4. **Return** `{ ok: true, value }` or `{ ok: false, code }`. Stack traces never cross processes.
6. **UI state.** Zustand stores hold the projection of main-process state, plus purely local UI state.
7. **As built in M1.2:**
   - **Transport.** Commands use one channel, `veltriva:invoke`, with arguments `(command, input)`. Events use `veltriva:event`, with arguments `(name, payload)`, and are sent to the shell's web contents only.
   - **The contract is split in two.** `src/shared/contracts/ipc.ts` holds the names, channels, error codes and the `Result` type, with no Zod. `src/shared/contracts/schemas.ts` holds the Zod schemas; the type checker requires every name to have a schema and every schema a name. The preload and the renderer import only types from the schema file, so Zod never ships in the shell, where its JIT would also trip the CSP.
   - **The preload API** is `window.veltriva.<namespace>.<method>(input?)` for each command, plus `on(event, listener)`, which returns an unsubscribe function and throws for names outside the contract. A command whose schema has no keys can be called without an argument.
   - **Order of checks.** The sender is checked first: role `shell` (from the web-contents guard), main frame, and an allowed origin. Then the command name, then strict input parsing, then the handler. The output is validated before it's returned.
   - **Error codes** are `forbidden`, `unknown_command`, `invalid_input` and `internal`. An untrusted sender gets `forbidden` even for a name that doesn't exist, so it learns nothing about the contract. Handler errors are logged by name only; their messages never cross processes.
8. **As built in M1.3a:**
   - **Commands.**
     - `workspace.getSnapshot`.
     - `tabs.create`, `tabs.close`, `tabs.select`, `tabs.move`, `tabs.setPinned` and `tabs.duplicate`.
     - `navigation.submit`, `navigation.back`, `navigation.forward`, `navigation.reload` and `navigation.stop`.
     - `layout.setInsets`.
   - **The event** `workspace.changed` carries the whole workspace snapshot.
   - **A new error code, `not_found`:** the input was valid but named a tab that doesn't exist, such as one closed a moment ago.
   - **Snapshots** are versioned and coalesced to one per 16 ms by the WorkspaceProjector. The shell subscribes first, then asks for the current snapshot, and applies only versions newer than the one it has.
   - **Main builds everything the shell shows**, and the schema bounds each piece:
     - the address text, from the parsed URL (punycode host, no credentials);
     - a security state;
     - a sanitized title: no controls or bidi overrides, at most 1,024 characters;
     - a validated favicon `data:` URL.
   - **`navigation.submit` carries the typed text, not a URL.** Main classifies it (`src/core/url/omnibox.ts`); the shell never decides what a string means.
   - **`layout.setInsets`** reports how far the shell's chrome reaches into the window. Main places the selected tab's view in the rest (LayoutManager).
9. **As built in M1.3b:**
   - **New commands.**
     - `find.update`, `find.next`, `find.close`: the find bar, whose state per tab is main's.
     - `tabs.zoom`: one preset step, or a reset.
     - `fullscreen.noticeShown`: the shell draws only the fullscreen notice, so main may raise it above the page.
     - `fullscreen.dismissNotice`: a click on the notice.
   - **Focus.** `tabs.select` and `tabs.close` take an optional `keepFocus`. Without it, the newly selected page gets keyboard focus, as after a click; with it, focus stays in the sidebar, for keyboard users.
   - **Events** `ui.focusAddressBar` and `ui.focusFind`: main has already given the shell's view keyboard focus (Ctrl+L, Alt+D, F6, Ctrl+T, Ctrl+F), and the shell focuses that field.
   - **Snapshot fields.** `zoomPercent` and `find` per tab. `fullscreen` (tab, origin label, notice) on the workspace.
   - **Shortcuts never travel over IPC.** Main matches them from `before-input-event` and from the hidden menu's accelerators, so the shell has no shortcut handlers of its own (assessment §3.9).

10. **As built in M2.1a and M2.1b (Phase 2):**
   - **Main and the data worker have a contract of their own.** It lives in `src/shared/contracts/data-rpc.ts`, built on the same rules: strict Zod both ways, bounded lists, error codes only (ADR-0004 item 7). The shell never reaches the worker; main is still the only writer.
   - **Notices about Veltriva itself.** The snapshot has a workspace-level `notices` list of at most 3, which M2.1b uses for database recovery (`database-restored`, `database-reset`). The new command `notices.dismiss({ noticeId })` answers `not_found` for an id that isn't shown.
   - **The kept file's name is untrusted text.** Main keeps only its last path segment and replaces controls, bidi overrides and Windows-forbidden characters. The shell cleans it again and isolates it in `<bdi dir="ltr">`, as it does for sites in the prompt strip.

11. **As built in M3.3 (Sleeping, the Archive and Undo):**
   - **Snapshot fields.**
     - On the workspace: `sleeping` (tab snapshots, most recently moved first), `archived` (the newest 200: id, title, address, favicon, `archivedAt`, `reason` auto or manual), `counts` (`sleeping`, `archived` in all, `archivedToday`) and `undo` (the batch the sidebar offers to undo, whether automation made it, and how many tabs went where; null when there is none).
     - Per tab: `userProtected`, and `unloadedBy` (automation, memory pressure or the user, while the tab stays unloaded after a discard) for the status tooltips.
   - **New commands.**
     - `tabs.shelve`, `tabs.archive`: answer `{ moved }`. An archive waits for the page to be unloaded, and a page that objects keeps its tab (`moved: false`).
     - `tabs.restore`: from Sleeping or the Archive to the strip, next to the current tab, selected. It answers the tab's id, which for an archived tab may be new.
     - `tabs.setProtected`.
     - `lifecycle.undo` (`{ undone }`; 0 once the batch is no longer offered), `lifecycle.dismissUndo`, `lifecycle.activity` (the activity log, newest first).
   - **Batch ids** are main's own handles, `batch-N` for an evaluation and `manual-N` for the user's move, so a late click can't undo another batch.
   - **"Leave page?"** is a fourth prompt kind, `leave-page`, answered with `prompts.respond` like the others (allow = Leave). Its sentence names main's label of the site; the page's own text is never shown, as in Chromium.

12. **As built in M3.4 (protection, preview, Pause, diagnostics):**
   - **Snapshot fields.** Per tab: `keptAwake` (the protection reasons observed now, in the order the sidebar names them), `unloadPressure`, `previewMove`, `movedBy`. On the workspace: `automation` (paused, preview with its last day and today's active day, the memory pressure).
   - **New commands.** `lifecycle.setPaused`, `lifecycle.endPreview`, `tabs.setSiteProtected` (answers the site; `not_found` for a page without one) and `lifecycle.diagnostics` (the regret metric and what automation sees, for the `diagnostics` internal page, `veltriva://diagnostics`).
   - **Main writes the settings document** for these switches; the shell never sends settings, only the intent.
13. **As built in M4.2 (the palette, the address bar's memory, the Archive list):**
   - **New commands:**
     - **`memory.search`:** the words as typed, a scope (All, Open, Sleeping, Archived, Today, This week), an optional site and a limit of at most 50.
       - **Main does the interpreting.** It reads a `site:` word out of the words, turns the scope into the data worker's filters (Today from local midnight), and checks every tab the database names against TabManager before answering. The database lags TabManager by up to a second, and a private tab is never offered.
     - **`memory.open`:** a result opened by `switch`, `newTab` or `current`.
       - **The shell sends ids, never an address to load.** It names the page and the tab, and main reads the page's address from the memory.
       - **`switch` restores what it must.** It brings a tab back from Sleeping or the Archive, even one only the database still holds.
     - **`overlay.show` / `overlay.hide`:** the A′ handshake (ADR-0006).
     - **`archive.list`:** a window of every archived tab, from the database.
   - **New event:** `ui.openPalette`, after main gave the shell the keyboard for Ctrl+Shift+K.
   - **`tabs.restore` reaches every archived tab,** not only the newest 200 that memory keeps.
   - **What the results carry:**
     - the address as the display rules show it;
     - title marks as ranges, which the shell renders as text;
     - the five score terms, for the palette's debug view.
14. **As built in M5.1 (settings):**
   - **New commands:**
     - **`settings.get`:** the view. It holds the document as main keeps it, and what the page needs to describe and check it: the presets' values, each number's range, the pressure defaults and the named search engines.
     - **`settings.update`:** a change.
     - **`settings.setSiteRule`:** what the user typed (a site, a host or an address) and one rule or both. Main reads the site from it.
     - **`settings.open`:** selects the Settings tab, or opens one.
   - **The shell never writes the document.** It sends a change and shows the view main answers with.
   - **`invalid_input` has a second meaning.** Besides input that fails its schema, it now answers a change that is valid alone but would make an invalid document, such as critical pressure at or above moderate. `CommandError` can carry it. Nothing of a rejected change is kept.
   - **Two internal pages:** `settings` and `welcome`, the first-run onboarding. Both can be typed (`veltriva://settings`, `veltriva://welcome`).
15. **As built in M5.2 (clearing data and stored answers):**
   - **New commands:**
     - **`privacy.clear`:** a range (hour, day, week, all) and what to clear: the memory, archived and closed tabs, cookies and site data, the cache. `invalid_input` when nothing is chosen.
     - **`privacy.forgetSite`:** what the user typed, read as a site by main (`invalid_input` when it names none), plus whether to clear its data and its permissions.
     - **`memory.remove`:** one entry, from the palette's Shift+Delete: a page id, and the archived tab showing it when that is the entry. Main passes the tab on, and the worker removes only an archived or closed tab.
     - **`permissions.list` / `permissions.change`:** the stored answers, and one change or revocation (`not_found` when there was nothing to revoke).
   - **Every one answers with what it did:** counts for a clear, the list for a permission change. The shell shows that, never its own idea of the result.
16. **As built in M5.3 (diagnostics):**
   - **`lifecycle.diagnostics` is now async, and gains:**
     - each tab's renderer memory, from `app.getAppMetrics` (private bytes on Windows, spike S8), with how many other tabs share the renderer;
     - Veltriva's other processes;
     - automation's counts from the activity log;
     - the pressure history of this run;
     - the database's size, last backup and check;
     - the log file and whether diagnostic logging is on.
   - **New commands:**
     - **`diagnostics.export`:** `{ includeAddresses }` gives `{ saved }`, false when the user cancelled the save dialog.
     - **`diagnostics.openLogFolder`.**
   - **The settings document gains `diagnostics.logging`** (off by default).

## Consequences

- **Positive:** one source of truth. Races are handled in one place (the per-tab queues in ADR-0003).
- **Positive:** the IPC surface is enumerable and testable. Every handler gets malformed-payload tests.
- **Negative:** snapshots send more bytes than patches. That's acceptable at hundreds of tabs, and gets revisited only if profiling says so.

## Alternatives considered

- **A renderer-side authoritative store, with main as executor.** Rejected: it would put privileged decisions in a renderer and invite drift.
- **Fine-grained patches.** Deferred until profiling shows a need.
