# Phase 2 plan: persistence and session restore

Approved by the user on 2026-10-20, with these decisions:

- add better-sqlite3;
- do the Electron 44.9.1 patch first;
- amend the schema;
- persist download history;
- build Recently closed.

Sources of truth: ADR-0001 to ADR-0009, especially ADR-0004 (persistence), ADR-0003 (tab model and the S2 restore procedure), ADR-0005 (main is authoritative, Zod IPC), ADR-0008 (testing) and ADR-0002 (web policy); the technical assessment's Part 5 (§5.3 schema, §5.5 write strategy, §5.6 migrations and backups, §5.7 URL hygiene, §5.9 crash recovery), Part 4 and Part 8 §8.2 (the Phase 2 acceptance); spikes S5 (data stack) and S2 (restore fidelity).

Working rules: each step is its own branch, and the next step starts only after the user approves merging the previous one. Nothing is pushed (the repository has no remote).

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
