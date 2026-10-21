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
7. **As built in M2.1a** (Phase 2, the data worker foundation):
   - **The dependency.** better-sqlite3 **13.0.3**, pinned exactly, MIT. It has no install script: its N-API binaries ship inside the npm tarball, which npm checks against the lockfile's sha512, so nothing is downloaded or compiled.
     - The worker loads the `better-sqlite3/win32-x64` entry point, which requires that one binary directly.
     - `scripts/verify-sqlite-binary.mjs` pins the binary's SHA-256 (`e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a`, in `scripts/sqlite-pin.mjs`). `npm run setup` runs it after `npm ci`, and `npm run package:dir` runs it before packaging.
     - Its one dependency, node-addon-api 8.9.2 (MIT), holds C++ headers for building from source; it isn't packaged.
     - The package ships no TypeScript types. `src/data/better-sqlite3.d.ts` declares only the subset the worker uses.
   - **Where the code lives.**
     - `src/data/` is the worker, with its own tsconfig. `src/shared/contracts/data-rpc.ts` is the contract, and `src/main/persistence/` is main's client and the worker's start and stop.
     - electron-vite builds the worker as a second main-process entry, `out/main/data-worker.js`. Main starts it by file name.
   - **Main never runs SQLite.** Four checks enforce it:
     - ESLint bans `better-sqlite3` and `node:sqlite` everywhere outside `src/data`, and bans any import of `src/data` from `src/main`.
     - `scripts/check-data-isolation.mjs` runs after every E2E and packaging build: no file in `out/` but the worker may mention SQLite.
     - The E2E suite checks that `db.info` answers from a thread other than 0, and that main's own module registry holds no native addon.
     - The packaged app runs the same worker from `app.asar`.
   - **The RPC.**
     - Each request has an id. The worker parses every input with the method's strict Zod schema, and main parses every output.
     - Each call has its own timeout: 5 s by default, counted from the call, including any wait for the database to open. At most 256 calls are in flight.
     - Every list takes a capped `limit`, and every write batch is at most 1,000 rows, as one transaction.
     - No method takes SQL, a table name or a column name.
     - Errors are codes. A detail is only ever a SQLite result code or a schema version, never row data or an error message. A `SQLITE_CONSTRAINT_*` refusal is reported as `invalid_input`.
   - **Opening.**
     - The pragmas are set in S5's order and each one is read back; a mismatch fails the open.
     - A database newer than the app (`db_newer`) or another app's SQLite file (`db_foreign`) is refused, and nothing in it is changed.
     - Before an existing database is upgraded, SQLite's online backup API copies it to `backups\veltriva-v<from>-before-v<to>-<time>.db` in the profile, keeping the newest 3. If the backup fails, the upgrade doesn't run.
     - Each migration runs in `BEGIN IMMEDIATE` and sets `user_version` inside the same transaction, then `foreign_key_check` runs.
   - **Quitting.** `before-quit` waits up to 3 s for the worker to close the database and exit, and hard-exits with `process.kill(process.pid)` if it doesn't. M2.1b adds the final flush and the tests with a busy worker.
   - **Schema amendments in `0001_init.sql`**, the user's Phase 2 decisions (assessment §5.3 has the same list):
     - (a) `permission_decisions.decision` is `'allow'` or `'block'`, the code's `Decision` type, not §5.3's `'allow'` or `'deny'`.
     - (b) An external protocol's "always allow" is a `permission_decisions` row with permission `protocol:<scheme>`, origin the asking site's origin, and decision `'allow'`.
     - (c) A new `downloads` table for download history. Its CHECKs: only a dangerous file can be unconfirmed; only a running or paused download has no `ended_at`; byte counts are never negative. Its ids are UUIDv7, so M2.2b gives DownloadManager persistent ids in place of today's per-run `download-N`.
     - (d) Client-hint opt-ins are the `app_state` document `client_hints`, with no table of their own.
   - **Migration tests.** Every historical version has a fixture: 0 is a new file, and 1 is `src/data/migrations/fixtures/veltriva-v1.db`, frozen when 0001 was released. Each new migration adds the previous version's fixture.
8. **As built in M2.1b** (durability; assessment §5.5, §5.6, §5.9):
   - **Each launch is an `app_runs` row.** The worker records it before it serves anything (`src/data/startup.ts`), and main moves its heartbeat every 60 s and ends it cleanly on quit. A row that never ended is a crash. The next start closes it at its last heartbeat with `exit_kind = 'crash'`, and `ready` reports `previousExit`.
   - **Checks on opening.** After a crash, a `quick_check` runs. The full check (`integrity_check` plus FTS5's `integrity-check`) runs instead when the last run left `veltriva.db.needs-check` beside the database. That marker is written when SQLite reports `SQLITE_CORRUPT*` or `SQLITE_NOTADB` while serving, or when an idle check fails. Measured at 50,000 pages (21 MiB): `quick_check` about 0.25 s, `integrity_check` about 0.35 s, FTS5's check about 0.15 s.
   - **Corruption.** A damaged database is never deleted. A failed open with a corruption code, or a failed check, renames it and its side files to `veltriva.db.corrupt-<time>`.
     - The worker then restores the newest backup, of either kind, that opens read-only, has a schema version this build knows and passes `quick_check`. An older one is migrated as usual.
     - With no usable backup, it starts an empty database.
     - A newer or foreign database is still refused, never replaced.
     - `ready` reports the recovery, and main shows a notice naming the kept file (`src/main/notices/app-notices.ts`).
   - **Idle upkeep.** Main calls `maintenance.run` only after 5 minutes without user input (`powerMonitor.getSystemIdleTime`), checking every 10 minutes, never overlapping. The worker decides what is due:
     - the full check, weekly;
     - a backup, daily, and only if the user's data changed since the last one. The heartbeat doesn't count as a change.
     - **The full check runs before every backup**, so a damaged file never replaces a good backup. Review found that a `quick_check` isn't enough: it passes while the search index disagrees with `pages`. After a failed check, the check runs on every pass, and no backup is taken, until a restart recovers the file.
     - A `.partial` file left by a backup that a crash cut short is deleted when the worker starts.
   - **Backups.**
     - **They step.** SQLite's online backup API, through better-sqlite3, copies 100 pages per step, so requests are served between steps. It writes `veltriva-daily-<time>.db.partial`, then renames it, keeping 3.
     - **`db.close` stops one first.** Throwing from the backup's progress callback ends it at the next step.
     - **The "changed" flag can't race.** It lives in the `app_state` document `maintenance`, which no RPC method may touch and only the worker writes. A write during a backup sets it again.
     - **The weekly check stays in the worker.** A second, read-only connection can run `integrity_check` and a backup alongside a writer (measured), but FTS5's check is refused there as a write.
   - **Quitting.** `DataLifecycle.shutdown` first runs the registered flushes (`addFlush`, for M2.2a's batched writes), then ends the run cleanly, then closes, all inside one 3 s cap. If the cap is reached, the process hard-exits with `process.kill(process.pid)`, which gives exit code 1 on Windows.
     - A lifecycle check holds the worker in a 20 s statement and closes the window. The process exits at the cap, and the next launch reports a crash and quick-checks the file.
9. **As built in M2.2a** (session restore, ADR-0003 item 11):
   - **New methods.**
     - `session.save` holds one flush of the live session in one transaction: the changed tab rows, the deleted ids, and the `session` and `window` documents. A kill can never leave half of one.
     - `tabs.listClosed` returns Recently closed, newest first.
     - `tabs.purgeClosed` removes closed tabs older than 7 days, bounded.
   - **After a crash**, the WAL the killed run left behind is folded into the file at startup (`wal_checkpoint(TRUNCATE)`). Otherwise closing at the next quit had to do it inside the 3 s cap, and on a loaded laptop it sometimes didn't make it (found by the 20-kill test).
   - **Opening retries** transient `SQLITE_IOERR*`, `BUSY`, `LOCKED` and `CANTOPEN` errors for about 3 s. One `SQLITE_IOERR_TRUNCATE` was seen when E2E relaunched right after a kill. Every probe that relaunched the app directly, or opened the file from plain Node, opened cleanly. Corruption never retries.
10. **As built in M2.2b** (the memory and stored decisions; assessment §5.4, §5.5, §5.7):
   - **Visits.** TabManager tells `HistoryRecorder` (src/main/history) about each main-frame commit, with how the user got there: `typed` from the address bar, `generated` for its searches, `back_forward`, `reload`, `restore` (a restored or reopened tab), and `link` for anything else (a link, a form, a page's own script).
     - A cross-document commit is a visit. A same-document commit is one only when the page's key changed, so a fragment or a tracking parameter alone adds nothing.
     - The title at a commit is usually the previous page's, so a visit carries none. The title is written once it has been stable for 2 s (one write for a page that animates its title), and at once when the tab moves on or closes.
     - `history.recordVisit` finds or creates the page by its key and adds the visit in one transaction. A redirect hop is kept as a visit but not counted.
   - **URL hygiene** (core/url/hygiene.ts) runs in main, before anything is sent:
     - only http and https are recorded; an address with a username or password, or an OAuth callback (`code` with `state`, or a token in the query or the fragment), is never recorded;
     - the key (`url_key`) drops the fragment and tracking parameters (`utm_*`, `fbclid`, `gclid`, …);
     - the stored address drops parameters that carry credentials (`token`, `password`, `sig`, `X-Amz-*`, `code` beside `state`, …) and a token fragment.
   - **Excluded sites.** The worker records nothing for a site whose `site_rules` row says `exclude_memory` (`pageId` comes back null), so main never needs the list.
   - **Frecency** (core/search/frecency.ts) is updated in O(1) per visit: the stored score decays to the visit's time (half-life 30 days, as the index expects), plus the visit's weight (typed 2, link and generated 1, restore, back/forward and other 0.5, reload and redirect 0). A clock that went back never moves a page's times backwards.
   - **Favicons.** Main re-encodes the favicon service's validated image to a PNG of at most 64×64 with `nativeImage`, so the file holds pixels Chromium decoded, never a server's bytes. The worker checks the PNG signature, hashes it and stores it once per SHA-256. nativeImage decodes PNG, JPEG and ICO; other formats are shown but not stored. An icon is stored only for a page that was. The cost: main now decodes images a server chose, at most 64 KiB and identified by their bytes (threat T5). Moving the re-encoding to a sandboxed utility process is a follow-up.
   - **Retention**, in the idle upkeep (`maintenance.run` now takes `visitRetentionDays` from the settings document): visits older than the setting (365 days by default), pages and icons nothing refers to any more, and closed tabs older than 7 days.
     - Each statement deletes at most 2,000 rows in its own transaction, at most 25 chunks per table per run, and the worker answers other calls between chunks. A first run after a long time away catches up over a few idle periods.
     - The orphan scan reads every page, so it runs only after visits were deleted, and once per worker start.
     - Free pages then go back to the file system, 4,096 at most per run (`incremental_vacuum`).
     - Retention runs before the check and the backup, so both see what it changed. Nothing is deleted from a file whose last check failed, and damage the deletes run into counts as a failed check, with no backup.
   - **Settings.** The `settings` row is a Zod document (src/shared/contracts/settings.ts): the search template and the history retention for now. A missing or invalid field takes its default alone, and unknown fields are ignored. Main reads it at startup; nothing writes it until the settings page (Phase 5).
   - **Stored decisions,** read at startup within 3 s (src/main/persistence/stored-state.ts) and written through as the user makes them:
     - permission decisions (`permission_decisions`); the dismissal embargo stays in memory, for the run;
     - external-protocol "always allow" answers, as `protocol:<scheme>` rows (amendment (b));
     - client-hint opt-ins, as the `client_hints` document (amendment (d)), written at most every 5 s and at quit. Stored entries are checked again on load: secure origins only, known hints only.
   - **Download history** (amendment (c), src/main/downloads/download-store.ts):
     - Download ids are UUIDv7, the rows' keys; the shell's schema now expects one.
     - A row is written when a download starts, on every change of state, on Keep, and when it ends; progress at most every 2 s. Removing a download from the list deletes its row.
     - The source address is kept without secrets (`withoutSecrets`: a `data:` address keeps only its scheme), and the site is the initiator's registrable domain.
     - At startup the stored rows come back finished, with no DownloadItem. One that was running is `interrupted`. A dangerous file waiting for Keep stays so if its `.unconfirmed` file is still there, else it is `cancelled`.
     - The file is not trusted, and Open and Keep act on the stored path, so a row whose path is not absolute, or does not end in its own file name (plus `.unconfirmed` while it waits for Keep), is dropped and deleted.
   - A failed write is logged by code and dropped; the decision still holds for the run. Without a readable database, everything starts empty, as before Phase 2.

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
