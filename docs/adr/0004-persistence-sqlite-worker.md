# ADR-0004: SQLite via better-sqlite3 13, in a worker thread

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | The approved architecture (persistence) |
| **Validated by** | Spike S5 (data stack) |
| **Details** | Technical assessment §2.3, §2.6, Part 5 |

## Context

Veltriva has to:

- persist the workspace (tabs), the memory (pages and visits) and settings;
- recover from hard kills;
- search 50,000 records quickly;
- delete data for real.

Electron's main-process JavaScript runs on Chromium's browser UI thread, so any synchronous query there delays input to *every* page.

## Decision

1. **SQLite through better-sqlite3 ≥ 13.0.2.** Version 13 uses N-API, so one `win32-x64` binary works in Electron and in plain Node. It runs in a dedicated `worker_threads` worker, behind an async repository interface, and the main process never touches SQLite directly.
2. **Settings and constraints.** WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `secure_delete=ON`, `auto_vacuum=INCREMENTAL`. Tables are `STRICT`, with `CHECK` constraints.
3. **Schema.** Workspace objects (`tabs`) are kept separate from memory (`pages`, `visits`). Alongside them:
   - an external-content **FTS5** index over pages (`unicode61` tokenizer, prefix indexes, `secure-delete`);
   - `app_runs` for crash detection;
   - settings as one Zod-validated JSON document.

   The initial schema is in assessment §5.3.
4. **Never stored:** Chromium page state (form values, scroll), page content (until opt-in content indexing), passwords.
5. **Operations.**
   - Writes are batched: within 1 s, or 250 ms for structural changes.
   - Migrations use `user_version`, with a backup before each one and protection against opening a newer database.
   - Online backups run daily, keeping 3.
   - A corrupt database is quarantined and the newest backup restored.
6. **Installs** run with `ignore-scripts=true` (the project's `.npmrc`).

## Consequences

- **Positive:** the UI thread stays responsive regardless of query cost, persistence is crash-safe, and the data layer is testable on plain Node.
- **Positive:** `node:sqlite` is a drop-in fallback behind the same interface. It's a release candidate in Node 24 and 26, and present in Electron 42+.
- **Negative:** an RPC layer between main and the worker.
- **Negative:** a native dependency, mitigated by N-API and the fallback.

## Alternatives considered

- **`node:sqlite` as the primary driver.** Zero dependencies, but it couples the data layer to each Electron release's Node build. Electron 37.2.0 shipped without it, and a broken build would block a security upgrade.
- **SQLite on the main thread.** Rejected because it blocks the UI thread.
- **An ORM.** Rejected: FTS5 and migrations want plain SQL.
