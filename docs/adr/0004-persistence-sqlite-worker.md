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
   - **Favicons** are stored as the bytes the favicon service validated, never decoded or re-encoded in main (threat T5: a decoder bug reached from a server's bytes must not run in the one unsandboxed process).
     - Main takes the raster image the service accepted (sniffed by its magic number, at most 64 KiB, never SVG; core/net/favicon-format.ts) and sends its bytes and type. The worker sniffs the bytes again and refuses them unless they match the type, then stores them once per SHA-256 of the bytes.
     - Migration 0002 renamed `favicons.png` (0001's plan was a re-encoded PNG) to `bytes` and added `mime`, with a CHECK over the six raster types. Two `ALTER TABLE`s rather than a rebuild, because dropping the table would run its `ON DELETE SET NULL` and clear every page's and tab's icon. It is the runner's first real upgrade, tested on the frozen v1 fixture.
     - The 64×64 limit of §5.3 is now the shell's: it scales the image when it draws it.
     - An icon is stored only for a page that was. ESLint bans `nativeImage` and its `createFrom*` decoders in `src/main`; a trusted asset needs a reviewed exception.
   - **Retention**, in the idle upkeep (`maintenance.run` now takes `visitRetentionDays` from the settings document): visits older than the setting (365 days by default), pages and icons nothing refers to any more, and closed tabs older than 7 days.
     - Each statement deletes at most 2,000 rows in its own transaction, at most 25 chunks per table per run, and the worker answers other calls between chunks. A first run after a long time away catches up over a few idle periods.
     - Closed tabs go before the orphan scan, so an icon only they used goes in the same run. The scan reads every page, so it runs only after visits or closed tabs were deleted, and once per worker start.
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
11. **As built in Phase 3** (no migration; the schema of §5.3 already had the columns):
    - **M3.1:** a discarded tab's stack reaches `tabs.restore_state` like any other, as URLs and titles. Chromium's page state stays in memory (item 4); an E2E test checks that the string `pageState` is nowhere in the file.
    - **M3.2:** `tabs.last_used_engaged` and `last_used_active_day` now hold the engagement clock's values at each tab's last use (Phase 2 wrote 0, which is read as "now"). The clock itself is the app_state document `engagement` (`{ engagedMs, activeDay, dayKey, dayEngagedMs }`), written every 5 minutes, on a new day and at quit, and checked like any input when read. The settings document gains its `lifecycle` section (ADR-0003 item 13).
    - **M3.3:** Sleeping and the Archive are rows like the strip's: `placement` `shelf` (with its position, newest first) and `archive` (with `archived_at` and `archive_reason`), plus `user_protected` and `placement_changed_at`, all columns §5.3 already had.
      - Two data methods, both served by `tabs_archived_idx`: `tabs.listArchived` (newest first) and `tabs.countArchived` (the sidebar's count).
      - Main keeps the newest 200 archived tabs in memory. An archived tab that leaves that list keeps its row: the session store forgets it rather than deleting it, and the count still includes it.
      - The activity log is the app_state document `activity` (`{ entries }`, the newest 500), written at most every 10 s and at quit. A tab's title and address are cut to 200 and 500 characters, so the document stays under 1 MiB. It is read leniently: a field a later version adds is ignored, and a damaged entry is dropped alone. A private tab's entries are never written (I6).
    - **M3.4:** the regret metric is the app_state document `regret` (`{ since, counts, events }`, the newest 200 events), written at most every 10 s and at quit, checked when read (an unreadable one starts counting again). The settings document's lifecycle section gains `preview` (`auto` or `off`) and `protectedSites` (at most 1,000 sites); main writes the settings document for the first time, when the user pauses automation, starts it early or protects a site (Phase 5's settings page will write the rest). Each field still falls back to its default alone.
12. **As built in M4.1** (searching the memory; assessment §5.4; no migration):
    - **`search.query`** takes the user's words as typed, main's clock and a limit (at most 200). Optional filters narrow the candidates before the 200 limit, so an archived tab behind 200 better matches is still found:
      - a placement (Tabs, Sleeping, Archive);
      - a site;
      - a time the page was visited since.
    - **How the worker answers** (`src/data/repos/search.ts`):
      1. It builds the MATCH with `core/search/query.ts`: each word is double-quoted and prefix-starred, and every FTS5 operator character only separates words. A word of marks alone is dropped, because one empty phrase in the implicit AND matches nothing (measured).
      2. It ranks with bm25(10, 3, 5), keeping 200.
      3. It joins the pages and the tabs showing them. A closed tab is never shown.
      4. It re-ranks with `core/search/ranking.ts`, returns the best `limit`, and marks only those titles.
    - **The recent-and-frequent list:** input without a 2-character word gets it, from `pages_frecency_idx`, plus the pages open in the strip.
    - **The SQL holds no user text:** the expression and every filter are bound parameters. One statement is prepared per mode and filter combination.
    - **`tabs.page_id` is now filled.** The worker links each tab row that `session.save` or `tabs.upsertMany` writes to the page its address is keyed by. The key is the history recorder's (`core/url/hygiene.ts`, through `repos/page-links.ts`), so main never tracks it.
      - Rows saved before M4.1 are linked by idle maintenance: 500 a statement, once per worker, ahead of retention.
      - The session store compares loaded rows with `pageId` set aside, so the link never makes a start rewrite every row.
    - **Retention keeps a page that a non-closed tab shows**, even after its visits expired. An archived tab must stay findable by its own words. Before M4.1 such a page went, and the tab kept no page.
    - **Measured** (`docs/benchmarks/search.md`, median of 3 runs on the loaded reference laptop, end to end through the RPC with 50 results):
      - 10,000 pages: p95 4.3 ms;
      - 50,000 pages: p95 10.3 ms, p99 12.8 ms, and the first search on a cold index 25 ms.
      - A first search fired during startup waits for startup: 134–222 ms.

13. **As built in M5.1** (settings and site rules; **migration 3**, `0003_site_rules.sql`):
    - **Site rules move to their table.** M3.4 kept the sites the user protects in the settings document (`lifecycle.protectedSites`). M5.1 adds excluding a site from the memory, which `site_rules` already had a column for, so both rules now live there.
      - **The migration:** each listed site becomes a row with `protect = 1`, and an existing row keeps its `exclude_memory`. Only what the document's schema read is copied: text of 1–253 characters, the first 1,000, lower case. Then the list leaves the document.
      - **Tests:** a frozen schema-2 fixture (`migrations/fixtures/veltriva-v2.db`, generated once by `generate-v2.mjs`) covers the copy, the merge with an existing exclusion, what is dropped, and the 1,000-entry cap.
    - **Two data methods.** `siteRules.list` (by site) and `siteRules.set` (both rules; a site with neither loses its row). `siteRules.set` counts as a write for the backup. `history.recordVisit` already refused an excluded site's visit in the worker, so an exclusion holds even if main has not caught up.
    - **The settings document is now written whole by main** (`main/settings/settings-service.ts`). It is read leniently, as before, so a bad field falls back alone. A change is applied strictly: the change and the document it makes must both pass the strict schema, or nothing is kept.
    - **What the document gains:**
      - `startup` (`restore` or `new-tab`);
      - `memory.paused` ("Pause memory": while on, the history recorder sends nothing for a commit, and the title and icon of a page committed then aren't written either);
      - two overrides, `moderatePressurePercent` and `criticalPressurePercent`, kept in order.

14. **As built in M5.2** (clearing data, §5.7; no migration):
    - **`memory.forget`** is one data method with three scopes: `pages` (one entry: pages, and the archived or closed tabs named), `site` (every page of the site and its archived and closed tabs), and `since` (the visits since then; with `tabs`, the tabs archived or closed since then; `since` 0 is everything).
    - **Each request is one transaction.**
      - The pages go with their visits (`ON DELETE CASCADE`). The FTS triggers remove their index entries, and `secure_delete` plus FTS5's `secure-delete` overwrite the freed content.
      - Icons nothing shows any more go in the same transaction.
      - An open or Sleeping tab is never deleted: the statement only matches `archive` and `closed` rows.
    - **A time range keeps what is older.** Only pages that had visits in the range are touched: one left with none goes, and one with older visits gets its counts, times and frecency recomputed from what is left, by replaying its visits. A page with no visits at all is left alone; retention keeps those for archived tabs (item 12).
    - **Then, after the commit, `incremental_vacuum` and `wal_checkpoint(TRUNCATE)`, in that order.** The vacuum writes to the WAL too, so checkpointing first left 600 KB in it (found by the test). Both files shrink, and what was deleted is in neither.
    - **What the tests verify** (`src/data/repos/forget.test.ts`, a real file):
      - the rows are gone and the FTS index has no hit, with the integrity check passing;
      - the database shrinks to under half and the WAL to 0 bytes, with no free pages left;
      - a deleted page's unique word is in neither file's raw bytes once the deletion has checkpointed.
    - **For a site, the worker also returns the origins of what it deleted**, so main can clear their storage in Chromium (ADR-0002 item 13).

15. **As built in M5.3** (no migration):
    - **The app_state document `scroll`:** `{ tabs: { [tabId]: { url, x, y } } }`, where each tab was scrolled (`main/session/scroll-keeper.ts`).
      - **When it is read:** from the page's isolated world, never its own (ADR-0002), when a tab is hidden, and every 15 s for the selected tab, so a quit loses at most that.
      - **What is never kept:** a page with a password or payment field, and a page at the top.
      - **What is stored:** only tabs that still exist, at most 500. It is written 5 s after a change and at quit.
      - **How it comes back:** once, after a restored tab's first load, and only on the address it was read on. Chromium's own page state stays out of the database (item 4); this is two numbers.
    - **The diagnostics page reads the database's size and upkeep:** the file and WAL sizes from disk, and `maintenance.status` for the last backup and check.

16. **No title or address-bearing document keeps what URL hygiene cut** (a privacy fix in M5.3; no migration).
    - **The leak:** Chromium gives a history entry with no title of its own its address as the title, fragment and all. That covers a page without a `<title>`, for good, and any page while it loads. Measured on Electron 45: `navigationHistory.getAllEntries()` reported `127.0.0.1:…/untitled?case=a#/cb?code=…&state=…` as the title, and no `page-title-updated` fired.
      - **Where it went:** the session cleaned each entry's address but kept that title. So a save mid-load wrote an OAuth callback's `code` into `tabs.restore_state`; a later save replaced it, and a hard kill kept the old WAL frame. That was `history.spec.ts`'s hard-kill flake (mode a), which predates Phase 5.
      - **For a page with no title, the leak was permanent,** even after a clean quit.
    - **The rule, `keptTitle` (`core/session/history.ts`):** a title goes (it becomes `''`) when cleaning its address cut something (credentials or a token-bearing fragment), or when the title itself holds a token-bearing fragment.
      - **Why both checks:** the second also catches a title saved before the rule, read back from the database. The first doesn't depend on how Chromium formats a title, so it holds even where the title doesn't show the fragment as the address has it.
      - **Where it applies:** every cleaned stack (`sanitizeEntries`: the session's `restore_state` and the in-memory discard snapshot), the tab row's `title`, and the activity log's entries (`loggedTab`).
      - **What it costs:** a real title on such an address isn't kept in the session; the tab shows its address until the page loads.
    - **Two more writers kept the live address:**
      - **The activity log** (the app_state document `activity`, M3.3) now keeps each address as the session does.
      - **ScrollKeeper** keeps no position for an address the session would cut, and refuses one in a stored document.
    - **The tests:**
      - `history.spec.ts` visits a callback page with no title.
        - Without the rule, the clean-quit and hard-kill tests both fail every time, finding its code and state in the file.
        - With it, they pass. The hard-kill test also waits for the session save before the kill, which was its own race (mode b).
        - `launchAfterKill` kills a launch that hung before it tries again. Such a launch kept the profile's lock, so every retry quit at once (seen once in 15 runs).
      - Unit tests cover the hash-route forms `#/cb?code=…&state=…`, `#access_token=…` and `#id_token=…`.

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
