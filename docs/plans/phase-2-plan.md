# Phase 2 plan: persistence and session restore

Approved by the user on 2026-10-20, with these decisions:

- add better-sqlite3;
- do the Electron 44.9.1 patch first;
- amend the schema;
- persist download history;
- build Recently closed.

Sources of truth: ADR-0001 to ADR-0009, especially ADR-0004 (persistence), ADR-0003 (tab model and the S2 restore procedure), ADR-0005 (main is authoritative, Zod IPC), ADR-0008 (testing) and ADR-0002 (web policy); the technical assessment's Part 5 (§5.3 schema, §5.5 write strategy, §5.6 migrations and backups, §5.7 URL hygiene, §5.9 crash recovery), Part 4 and Part 8 §8.2 (the Phase 2 acceptance); spikes S5 (data stack) and S2 (restore fidelity).

Working rules: each step is its own branch, and the next step starts only after the user approves merging the previous one. Nothing is pushed (the repository has no remote). From 2026-10-22 the user pre-approved the remaining work and its merges ("finish all phases"): the orchestrator reviews, re-runs the checks and merges each milestone with Veyra.

**Status: done.** Every step below is merged into main (37cf076, M2.2b, being the last); the as-built record and the Milestone 0.1 acceptance follow the plan, under [As built](#as-built). The plan text is kept as approved.

## Step 0: Electron 44.9.1 patch

Branch `claude/electron-44.9.1`, from main.

- Pin exactly 44.9.1 in `package.json` and the lockfile, then run `npm run setup`.
- Verify the downloaded zip against Electron's `SHASUMS256.txt` for v44.9.1 and report the hash.
- Read the 44.9.0 → 44.9.1 release notes for anything touching our surface:
  - `WebContentsView`, `BaseWindow` and `setWindowOpenHandler`/`createWindow`;
  - `will-frame-navigate`, `will-download`, the `login` event, permission handlers;
  - `navigationHistory.restore`, `webRequest`, fuses, `shell.openExternal` and `openPath`;
  - security fixes.
- Run typecheck, lint, unit tests, full E2E, lifecycle, `package:dir` and a packaged-app launch.
- Update ADR-0001's pin note, and the README if it names the version.

## M2.1a: data worker foundation

Branch `claude/m2.1a-data-worker`, from main after Step 0 merges.

- Add better-sqlite3, exact pin, latest 13.x (N-API). It is MIT; record the license.
  - Keep `ignore-scripts`. Add an explicit setup step that fetches the prebuilt win32-x64 N-API binary, as Electron's install is handled, and verify its integrity. S5 showed this works with no compiler.
  - No other new runtime dependencies without asking.
- The data worker (`worker_threads`). The main process never imports better-sqlite3; a lint rule or a test enforces that.
  - Typed RPC: request ids, Zod-validated requests and responses, per-call timeouts, bounded queries.
  - The worker opens the database in `userData`.
  - Pragmas exactly per ADR-0004 and S5: `auto_vacuum=INCREMENTAL` before WAL on a new database, `synchronous=NORMAL`, `foreign_keys`, `busy_timeout=5000`, `secure_delete`, `temp_store=MEMORY`, `cache_size=-16000`.
- The migration runner:
  - numbered SQL files bundled with the worker, versioned through `PRAGMA user_version`;
  - each migration inside `BEGIN IMMEDIATE`;
  - a backup before upgrading an existing database;
  - a database newer than the app is refused with a clear error.
- `0001_init.sql` is §5.3 verbatim, plus these amendments:
  - (a) `permission_decisions.decision` is `'allow'|'block'`, matching the code's `Decision` type;
  - (b) an external-protocol "always allow" is stored there as permission `'protocol:<scheme>'` with origin = the site;
  - (c) a new `downloads` table: id, file_name, path, url (secret-stripped), site, state, dangerous, confirmed, received_bytes, total_bytes, started_at, ended_at, with CHECKs;
  - (d) client-hint opt-ins go in `app_state`.
  - Every amendment is recorded in ADR-0004 and the assessment.
- Repositories for tabs, app_state, app_runs, settings, permission_decisions and downloads, plus the FTS triggers as specified. Unit and integration tests run against a real database under Vitest/Node.
- Migration tests: a fixture database at every schema version upgrades and verifies.
- Packaging:
  - `asarUnpack` only the `.node` file and what it needs; S5 found the whole module unpacks (26 MiB) unless filtered;
  - the native rebuild step stays off;
  - the packaged app's worker loads from `app.asar` and opens the database;
  - `check-production-build` is extended for any new test-only names.
- Acceptance: typecheck, lint, unit, migration tests, full E2E (the app is unchanged for users), lifecycle, `package:dir` plus a packaged launch that creates the database, and proof that no SQLite work runs on the main thread.

## Later milestones

Each gets its own brief from the orchestrator.

### M2.1b: durability

- `app_runs` heartbeat every 60 s.
- Shutdown flush with a 3 s timer, then `process.kill`.
- `quick_check` after an unclean exit.
- Daily idle backup (only if changed, keep 3).
- Corruption: rename to `.corrupt-<ts>`, restore the newest backup or start fresh, plus a banner.
- Weekly idle integrity and FTS checks.

### M2.2a: session restore

- Batched dirty flush (1 s, or 250 ms for structural changes); the tabs table is the live session.
- `restore_state` ≤ 50 entries, with token fragments stripped.
- Single-instance lock.
- Startup: the whole workspace unloaded, and only the selected tab loads (S2: a new view, attached before `restore()`, entries validated).
- Window bounds in `app_state`.
- Crash detection and safe mode (2+ unclean exits within 60 s), plus a "recovered your session" banner.
- Recently closed: placement `'closed'`, kept 7 days; Ctrl+Shift+T restores with history and replaces the in-memory 25-tab list.
- Acceptance: 20 scripted hard kills at random moments all restore cleanly.

### M2.2b: history and stored decisions

- Visits recorded per §5.5, with transitions and a 2 s title debounce.
- URL hygiene per §5.7: `url_key` normalization, tracking parameters removed, secrets stripped, OAuth callbacks skipped.
- Favicons deduplicated by sha256; frecency.
- A Zod settings document (no UI until Phase 5).
- Persisted permission decisions (the dismissal embargo stays per session), protocol always-allow, client-hint opt-ins and download history.
- The retention job (visits older than 365 days, closed tabs older than 7 days).
- The result is Milestone 0.1: daily dogfooding.

## As built

Each milestone's full report (features, decisions, tests run, limitations) is in the orchestrator's shared notes; ADR-0004 items 7 to 10 and ADR-0003 item 11 record the design as built.

| Step | Branch, merged tip | Result |
|---|---|---|
| Step 0 | `claude/electron-44.9.1`, cd10ab1 | Electron 44.9.1, zip checked against SHASUMS256; no code changes |
| M2.1a | `claude/m2.1a-data-worker`, 936cd5a | better-sqlite3 13.0.3 in a worker thread, typed RPC, migration runner, 0001 with amendments (a)–(d) |
| M2.1b | `claude/m2.1b-durability`, ff3d6d8 | app_runs heartbeat, checks after a crash, corruption recovery with a notice, idle backups and checks, the 3 s quit cap |
| M2.2a | `claude/m2.2a-session-restore`, 323cf47 | the live session in `tabs`, restore before the window, safe mode, Recently closed, one instance per profile |
| M2.2b | `claude/m2.2b-history-decisions`, 37cf076 | visits and URL hygiene, frecency, favicons, retention, the settings document, stored decisions, download history |

### Deviations from the plan

- **M2.1a: the SQLite binary is pinned, not fetched.** better-sqlite3 13.x ships its N-API prebuilds inside the npm tarball, so the setup step verifies the binary's SHA-256 (`scripts/sqlite-pin.mjs`) instead of downloading one. `ignore-scripts` stays on.
- **M2.1b: one data worker, not two.** A read-only second connection can't run FTS5's integrity check, and the full check costs about 0.5 s at 50,000 pages while the user is idle, so it stays in the worker. Every backup is taken behind a full check (a test found that a quick check alone let a damaged index replace good backups).
- **M2.2a: Recently closed** replaces Phase 1's in-memory list of 25 with the database's 7 days: the newest 100 are loaded at startup, and up to 100 are kept per run. A reopened tab keeps its id. A pinned tab that was closed reopens unpinned after a restart, because the schema allows pins only in the strip. The single-instance lock is retried for about 2 s, because right after a kill Windows can refuse Chromium's lock file for a moment; the database open retries transient I/O errors for the same reason.
- **M2.2b: favicons are stored as the bytes the favicon service validated, not re-encoded.** The plan (and §5.3) had main re-encode each icon to a PNG of at most 64×64. That decodes a server's image bytes in the one unsandboxed process (threat T5), so the review replaced it:
  - a favicon row holds the sniffed raster bytes (at most 64 KiB, never SVG) and their type, deduplicated by SHA-256 of the bytes, and the data worker sniffs them again before storing;
  - **migration 0002** renames `favicons.png` to `bytes` and adds `mime` with a CHECK over the six raster types, by two `ALTER TABLE`s (a rebuild would run `ON DELETE SET NULL` and clear every icon reference). It is the migration runner's first real upgrade, tested on the frozen v1 fixture and in the packaged app;
  - the 64×64 limit is the shell's, when it draws an icon; ESLint bans `nativeImage` in `src/main`.
- **M2.2b: download ids are UUIDv7,** the rows' keys, and the shell's schema requires them (the per-run `download-N` ids would collide across runs).
- **Not in the plan, found by its tests and fixed in M2.2b:** Chromium (Electron 44) reports a page's favicon candidates only when they differ from the previous page's in the same tab, so the second of two pages with the same icon showed none, in Phase 1's tab strip too. The tab runtime now reuses the last candidates.

### Milestone 0.1: acceptance (assessment §8.2)

Phase 2's acceptance, with its evidence. The runs are on M2.2b's tip (37cf076) unless noted, on the user's laptop under load.

| Criterion | Evidence | Proved by |
|---|---|---|
| **20 scripted hard kills at random moments all restore cleanly** | 20/20 rounds restore exactly the last saved session, or the save in flight at the kill; only the selected tab loads, and the "session recovered" notice shows. The kill moments are spread over 0.3–5.3 s, on one profile that grows to over 100 tabs. Lifecycle suite 7/7 on 37cf076 (143 s); first passed in M2.2a, where two rounds were killed with a save in flight. | `tests/lifecycle/hard-kill.test.ts`: "restores the last saved session cleanly after each of 20 kills at random moments" |
| **Only the selected tab loads at startup** | After a restart every tab is back, in order with its pins, and only the selected one has a web contents; the others load when selected. In safe mode none loads. | `tests/e2e/session.spec.ts`: "in their order, pinned first, with title and address; only the selected tab loads" and "two quick crashes in a row start safe mode…"; also asserted in every round of the hard-kill test |
| **Migration tests pass** | Every schema version has a fixture: version 0 (a new file), version 1 (the frozen `veltriva-v1.db`), and the real upgrade to version 2 (bytes, icon references and foreign keys kept; an upgraded file has the same schema as a new one). Refusals: a newer, foreign, not-a-database or gapped-history file is refused unchanged, and a failed upgrade rolls back and keeps its backup. Unit suite 4,498/4,498 on 37cf076. The packaged app also upgraded a real v1 file to v2, with a backup, on 2026-10-22. | `src/data/database.test.ts` (describes "a new database (version 0)", "the version 1 fixture", "migration 2: favicons keep their bytes and type", "a database the app must refuse") |
| **Profiling shows no database work on the main thread** | A CPU profile of the main process, taken through `node:inspector` while the app records visits, titles and an icon, holds main's own code and no frame from the data worker's bundle or better-sqlite3, and main's module registry has neither. The database answers from its own thread (`threadId` > 0). Structurally: ESLint bans SQLite and `src/data` imports in main, and `check-data-isolation` refuses any build file but the worker that mentions SQLite. S5 measured the cost this avoids: a 1.09 s query on main stalled it 1,489 ms, against at most 15 ms of timer drift with the worker. | `tests/e2e/main-thread.spec.ts`; `tests/e2e/data-worker.spec.ts`: "opens the database in the profile, on its own thread…" and "never loads SQLite's native addon into main's own module registry"; `scripts/check-data-isolation.mjs` (run by `test:e2e` and `package:dir`) |

**Milestone 0.1 (daily dogfooding) is reached** by these criteria. The other gates: typecheck, lint and format clean (ec2f28a, then each later change checked on its own); full E2E 383 of 384 on d73c87b, the one failure an out-of-date schema-version expectation, fixed in 37cf076 and passing alone; `package:dir` and three packaged launches clean on 37cf076. What only a person can check, with the real app, is in `docs/testing/phase-2-manual-checks.md`.
