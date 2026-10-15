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

## Consequences

- **Positive:** one source of truth. Races are handled in one place (the per-tab queues in ADR-0003).
- **Positive:** the IPC surface is enumerable and testable. Every handler gets malformed-payload tests.
- **Negative:** snapshots send more bytes than patches. That's acceptable at hundreds of tabs, and gets revisited only if profiling says so.

## Alternatives considered

- **A renderer-side authoritative store, with main as executor.** Rejected: it would put privileged decisions in a renderer and invite drift.
- **Fine-grained patches.** Deferred until profiling shows a need.
