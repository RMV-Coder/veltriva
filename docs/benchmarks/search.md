# Phase 4 search latency (assessment §5.4)

**Status: measured, every §5.4 target met.** Each figure is a median of 3 runs, end to end through the app's own RPC, on the reference laptop (2026-10-23):
- **10,000 pages:** p95 4.3 ms, against a target of ≤ 30 ms.
- **50,000 pages:** p95 10.3 ms (≤ 50 ms), p99 12.8 ms (≤ 60 ms), and the first search on a cold index 25 ms (≤ 100 ms).

One caveat is reported, not hidden: a search fired while the app is still starting took 134–222 ms, because it waits for main's startup work. The details and the raw data follow. Nothing here is estimated.

## The method

- **What is timed:** one sample is one `search.query`, as the palette will make it.
  - Main calls the data client with the user's words.
  - The data worker validates the input, runs FTS5 retrieval (bm25 with weights 10, 3, 5, `LIMIT 200`), joins pages and tabs, re-ranks and marks titles, and returns the best 50.
  - Main validates every result with the contract's Zod schema.
  - The time is main's `performance.now()` around the whole call (`src/main/testing/search-benchmark.ts`).
- **Where:** inside the built test app (Electron 45.0.0, Chromium 156), started by `tests/benchmarks/search.bench.ts` with no Playwright, inspector or CDP attached (ADR-0008 4a). Automation is paused for the run, so nothing else writes.
- **Data:** the synthetic memory of `src/data/testing/search-dataset.ts`, spike S5's generator ported (seed 20261016).
  - **Sizes:** 1,000, 10,000 and 50,000 pages, about 3 visits per page, 300 tabs (Sleeping, Archived and closed; none open, so that no real site loads).
  - **Keys and frecency:** computed by the app's own code.
  - **A deliberately heavy topic skew:** `postgres` matches 15% of the pages.
  - **Seeding:** each size is seeded into a database once, and each run copies it into a fresh profile.
- **Queries:** S5's set, so the numbers compare with S5's.
  - **Headline:** 30 queries in four classes: 10 one-word, 6 short prefixes such as `po`, 8 two-word, 6 three-word.
    - 2 warm-up passes, then 20 interleaved passes: 600 samples per run.
  - **Ladders:** every keystroke of `kubernetes ingress` and `postgres index`, 5 passes.
  - **Stress:** `h`, `https`, `com` and `the`, which match nearly every page, 5 passes. Reported apart.
  - **Recent:** the empty query, the recent-and-frequent list, 50 samples.
  - **First search:** one `postgres` search before any other, on an index nothing has touched since the app started.
- **Protocol:** 3 runs per size, each a fresh launch. Percentiles are nearest-rank over a run's samples, then the median over the 3 runs, as §5.4 asks. `tests/benchmarks/summarize-search.mjs` makes the tables from the raw files; nothing else feeds them.

## The machine, and how loaded it was

- **The laptop:** Intel Core i3-1215U (8 logical CPUs), 7,916 MB RAM, Windows 11 Home Single Language 10.0.26200, on AC power, Balanced plan, Defender real-time protection on.
- **The load:** not idle. The user's other projects were running: an n8n server, a Next.js dev server, a Tauri Android build, and several Claude sessions.
  - **At each run's start:** 591–830 MB free, a commit charge of 26.0–26.2 of 31.7 GB, and processor load 11–37%. The first run's runs had 440–764 MB free and 12–63% load.
  - **What that means for the numbers:** they are what this laptop gives under that load, not a quiet-machine best case.

## Results: first search on a settled app (the §5.4 measurement)

Raw data: [data/phase-4-search-2026-10-22-1000-10000-50000-first-after-5000ms.json](data/phase-4-search-2026-10-22-1000-10000-50000-first-after-5000ms.json). The first search came 5 s after the worker was ready: the app had settled, and nothing had touched the search index yet.

| Pages | First search | Headline p50 / p95 / p99 | p95 range over runs | Ladders p95 | Recent p50 / p95 | Stress p50 |
|---|---|---|---|---|---|---|
| 1,000 | 13.3 ms | 1.2 / 2.6 / 3.2 ms | 2.6–2.7 | 2.6 ms | 1.3 / 1.6 ms | 2.4 ms |
| 10,000 | 17.5 ms | 2.4 / 4.3 / 5.0 ms | 4.2–4.4 | 3.8 ms | 1.2 / 1.7 ms | 3.3 ms |
| 50,000 | 25.0 ms | 3.9 / 10.3 / 12.8 ms | 10.1–11.6 | 10.1 ms | 1.3 / 1.9 ms | 4.8 ms |

**p95 by query class, at 50,000 pages:**
- one word 8.7 ms;
- short prefix 12.8 ms;
- two words 5.7 ms;
- three words 4.0 ms.

Cost follows the number of matches, as S5 found. The slowest headline queries are the two-letter prefixes `do`, `re` and `po`, at 10–18 ms p95.

**§5.4's targets:**

| Target | Measured (median of 3 runs) | |
|---|---|---|
| p95 at 10,000 pages ≤ 30 ms | 4.3 ms | met |
| p95 at 50,000 pages ≤ 50 ms | 10.3 ms | met |
| p99 at 50,000 pages ≤ 60 ms | 12.8 ms | met |
| First query ≤ 100 ms (50,000 pages) | 25.0 ms (runs: 40.6, 25.0, 19.6) | met |

**Stress queries:**
- **One letter:** `h` gets the recent-and-frequent list, by §5.4's 2-character rule, in about 2 ms.
- **`https`:** every page's address holds it, and it took 33–72 ms at 50,000 pages.
- **`com`:** 15–31 ms.
- **`the`:** 3–15 ms.

## Results: first search inside startup

Raw data: [data/phase-4-search-2026-10-22-1000-10000-50000-first-at-ready.json](data/phase-4-search-2026-10-22-1000-10000-50000-first-at-ready.json). This was the first full run, at the same commit except that the harness had no delay yet: the first search went out the moment the worker reported ready.

| Pages | First search | Headline p50 / p95 / p99 |
|---|---|---|
| 1,000 | 219.4 ms (174.5–305.5) | 2.0 / 5.1 / 7.1 ms |
| 10,000 | 198.9 ms (150.6–209.9) | 2.6 / 6.8 / 8.8 ms |
| 50,000 | 144.5 ms (134.1–222.4) | 3.0 / 8.7 / 11.9 ms |

**What this shows:**
- **The first search is just as slow at 1,000 pages as at 50,000, so it isn't the index.** At that moment main is still restoring the session and loading the shell, and the worker is answering startup's own calls. The search waits its turn.
- **Measured inside the worker, the same first search takes 10–11 ms**, preparing its statement included (34–38 ms before the ranking fix; a Node profile of the handler, below).
- **Five seconds later it is 13–25 ms**, cold index and all.
- **When it matters:** only to someone who presses Ctrl+Shift+K within a second or two of launch.
- **A possible follow-up:** prepare the search statement and warm the index once startup is idle. It isn't needed for the target.

## What profiling changed, before these runs

The first harness check (1,000 pages, one run, before the fix) gave a headline p95 of 17.6 ms. That was too slow for so small a memory, so I profiled the handler under Node on 10,000 pages. These are development measurements inside the worker, not part of the protocol:
- **Before the fix:** SQL took 2–8 ms, but re-scoring 200 candidates took 17–35 ms. Folding the titles was the cost: Unicode normalization and three regular expressions per character, twice per title, for all 200.
- **The fix:** ASCII characters fold without either, the exact-title check folds each title once, and only the 50 results returned are marked.
- **After the fix:** re-scoring took 3.6–6 ms, and the whole handler 2–7.5 ms. Every result is unchanged: 1,197 search and data tests passed.

## Compared with spike S5

S5 ran the same generator and queries, but measured the round trip of a bare worker in a script. Its 50,000-page figures (median of 3 runs):
- **p95 / p99:** 23.4 / 29.3 ms with §5.4's query as first written, about 11 / 14 ms in-worker once restructured to rank first.
- **Cold first query:** 58 ms.

M4.1's p95 of 10.3 ms and p99 of 12.8 ms include more work than either: ranking v1, title marks, the tab join and Zod on both sides. They land where S5's restructured query did.

## For the targets

The evidence supports tightening the 50,000-page p95 target to 25 ms, as §5.4 foresaw: the measured 10.3 ms leaves 2.4× headroom on a loaded machine. Nothing is changed here; §5.4 still says 50 ms until that is decided.

## To run it again

```bash
npm run bench:search
node tests/benchmarks/summarize-search.mjs docs/benchmarks/data/phase-4-search-<date>-1000-10000-50000-first-after-5000ms.json
```

- **One size at a time:** `BENCH_SIZES=50000`.
- **Fewer runs:** `BENCH_RUNS=1`.
- **The startup case:** `BENCH_FIRST_DELAY_MS=0` measures the first search inside startup.
