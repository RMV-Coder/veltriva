# ADR-0004: SQLite via better-sqlite3 13, in a worker thread

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | The approved architecture (persistence) |
| **Validated by** | [Spike S5](../spikes/s5-data-stack.md) (data stack: confirmed, with pragma, query, shutdown and maintenance amendments below) |
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
2. **Settings and constraints.**
   - Connection pragmas: WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `secure_delete=ON`, `busy_timeout=5000`, and an explicit `cache_size=-16000` (16 MB). With a smaller cache, searches at 50k pages were about 2.5× slower (S5). Setting it explicitly keeps the `node:sqlite` fallback, whose default cache is 2 MB, equally fast.
   - **Order matters:** on a brand-new file, `auto_vacuum=INCREMENTAL` must be set *before* `journal_mode=WAL`. In the reverse order it silently stays off (S5).
   - Tables are `STRICT`, with `CHECK` constraints.
3. **Schema.** Workspace objects (`tabs`) are kept separate from memory (`pages`, `visits`). Alongside them:
   - an external-content **FTS5** index over pages (`unicode61` tokenizer, prefix indexes, `secure-delete`);
   - `app_runs` for crash detection;
   - settings as one Zod-validated JSON document.

   The initial schema is in assessment §5.3. Two query-side rules come from spike S5:
   - **Search:** rank and `LIMIT 200` inside a CTE first, then join `pages` and `tabs` for those 200 rows, and mark title matches in shared JS rather than with `highlight()`. That cut the 50k-page p95 from 25 to 11 ms. Full-text queries need at least 2 characters; shorter input shows the recent-and-frequent list instead.
   - **Recent and frequent:** an expression index on `log2(frecency) + frecency_at / H` (H being the half-life as a literal) serves the empty-query listing in about 0.4 ms instead of a 29–45 ms scan. It gives the same order as decaying every score at query time, because the shared "now" term cancels out.
4. **Never stored:** Chromium page state (form values, scroll), page content (until opt-in content indexing), passwords.
5. **Operations.**
   - Writes are batched: within 1 s, or 250 ms for structural changes.
   - Migrations use `user_version`, with a backup before each one and protection against opening a newer database.
   - Online backups run daily, keeping 3.
   - A corrupt database is quarantined and the newest backup restored.
   - **Every statement is treated as unkillable.** Neither driver can interrupt a running statement, `worker.terminate()` waits for it, and so do `app.quit()` and `app.exit()` (S5). Therefore:
     - Queries are always bounded: `LIMIT`, candidate caps, and no user-supplied SQL.
     - Maintenance (integrity checks, FTS rebuilds, vacuuming) runs only when idle, in small chunks or on a second worker.
   - **Shutdown enforces its 3-second cap while the event loop is still alive.** `before-quit` awaits the worker's flush and close against a 3 s timer. If the worker hasn't finished, the process hard-exits with `process.kill(process.pid)`. S5 killed processes mid-write five times, and every database reopened intact, thanks to WAL.
6. **Installs** run with `ignore-scripts=true` (the project's `.npmrc`).

## Consequences

- **Positive:** the UI thread stays responsive regardless of query cost, persistence is crash-safe, and the data layer is testable on plain Node. S5 measured it: while the worker ran a 1.09 s query, main-thread timers drifted by at most 15 ms. The same query run on the main thread stalled it for 1,489 ms.
- **Positive:** search is fast enough. At 50,000 pages, round-trip p50/p95/p99 was 7.3/23.4/29.3 ms on a low-end Core i3 laptop shared with other spikes. The restructured query cuts p95 to about 11 ms. The database is 8 MiB at 10k pages and 40 MiB at 50k.
- **Positive:** `node:sqlite` is a drop-in fallback behind the same interface. It's a release candidate in Node 24 and 26, and present in Electron 42+.
- **Negative:** an RPC layer between main and the worker.
- **Negative:** a native dependency, mitigated by N-API and the fallback.

## Alternatives considered

- **`node:sqlite` as the primary driver.** Zero dependencies, but it couples the data layer to each Electron release's Node build. Electron 37.2.0 shipped without it, and a broken build would block a security upgrade.
- **SQLite on the main thread.** Rejected because it blocks the UI thread.
- **An ORM.** Rejected: FTS5 and migrations want plain SQL.
