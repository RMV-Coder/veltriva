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

## Consequences

- **Positive:** one source of truth. Races are handled in one place (the per-tab queues in ADR-0003).
- **Positive:** the IPC surface is enumerable and testable. Every handler gets malformed-payload tests.
- **Negative:** snapshots send more bytes than patches. That's acceptable at hundreds of tabs, and gets revisited only if profiling says so.

## Alternatives considered

- **A renderer-side authoritative store, with main as executor.** Rejected: it would put privileged decisions in a renderer and invite drift.
- **Fine-grained patches.** Deferred until profiling shows a need.
