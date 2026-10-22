# Phase 4 plan: searchable memory

Pre-approved by the user on 2026-10-22, with Phases 2–6 ("make commits and merge when done … finish all phases"). The orchestrator reviews each milestone, re-runs the checks, scans with Veyra and merges. The user runs the manual checks once all phases are done.

**Sources of truth:**
- ADR-0001: Electron and its upgrade policy.
- ADR-0004: persistence and the data worker.
- ADR-0005: main is authoritative, Zod IPC.
- ADR-0006: overlays above a page, option A′.
- ADR-0008: testing.
- The technical assessment:
  - §5.3–§5.4: the schema, search and ranking, and the latency targets;
  - §7.3: the UI concept, the palette and accessibility;
  - §8.2: the Phase 4 acceptance.
- Spikes S4 (the overlay strategy) and S5 (the data stack and its search measurements).

**Working rules:**
- One stacked branch per step, each started from the previous one's tip.
- Commits with Veyra (`--assisted-by`), never pushed or merged by the implementer.
- **Who wrote what:**
  - Subagents (Sonnet 5.5, Haiku 5.5 for the mechanical port) wrote the unit tests of the search core, the dataset generator and the shell UI of M4.2, under review.
  - The query builder, the data RPC, the ranking, main's commands, the contract and the overlay plumbing were written in the Phase 3–4 session.

**Status: done.** Step 0, M4.1 and M4.2 meet the acceptance below. Step 0 and M4.1 are merged into main (416d309). M4.2 and this wrap-up are on `claude/m4.2-palette`.

## The milestones as planned

- **Step 0: Electron 45.** Move to the newest 45.x within ADR-0001's 4 weeks (45.0.0 went stable on 2026-10-21, so the deadline was 2026-11-18).
  - Read the 44→45 changes for every API Veltriva uses.
  - Pin exactly, check the zip against `SHASUMS256.txt`, prove the better-sqlite3 binary still loads, and run every check.
- **M4.1: search engine.**
  - **Querying and ranking:**
    - the FTS5 query builder, safe against operator syntax, with short input going to the recent-and-frequent list;
    - the `search.query` data RPC: rank first, bm25 10/3/5 `LIMIT 200`, then join pages and tabs, without closed tabs;
    - the ranking re-scorer, with a score breakdown on every result;
    - title marks as ranges.
  - **Evidence:**
    - a golden query set;
    - a seeded synthetic dataset generator (1k/10k/50k) outside the production bundle;
    - benchmarks against §5.4's targets, end to end through the RPC, median of 3 runs, real numbers only.
- **M4.2: the palette.**
  - **The Ctrl+Shift+K palette** as an A′ overlay:
    - keyboard navigation;
    - filters on Tab: All, Open, Sleeping, Archived, Today, plus site and time;
    - Enter to switch to or restore, Ctrl+Enter for a new tab;
    - ARIA listbox and options, focus rings, reduced motion;
    - lifecycle check 4a extended to it.
  - **The address bar:** memory suggestions and switch-to-tab, local only, with a test that fails on any network request while typing.
  - **The Archive list:** virtualized, smooth at 10k.
  - **The acceptance E2E:** archive → search by partial words → restore.
- **Wrap-up:** this record, the manual checks, the README.

## As built

Each milestone's full report (features, decisions, tests run, limitations) is in the orchestrator's shared notes. ADR-0001 (the 45.0.0 pin note), ADR-0002 item 9, ADR-0004 item 12, ADR-0005 item 13, ADR-0006 (M4.2) and ADR-0008 item 4 record the design as built.

| Step | Branch, tip | Result |
|---|---|---|
| Step 0 | `claude/electron-45`, d316a88 | Electron 45.0.0 (Chromium 156, Node 24.22, ABI 150); the zip checked; the one breakage was a test-harness artifact, fixed |
| M4.1 | `claude/m4.1-search`, 416d309 | The query builder, `search.query`, ranking v1, tab↔page links, the golden set, the generator and the benchmark: every §5.4 target met |
| M4.2 | `claude/m4.2-palette`, 1e69bd5 (code; this wrap-up follows it) | The palette, the address bar's memory with switch-to-tab, the windowed Archive list, `memory.*`/`overlay.*`/`archive.list` in the contract, restoring any archived tab |

### Deviations from the plan

- **Step 0: the find spec, not the app.** On Electron 45, attaching Playwright to a page clears its selection, which failed a find test 3 of 3 times. Read from main, the app had kept the selection. The spec now reads it from main (ADR-0008 item 4).
- **Step 0: installed in a second worktree.** The Claude desktop app's process held two `.asar` files of the worktree open, so `npm install` failed there with EBUSY. The upgrade was installed and E2E-tested in a temporary worktree, and the verified `electron` package was copied back, leaving out the one locked file. Packaging went to another folder, and `check-packaged-app.mjs` now takes that folder.
- **M4.1: bm25 is divided by the best candidate's,** not stretched over the candidates' range as first written. Stretching turned a rounding difference into a whole point, which outweighed every state boost.
- **M4.1: tabs needed to know their pages.** `tabs.page_id` had never been filled, so the state boost had nothing to read. The data worker now links each saved tab to the page its address is keyed by, and idle maintenance links older rows. Retention keeps a page that a non-closed tab shows, so an archived tab stays findable after its visits expire; before, such a page went.
- **M4.1: re-ranking cost found and fixed.** A profile showed re-scoring 200 candidates took 17–35 ms, from folding titles character by character with normalization and regular expressions. Folding ASCII without them, and marking only the returned results, brought it to 4–6 ms.
- **M4.1: the first query is measured on a settled app.** The first search sent the moment the database is ready takes 134–222 ms at every size, because it waits for startup's own work. Five seconds later, with the index still cold, it takes 13–25 ms. Both are reported. §5.4's target (≤ 100 ms) is judged on the second, which is what spike S5 measured and when a person first opens the palette.
- **M4.2: the score view is Alt+S.** Alt+D stays the address bar's, as in Chrome.
- **M4.2: suggestions only for a text search.** The address bar's suggestions open only for a word of 2 characters or more. Shorter input gives the recent list, which has nothing to do with what was typed.
- **M4.2: Esc takes two presses in the address bar.** The first closes the suggestions and keeps the text; the second reverts the field, as before.
- **M4.2: every archived tab can be restored.** `tabs.restore` and the palette reach archived tabs that only the database holds (memory keeps the newest 200), by taking them into memory first.
- **Benchmarks: raw data is gzipped.** At the orchestrator's request, raw benchmark data is now one gzipped file per run set; the summarizers read both forms.

### Phase 4 acceptance (assessment §8.2)

| Criterion | Evidence | Proved by |
|---|---|---|
| **Latency targets met, or revised with evidence** | Met, every one. End to end through the RPC inside the app, median of 3 runs, on the reference laptop under load (591–830 MB free):<br>• 10k pages: p95 4.3 ms (target ≤ 30).<br>• 50k pages: p95 10.3 ms (≤ 50), p99 12.8 ms (≤ 60), and the first search on a cold index 25 ms (≤ 100).<br>A first search during startup takes 134–222 ms, reported with its cause. Tightening the 50k p95 to 25 ms is supported, but not adopted. | `tests/benchmarks/search.bench.ts` (`npm run bench:search`); [docs/benchmarks/search.md](../benchmarks/search.md) |
| **E2E: archive → search by partial words → restore** | A tab on a fixture page is archived and the palette is opened with Ctrl+Shift+K. Typing a few partial words of its title finds it as Archived, with the typed parts marked; Enter brings it back to the strip, selected, on its page, and closes the palette. | `tests/e2e/memory.spec.ts`: "a tab the user archived is found by a few partial words of its title, and Enter brings it back" |
| **Golden-set ranking tests pass** | 20 pages and 30 expectations: queries a person would type, and what should come first. They include the open documentation above an old forum answer, a site's own word, typing a word letter by letter, the Archived and Today filters, and a breakdown that adds up. One records a limit: "electron 45" doesn't find "v45.0.0". | `src/data/repos/search-golden.test.ts`, in the unit suite |

**The other gates.** Step 0's and M4.1's are in ADR-0001, `docs/benchmarks/search.md` and their reports. M4.2's ran on cd52ca3, the code tip with the UI, and on 1e69bd5, which only updates a stale spec:
- **Static checks:** typecheck, lint and format are all clean.
- **Unit tests:** 8,120 of 8,120 (128 files). The 161 tests new since M4.1 cover:
  - the site filter;
  - main's memory commands;
  - taking an archived tab from the database into memory;
  - the new data methods and contract;
  - the palette's, the suggestions' and the virtual list's pure helpers.
- **Full E2E:** 437 of 438 in 28.5 min. The one failure was the spec that still called Ctrl+Shift+K "reserved, does nothing yet"; it now opens the palette, and that spec then passed 17 of 17. The 10 tests of `memory.spec.ts` passed, among them:
  - the acceptance test;
  - the page staying `visible` under the palette;
  - no request leaving the app while typing;
  - 10,000 archived tabs with at most 60 rows in the DOM.
- **Lifecycle harness:** 13 of 13, with the new palette check: the page under it stays `visible` and unthrottled.
- **Packaging:** the production build check, the data isolation check, packaging and the packaged-app check were all clean. The build went into another folder, because `release/` was still held open.
- **A packaged launch on an existing schema-2 database:** the window appeared in 3.3 s, the app exited with code 0, and the run was recorded as clean. Afterwards the database was still at schema 2, `quick_check` was ok, and each tab was linked to its page.

## What only a person can check

The checklist is [docs/testing/phase-4-manual-checks.md](../testing/phase-4-manual-checks.md). It covers:
- Electron 45 on real sites;
- the palette and the address bar on your own history;
- a screen reader;
- the Archive list after real use;
- the packaged build;
- the search benchmark on a quiet machine.
