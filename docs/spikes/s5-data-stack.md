# S5: Data stack

| Question | Status | Result | Environment | Code |
|---|---|---|---|---|
| Does a `worker_threads` data worker (better-sqlite3 13.0.3, ADR-0004 pragmas, §5.3 schema) run inside Electron's main process, and does `worker.terminate()` mid-query stay safe? | Done | **Confirmed.** 231 terminations in the final run (50 of them mid long read, fresh worker each) plus 30 more with `node:sqlite`: no process abort, DB intact. Caveat: `terminate()` cannot interrupt a running SQLite statement. | Windows 11 10.0.26200, Electron 44.7.2 / Chromium 152, Node 24.13 (Electron's own Node is 24.21), i3-1215U / 7.7 GB | [`spikes/s5-data-stack`](../../spikes/s5-data-stack) |
| Do FTS5 size, insert throughput and §5.4 latency hold at 1k / 10k / 50k pages? | Done | **Partly confirmed.** §5.4 p95 targets are met (round-trip p95 12.6 ms at 10k, 23.4 ms at 50k) only with a ≥ 16 MB page cache and ≥ 2-character queries. The literal §5.4 SQL spends more than half of its time on `highlight()` and the joins over all matches. | same | same |
| Is `node:sqlite` usable in Electron 44.7.2 main, with FTS5 and math functions, and how does it compare? | Done | **Confirmed** as a fallback. Available without flags, FTS5 and `exp`/`pow` present, and it matches better-sqlite3 once `cache_size` is equal. At its default 2 MB cache it is about 2.5x slower. | same | same |
| Does the packaged build (electron-builder 26.17.0 `--dir`) load the worker from `app.asar` and the native module, with no compiler? | Done | **Confirmed**, with two tuning notes. The worker loads from `app.asar`, the `.node` file is auto-unpacked and FTS5 works. The whole module folder is unpacked (26 MiB) unless filtered, and the native rebuild step must stay off. | same | same |
| Which packages pull in the deprecated `rimraf@2.6.3`, `glob@7.2.3`, `boolean@3.2.0`? | Done | **Reported.** All three come from electron-builder's tree and none reach the app at runtime. | same | same |

Labels used below: **observed** means measured in this spike; **inferred** means reasoned from observations and not tested directly.

## What we tested

All code is plain CommonJS in `spikes/s5-data-stack/`. Raw numbers are in `results/*.json`.

- **One worker file, two drivers.** `db-worker.js` is the data worker. It opens a file database with the ADR-0004 pragmas (`auto_vacuum=INCREMENTAL` before any table exists, then WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `secure_delete=ON`, `temp_store=MEMORY`). It applies `schema.sql`, which is §5.3 copied verbatim, and serves requests over `postMessage`. The `driver` option selects better-sqlite3 or `node:sqlite`. `lib/db-client.js` is the promise wrapper that main would use.
- **Synthetic data** (`lib/datagen.js`, seeded PRNG, byte-identical on every run).
  - About 2,200 distinct sites at 50k pages: a curated head of dev, docs, news, video, wiki and forum sites plus a long tail, with Zipf popularity.
  - Titles are template-generated from a vocabulary of about 75 technologies and about 90 concepts. 2.97 to 3.06 visits per page, 300 tabs with `restore_state` JSON, real frecency values.
  - The topic skew is heavy: the single token `postgres` matches 15% of the 50k pages. That is deliberately pessimistic for per-query cost.
- **Queries** (`lib/queries.js`): the §5.4 SQL verbatim. A MATCH builder that double-quotes and prefix-stars each token. 30 headline queries: 10 one-token, 6 short prefixes such as `po`, 8 two-token, 6 three-token. Four stress queries that match nearly everything (`h`, `https`, `com`, `the`). Two keystroke ladders.
- **Method.**
  - Each repetition rebuilds the database in a fresh worker, then reopens it in a second fresh worker (cold connection, warm OS file cache).
  - Per repetition: 2 warm-up passes, then 20 interleaved passes over the 30 queries (600 samples) in-worker, and the same 600 samples as `postMessage` round trips measured in main (rows structured-cloned back).
  - Percentiles pool all 600 samples. Every number is the median of 3 repetitions, with min to max where it matters.
  - Other spikes were running Electron on the same 6-core laptop, so treat absolute values as indicative. Run-to-run spread is visible in the ranges.
- **Scripts.**
  - `s5a-worker-terminate.js`: worker in main, `terminate()`, main-thread lag.
  - `s5b-bench.js`: insert, size, latency, recent and frequent listing, flush transaction. Both drivers.
  - `s5c-node-sqlite-probe.js`: `node:sqlite` availability and API.
  - `s5d-packaged-check.js` plus `package.sh`: packaged build and dependency hygiene.
  - `s5e-query-variants.js`: restructured §5.4 queries.
  - `s5f-quit-with-busy-worker.js`: shutdown with a busy worker.
  - `smoke-node.js`: the same worker under plain Node.

## Results

### S5.1 Worker in Electron main, and `terminate()`

**Observed.**

- The worker starts in Electron main and sees Electron's Node 24.21.0. The ADR-0004 pragmas read back as intended: `journal_mode=wal`, `synchronous=1`, `foreign_keys=1`, `secure_delete=1`, `auto_vacuum=2`, `busy_timeout=5000`, `temp_store=2`, `user_version=1`.
- The §5.3 schema applies in one `BEGIN IMMEDIATE` transaction in 7 to 19 ms. SQLite is 3.53.4 with FTS5, math functions and `dbstat`.
- **Ordering matters for `auto_vacuum`.** Set before `journal_mode=WAL` it sticks (2). Set after `journal_mode=WAL` on a new file it silently stays 0.

`terminate()` results (final run, 10,000-page database, fresh worker each time):

| Scenario | Runs | Aborts | Exit code | `terminate()` to exit, p50 / p95 |
|---|---|---|---|---|
| Long read, one native statement of about 1.1 to 2 s | 50 (+1 probe) | 0 | 1 (50/50) | 1,437 / 1,996 ms |
| Long write, one native `INSERT ... SELECT` of 3M rows in a transaction | 15 | 0 | 1 | 1,330 / 1,644 ms |
| Long write driven from JS (400k small statements in a transaction) | 15 | 0 | 1 | 4.8 / 8.0 ms |
| Busy loop of short §5.4 queries | 50 | 0 | 1 | 5.6 / 10.4 ms |
| Open `iterate()` cursor over `pages` | 50 | 0 | 1 | 3.8 / 6.5 ms |
| Idle worker with open DB and cached statement | 50 | 0 | 1 | 2.6 / 3.8 ms |

- After all of the above: `PRAGMA quick_check` = ok, the FTS5 `integrity-check` passed, 10,000 pages intact, and a search works. Uncommitted writes were rolled back every time (scratch table always 0 rows).
- better-sqlite3 13.0.3 therefore shows no repeat of the 13.0.0 / 13.0.1 abort in any of these paths. I did not test 13.0.0 / 13.0.1, so I can't say these scenarios reproduce the original bug there.
- **`terminate()` cannot preempt a running SQLite statement.** While a native statement runs, the worker thread only stops after the statement returns; "terminate to exit" is roughly the statement's remaining time. The calling thread is not blocked, because `terminate()` is async. When JS regains control between statements, termination takes about 5 ms.
- **Neither driver has an interrupt API.** better-sqlite3 13.0.3 and `node:sqlite` in Electron 44.7.2 expose neither `interrupt()` nor a progress handler.
- **Shutdown with a busy worker** (`s5f`, 3 runs each, long query 1.77 s uninterrupted, quit called 0.3 s in):

  | Exit style | Ms from quit call to process exit |
  |---|---|
  | `app.quit()` | 1,552 to 2,223 |
  | `app.exit(0)` | 1,666 to 1,737 |
  | `process.exit(0)` | 1,731 to 1,834 |
  | `worker.terminate()` then `app.quit()` | 1,705 to 2,811 |
  | `worker.terminate()` then `app.exit(0)` | 1,881 to 2,676 |
  | `process.kill(process.pid)` (hard exit) | 31 to 182 |
  | `app.quit()` plus a 500 ms `setTimeout` that calls `process.kill(process.pid)` | 1,460 to 2,396 |

  - Every graceful style waited out the rest of the statement (about 1.5 s remained when quit was called).
  - The in-process watchdog timer never ran in time. **Inferred:** the main thread blocks joining the worker during teardown.
  - **Hard kill is safe for the data.** 5 children were killed with `process.kill` in the middle of a 3M-row write transaction (exit in 26 to 135 ms). On reopen: `quick_check` ok, FTS5 `integrity-check` passed, 10,000 pages intact, 0 rows from the interrupted transaction.
- **Main-thread lag** (15 ms timer; a stall shows up as drift). Idle baseline: max 3.1 ms. While the worker ran a 1.09 s query: p95 1.1 ms, one 15 ms tick. The same SQL run directly on main as a control: one stall of 1,489 ms. This is the ADR-0004 rationale, measured.

### S5.2 Insert, size, latency (better-sqlite3 13.0.3, default 16 MB cache, medians of 3)

**Insert and size.** Batches of 1,000 pages with their visits per transaction. FTS5 maintained by the §5.3 triggers. Size is after `wal_checkpoint(TRUNCATE)` (WAL file 0 bytes).

| Pages | Visits | Tabs | Pages/s (min to max) | All rows/s | Insert time | DB size | Bytes/page |
|---|---|---|---|---|---|---|---|
| 1,000 | 2,970 | 300 | 7,645 (6,221 to 9,337) | 29.8k | 143 ms | 1.36 MiB | 1,425 |
| 10,000 | 30,554 | 300 | 5,921 (5,861 to 7,859) | 24.0k | 1.70 s | 8.18 MiB | 858 |
| 50,000 | 151,176 | 300 | 4,242 (3,803 to 4,451) | 17.1k | 11.8 s | 39.84 MiB | 836 |

- **Size breakdown at 50k pages** (`dbstat`, MiB):

  | Component | MiB |
  |---|---|
  | `pages` + its 3 indexes | 18.1 |
  | `visits` + 2 indexes | 10.6 |
  | FTS5 data | 9.2 |
  | FTS5 docsize | 0.56 |
  | 300 `tabs` incl. `restore_state` | 0.43 |
  | everything else (empty tables, schema) | 0.9 |

  - **Excluded:** favicon blobs, content indexing and any user data beyond this schema.
  - FTS is about 24% of the file.
- **FTS trigger cost** (single run, indicative): bulk loading with the three FTS triggers dropped and one `INSERT INTO pages_fts(pages_fts) VALUES('rebuild')` afterwards took 0.60 s + 0.08 s at 10k and 7.1 s + 0.66 s at 50k. The trigger path took 1.7 s and 11.8 s. For bulk import, drop the triggers and rebuild.
- **Write path.** One emulated 1-second flush: 1 new page with FTS insert, 3 visits, 2 page updates, 1 title re-index, 6 tab updates, in one transaction. At 50k: p50 2.0 ms, p95 3.3 ms, p99 26 ms. The p99 is the periodic WAL auto-checkpoint, and a search arriving then waits for it (single worker).

**§5.4 search latency, pooled over the 30 headline queries** (ms; p95 range over the 3 runs in brackets):

| Pages | In-worker p50 / p95 / p99 | Round trip from main p50 / p95 / p99 |
|---|---|---|
| 1,000 | 0.44 / 2.57 [2.06 to 3.93] / 3.51 | 1.28 / 6.42 [2.88 to 10.41] / 11.24 |
| 10,000 | 2.70 / 9.49 [9.37 to 15.47] / 13.02 | 3.92 / 12.56 [11.36 to 14.45] / 23.25 |
| 50,000 | 6.34 / 25.18 [20.28 to 40.03] / 39.61 | 7.28 / 23.44 [22.93 to 36.95] / 29.32 |

- The two columns come from separate loops, so the 50k round-trip p95 sitting below the in-worker p95 is run-to-run noise.
- The messaging and clone cost itself (200 rows) is about 0.6 to 1.1 ms at p50.

By query class at 50k pages (round trip p50 / p95 / p99; in-worker p95 in brackets):

| Class | Round trip p50 / p95 / p99 | In-worker p95 |
|---|---|---|
| One token (`postgres`, `react`, ...) | 8.8 / 18.8 / 27.2 | 20.6 |
| Short prefix (`po`, `re`, `do`, `ku`, `pos`, `typ`) | 19.4 / 29.3 / 49.4 | 34.4 |
| Two tokens | 2.8 / 9.2 / 12.0 | 9.3 |
| Three tokens | 2.0 / 4.2 / 6.0 | 3.7 |

At 10k pages the same classes are: one token 5.2 / 12.0 / 16.6, short prefix 9.2 / 17.8 / 46.9, two tokens 1.6 / 6.7 / 14.9, three tokens 1.2 / 3.8 / 8.3.

- **Cost scales with matches.** `ORDER BY bm25 ... LIMIT 200` must score every match. The §5.4 query costs about 3.5 microseconds per matching row at both 10k and 50k. `re` (12,408 matches) takes 24 ms in-worker, `postgres` (7,573) takes 19 ms. Few-match queries are sub-3 ms.
- **Keystroke ladder** (in-worker p50, 50k pages):

  | Typing | 1 char | 2 chars | Longer |
  |---|---|---|---|
  | `postgres index` | 45.6 ms (23,966 matches) | 20.9 ms | 8 ms at the full phrase |
  | `kubernetes ingress` | 17.5 ms (5,067 matches) | 9.5 ms | 1.2 ms once the second word is complete |

- **Stress queries** (round-trip p50, ms, 50k / 10k):

  | Query | Matches at 50k | 50k | 10k |
  |---|---|---|---|
  | `h` | 50,000 | 79 | 26 |
  | `https` | 50,000 | 70 | 21 |
  | `com` | 23,563 | 39 | 16 |
  | `the` | 1,342 | 6.7 | 5.8 |

  Every page's `url` contains `https`, `www` or `com` tokens, so short prefixes of those match almost everything.
- **Cold first query** after reopening the DB: 58 ms at 50k and 24 ms at 10k (median round trip of the first `postgres` search in a fresh worker), against about 18 ms (50k) and 8 ms (10k) for the same query warm.

**Where the §5.4 time goes** (`s5e`, in-worker, pooled, medians of 3; fresh DB per repetition):

| Variant | 10k p50 / p95 / p99 | 50k p50 / p95 / p99 |
|---|---|---|
| `spec` (§5.4 verbatim) | 2.42 / 9.10 / 15.18 | 6.67 / 25.34 / 41.97 |
| without `highlight()` | 1.25 / 4.50 / 5.51 | 4.09 / 16.54 / 19.67 |
| rank only (MATCH, bm25, ORDER BY, LIMIT 200; no joins) | 0.59 / 2.25 / 2.86 | 1.99 / 8.99 / 10.78 |
| rank 200 in a CTE, then join `pages` / `tabs` | 0.95 / 2.93 / 3.59 | 2.32 / 9.08 / 11.12 |
| same, plus title marking in JS on the 200 rows | 1.27 / 3.30 / 3.98 | 2.94 / 10.93 / 14.02 |

Restructuring cuts the 50k p95 from 25.3 to 10.9 ms and p99 from 42 to 14 ms. The JS marking is an approximation of `highlight()`: it marks words that start with a query token, ignoring tokenizer details such as diacritic folding.

**Page cache matters most** (`s5b`, pooled in-worker p50 / p95 / p99, round-trip p95, 3 runs each):

| Driver and `cache_size` | 10k in-worker | 50k in-worker | 50k round-trip p95 | 50k pages/s |
|---|---|---|---|---|
| better-sqlite3, 2 MB | 2.50 / 12.91 / 16.16 | 16.11 / 52.34 / 61.33 | 47.6 | 3,877 |
| better-sqlite3, 16 MB (this build's default) | 2.70 / 9.49 / 13.02 | 6.34 / 25.18 / 39.61 | 23.4 | 4,242 |
| better-sqlite3, 64 MB | not run | 6.65 / 24.35 / 30.34 | 22.7 | 5,246 |
| `node:sqlite`, default (2 MB) | 3.53 / 14.06 / 19.70 | 15.05 / 59.38 / 82.05 | 65.6 | 3,345 |
| `node:sqlite`, 16 MB | 2.37 / 8.99 / 11.05 | 6.44 / 23.93 / 29.55 | 24.1 | 4,344 |

A 16 MB cache is enough for a 40 MB database. 64 MB adds nothing for search.

**Recent and frequent listing (empty query), 200 rows, in-worker p50 / p95 (round-trip p50 / p95), ms:**

| Variant | 10k | 50k |
|---|---|---|
| `p.frecency * pow(2, -(now - frecency_at) / H)`, full scan and sort | 9.0 / 11.0 (9.9 / 11.7) | 28.6 / 45.3 (31.1 / 34.5) |
| same with `exp(-ln2 * ...)` | 8.2 / 10.0 | 30.7 / 45.1 |
| restricted to `last_visit_at` in the last 60 days | 7.3 / 9.2 | 37.0 / 44.3 |
| expression index on `log2(frecency) + frecency_at / H` | **0.42 / 0.65 (1.45 / 1.74)** | **0.39 / 0.47 (1.18 / 1.31)** |

- `exp`, `pow`, `power`, `ln` and `log2` exist in both drivers (`ENABLE_MATH_FUNCTIONS`).
- Decay at query time works, but it scans every page. The 60-day window does not help with this data, because most pages were visited recently.
- The decayed value orders exactly like `log2(f) + at / H`, since the `now / H` term is common to every row. An expression index therefore serves `ORDER BY ... LIMIT 200` from the index. The 200 rows were identical in order to the `pow` variant in all 3 runs.
- Index build: 11 ms at 10k, 80 ms at 50k. The flush transaction at 50k went from p50 2.0 to 2.5 ms with the index, which is within run noise.

### S5.3 `node:sqlite` in Electron 44.7.2

| Check | Observed |
|---|---|
| `require('node:sqlite')` in main, no flags | Works. Exports `DatabaseSync`, `StatementSync`, `Session`, `constants`, `backup`. `process.execArgv` is empty. |
| Warnings | None emitted in main (a listener was registered before the `require`). Plain Node 24.13 does print an ExperimentalWarning. |
| SQLite | 3.53.4 inside Electron (system Node 24.13 bundles 3.50.4). Same version as better-sqlite3 13.0.3. |
| FTS5 | `unicode61 remove_diacritics 2`, `prefix='2 3'`, `bm25`, `highlight`, `secure-delete` option all work. |
| Math functions | `exp`, `pow`, `power`, `ln`, `log2` work. |
| §5.3 features | `STRICT`, `WITHOUT ROWID`, `json_valid`, `dbstat` all work. The whole schema applied. |
| Inside a worker | Same `db-worker.js`. Pragmas applied, 10k pages loaded, §5.4 query worked, integrity ok. |
| Defaults that differ | `cache_size` -2000 (2 MB) vs -16000; `foreign_keys` defaults ON (the same effective setting as better-sqlite3's build). |
| API gaps for a "drop-in" | No `pragma()` helper, no `transaction()`, no `interrupt()`, no progress handler. `backup` is a top-level function. Use `exec('PRAGMA ...')` and explicit `BEGIN`/`COMMIT`. |
| `terminate()` mid long read | 30 of 30 survived, exit code 1, integrity ok. Same "cannot preempt" behaviour (p50 561 ms to exit). |

Benchmark: the same worker file ran in a worker, not on main. Results are in the cache table above. With `cache_size` equalised, node:sqlite is within noise of better-sqlite3 on search and insert. `node:sqlite` also keeps the same ADR-0004 interface, so it remains a drop-in fallback if the pragma and transaction helpers are done in our own repository layer.

### S5.4 Packaged build (electron-builder 26.17.0 `--dir`, nothing installed)

`app/` has its own `package.json` (`better-sqlite3: 13.0.3`). `npm install --ignore-scripts` ran only inside `app/`: 2 packages (`better-sqlite3`, `node-addon-api`), 4 s. Packaged with:

```bash
cd spikes && ./node_modules/.bin/electron-builder --win --x64 --dir --projectDir s5-data-stack/app \
  -c.electronVersion=44.7.2 -c.npmRebuild=false -c.directories.output=../dist
```

Then the unpacked `s5-packaged-probe.exe` was run directly, 3 times per variant. Variant "slim-fuses" adds a `files` filter and the ADR-0007 fuse set (`builder.slim.yml`).

| Check | default | slim-fuses |
|---|---|---|
| (a) Worker loads from inside `app.asar` and runs | Yes. `workerFilename` = `...\resources\app.asar\worker.js`; exit code 0 (3/3) | Yes |
| Same via `app.getAppPath()` | Yes (informational) | not run |
| (b) `.node` is auto-unpacked and mapped from `app.asar.unpacked` | Yes: `app.asar.unpacked\node_modules\better-sqlite3\prebuilds\win32-x64.node` (in the worker's loaded-module list) | Yes |
| (c) FTS5 `MATCH` + `bm25` + `highlight` | 200 rows, SQLite 3.53.4, WAL, `auto_vacuum`=2 | same |
| Did electron-builder rebuild natives or need compilers | No: `skipped dependencies rebuild reason=npmRebuild is set to false`; no compiler or toolchain invoked | same |
| `app.asar` / `app.asar.unpacked` size | 423 KiB / 26,655 KiB (66 files) | 13 KiB / 1,972 KiB (26 files) |
| Unpacked folder size (`win-unpacked`) | 393 MiB (`exe` 234 MiB) | 369 MiB |
| Wall time of the exe run (start, report, exit) | 839, 777, 820 ms (the first run of the first build after creation took 9.1 s: a cold start of a new exe, possibly antivirus scanning, not investigated) | 685, 793, 825 ms |
| Fuses in the exe | Electron defaults | All 7 ADR-0007 fuses applied and verified with `@electron/fuses`; worker and native module still load |

**Observed warnings and notes.** The full log is the ten `•` lines in `pack.log`:

- `author is missed in the package.json`.
- `default Electron icon is used`.
- `no code signing certificate configured, signing is skipped`.
- No deprecation warnings during packaging.

**Downloads.**

- The log says `downloaded label=electron`, but the Electron 44.7.2 zip was already in `%LOCALAPPDATA%\electron\Cache` (written at 06:21, before this task) and no new file appeared there. No `electron-builder\Cache` folder was created. No winCodeSign or NSIS tools were needed for `--dir`.
- **Inferred:** the packaging itself needed no network access.
- `npm install` in `app/` is the only download I know of.

**Default packaging unpacks the whole module.** The auto-unpack unpacks the entire `better-sqlite3` folder, not just the `.node` file. That includes the `deps/` SQLite amalgamation (`sqlite3.c`, 9.5 MB), `src/`, and all eight platform prebuilds. A `files` filter that drops `deps/`, `src/`, the seven non-`win32-x64` prebuilds and `node-addon-api` cut the unpacked size from 26 MiB to 1.9 MiB, and the app still ran. The filter is `builder.slim.yml`.

**What happens if `npmRebuild` is not disabled** (extra probe in a throw-away copy of `app/`; `pack-rebuild-probe.log`):

- Observed: electron-builder ran `@electron/rebuild`. It logged `preparing moduleName=better-sqlite3` / `finished` and the whole build took 31 s.
- It created `node_modules/better-sqlite3/build/` containing `better_sqlite3.vcxproj`, `binding.sln`, `config.gypi` and similar files. No compiled `.node` was produced.
- The step needs Python and Visual Studio build tools (both present on this machine). It downloaded the Electron 44.7.2 headers into `~/.electron-gyp`, which I deleted afterwards.
- **Inferred:** the compile step is a no-op because `binding.gyp` detects the shipped prebuild. On a machine without Python and Visual Studio the step would likely fail, so keep `npmRebuild: false` (as ADR-0007 already decides).

### S5.5 Dependency hygiene

`npm ls rimraf glob boolean --all` in `spikes/`:

```text
electron-builder@26.17.0
`-- app-builder-lib@26.17.0
    +-- @electron/asar@3.4.1
    |   `-- glob@7.2.3
    +-- @electron/get@3.1.0
    |   `-- global-agent@3.0.0
    |       +-- boolean@3.2.0
    |       `-- roarr@2.15.4 -> boolean@3.2.0 (deduped)
    `-- electron-builder-squirrel-windows@26.17.0
        `-- electron-winstaller@5.4.0
            `-- temp@0.9.4
                `-- rimraf@2.6.3 -> glob@7.2.3 (deduped)
```

| Package | Pulled in by |
|---|---|
| `glob@7.2.3` | `@electron/asar@3.4.1` and (via `rimraf@2.6.3`) `electron-winstaller` |
| `rimraf@2.6.3` | `temp@0.9.4`, from `electron-winstaller@5.4.0`, from `electron-builder-squirrel-windows@26.17.0` |
| `boolean@3.2.0` | `global-agent@3.0.0` (and `roarr@2.15.4`), from `@electron/get@3.1.0` |

All of them are under `app-builder-lib`, a build-time dev dependency. None are in `better-sqlite3`, `electron` or `playwright-core`, and none ship in the app.

## What this means for the design

### ADR-0004 (SQLite in a worker): keep, with amendments

- **Keep** better-sqlite3 13, the worker, WAL, `STRICT`, the FTS5 external-content design and the §5.3 schema unchanged. Everything in the schema worked: triggers, `secure-delete`, `STRICT`, `CHECK`, `json_valid`.
- **Add `PRAGMA cache_size = -16000`** (or larger) to the connection pragmas. This build defaults to 16 MB, but `node:sqlite` defaults to 2 MB and is then 2.5x slower at 50k (p95 59 ms). Setting it explicitly keeps the fallback honest and removes dependence on the build default.
- **State the open order:** `auto_vacuum=INCREMENTAL` before `journal_mode=WAL`. Observed: the reverse silently leaves `auto_vacuum=0`.
- **Treat every statement as unkillable.** `terminate()` waits for the running statement, and graceful quit (even `app.exit`) waits for it too. Observed: a 2 s statement delays process exit by about that much. Neither driver can interrupt. Design rules:
  - every query is bounded (`LIMIT`, candidate caps, no user-supplied SQL);
  - maintenance statements (`integrity-check`, `rebuild`, `VACUUM`) run while idle, in small chunks (`incremental_vacuum(N)`) or on a second connection and worker (additive, §5.5);
  - the §5.5 shutdown cap must be enforced while the event loop is alive: `before-quit` awaits the worker's flush and `close` with a 3 s cap, and if the worker has not finished, calls `process.kill(process.pid)` before asking to quit. Observed: that exit took 27 to 164 ms, a timer scheduled after `app.quit()` never fired in time, and a hard kill left the database healthy (5 kills mid-write, then `quick_check` and FTS5 integrity-check ok, observed).
- **Revise §5.4 for performance** (not for meaning). Rank and `LIMIT 200` in a CTE first, then join `pages` and `tabs` for those 200 rows, and compute the title markers in shared JS. Observed 50k p95 25.3 to 10.9 ms and p99 42 to 14 ms. If the `highlight()` column stays in SQL, it is about 35 to 40% of the cost. The ranking function stays as specified.
- **Handle short prefixes explicitly.** One-character queries match up to every page and cost 17 to 79 ms. Either require 2 or more characters for FTS (show recent and frequent for 0 to 1) or accept those latencies. Separately, the indexed `url` text contains `https`, `www` and the TLD for every row. **Inferred, not tested:** indexing the URL without scheme and `www.` removes the worst `ht` / `ww` / `co` cases. Add such queries to the Part 9 golden set.
- **Use an expression index for the empty-query listing**: `CREATE INDEX ON pages((log2(frecency) + frecency_at / H))` with `H` as a literal. Observed 0.4 ms against 29 to 45 ms for the scan at 50k, with identical order. It needs a migration, and a change to `H` means a re-index.
- **Import:** for bulk import or rebuilds, drop the three FTS triggers, load, then `'rebuild'` (about 1.5x faster at 50k and 2.5x at 10k, single runs).

### §5.4 performance targets: keep the p95 numbers, add p99 and a floor

| Target | Original | Observed (§5.4 as written, synthetic dense data, indicative) |
|---|---|---|
| End-to-end p95, 10k pages | ≤ 30 ms | 12.6 ms (range 11.4 to 14.5) |
| End-to-end p95, 50k pages | ≤ 50 ms | 23.4 ms (range 22.9 to 37.0) |
| End-to-end p99, 50k pages | none | 29.3 ms (range 27.6 to 56.0) |

- **Proposed:** keep both p95 targets. They hold with roughly 2x headroom on a low-end i3 laptop under load.
- **Add** p99 ≤ 60 ms at 50k and a minimum query length of 2 characters. Add a cold first-query bound of ≤ 100 ms (observed 58 ms at 50k). Warm the cache with one idle search after open (inferred).
- **With the restructured query**, the in-worker p95 at 50k is about 11 ms. Tightening p95 to ≤ 25 ms at 50k looks reachable (inferred). Decide at the Phase 4 benchmarks with real history data.
- **Not covered.** These numbers exclude renderer IPC and the keystroke debounce.

### ADR-0007 (build and packaging): keep, with small additions

- Observed: `npmRebuild: false` plus `--ignore-scripts` yields a working package with no compiler. Native modules unpack automatically, the worker loads from `app.asar`, and the full ADR-0007 fuse set (including `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`) works with a worker in the asar and the `.node` file in `app.asar.unpacked`.
- **Add a `files` filter** for better-sqlite3 (`!deps`, `!src`, other-platform prebuilds) and `node-addon-api`. It saves about 24 MiB unpacked. Re-check on each better-sqlite3 upgrade, because file layouts change.
- Optional polish: set `author` and an icon to silence the two electron-builder notices.

## Caveats and follow-ups

- **Synthetic data.** Real histories have more unique tokens (tracking IDs, long query strings) and less topic skew, which would make typical queries faster, but they also contain URL tokens like `https` / `com` shared by every row. Re-run the benchmark on a real exported history in Phase 4.
- **Noisy environment.** An i3-1215U with 7.7 GB RAM, other Electron spikes running at the same time. The 50k p95 ranged 20 to 40 ms across repetitions of the same code. Treat the medians as ±30%.
- **Not measured.**
  - Concurrent writes and searches (a single worker serializes them; a flush's p99 of about 26 ms is the likely worst-case wait).
  - FTS5 `optimize` and merge behaviour after heavy deletes.
  - The cost of `secure_delete` on large deletions, and `incremental_vacuum`.
  - The online backup API.
  - `wal_checkpoint` under reader pressure.
  - Power-loss durability (a `process.kill` mid-write was tested and is clean, but a power cut can also lose OS-cached WAL pages; `synchronous=NORMAL` accepts losing the last transactions, per §5.5).
  - Favicon blobs in size estimates.
  - Round trip main to renderer.
  - A packaged `terminate()` run.
- **The 9.1 s first launch.** The first run after packaging took 9.1 s against about 0.8 s afterwards. Probably a one-off Windows scan of a new 234 MB exe; it matters for E2E test timeouts and for CI first-run budgets, but I did not investigate.
- **Disk.** `dist/` (default and slim builds, 763 MB) and the `app/node_modules` folder are gitignored and left in place for inspection; `package.sh` regenerates them.
- **Housekeeping for the caller.** `docs/spikes/README.md` still lists S5 as "In progress".

## How to reproduce

From `C:\GitHub\Veltriva\spikes` (Git Bash; the Electron scripts call `h.prepareApp` and exit themselves):

```bash
# S5.1 worker in Electron main + terminate x50 + main-thread lag (about 2.5 min)
timeout 300 ./node_modules/.bin/electron s5-data-stack/s5a-worker-terminate.js
# S5.1 shutdown with a busy worker
timeout 300 ./node_modules/.bin/electron s5-data-stack/s5f-quit-with-busy-worker.js

# S5.2 better-sqlite3 benchmark (1k/10k/50k x3 plus FTS-trigger experiment; about 6 min)
S5_EXTRAS=1 ./node_modules/.bin/electron s5-data-stack/s5b-bench.js
# S5.2 query-structure experiment
./node_modules/.bin/electron s5-data-stack/s5e-query-variants.js

# S5.3 node:sqlite probe and benchmark (default cache, then cache matched), plus cache ablation for better-sqlite3
./node_modules/.bin/electron s5-data-stack/s5c-node-sqlite-probe.js
S5_DRIVER=node:sqlite S5_SCALES=10000,50000 ./node_modules/.bin/electron s5-data-stack/s5b-bench.js
S5_DRIVER=node:sqlite S5_CACHE_KB=16000 S5_TAG=cache16m S5_SCALES=10000,50000 ./node_modules/.bin/electron s5-data-stack/s5b-bench.js
S5_CACHE_KB=2000  S5_TAG=cache2m  S5_SCALES=10000,50000 ./node_modules/.bin/electron s5-data-stack/s5b-bench.js
S5_CACHE_KB=65536 S5_TAG=cache64m S5_SCALES=50000       ./node_modules/.bin/electron s5-data-stack/s5b-bench.js

# S5.4 / S5.5 package (installs only inside app/), then check and run the unpacked exe
bash s5-data-stack/package.sh            # add S5_REBUILD_PROBE=1 for the "rebuild left on" experiment
./node_modules/.bin/electron s5-data-stack/s5d-packaged-check.js

# Worker under plain Node (no Electron)
node s5-data-stack/smoke-node.js better-sqlite3 10000
```

Results land in `spikes/s5-data-stack/results/*.json`. Database files (`*.db`), `dist/`, `user-data/` and `*.log` are gitignored.
