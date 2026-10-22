# Phase 3 memory measurement (assessment §9.3)

**Status: not yet measured to the protocol.** The harness is built and checked, but on 2026-10-22 the reference laptop was too loaded for a clean run: every attempt at the 10-tab size failed inside its first measured run, under heavy paging. This page says what was built, what was attempted, and the only readings that finished, labelled for what they are. **None of them is the §9.3 result**, and nothing here is estimated. The protocol run is `npm run bench:memory` on a quiet machine; its raw files go to `data/`, and `tests/benchmarks/summarize-memory.mjs` turns them into the tables this page will then hold.

## The method, as built

The method is §9.3's and spike S8's (`docs/spikes/s8-measurement-method.md`):

- **Headline metric:** the sum of **private bytes** over the app's whole process tree, read with `app.getAppMetrics()`. S8 showed it matches Windows' own counters exactly for every process and misses none. It is grouped as browser, GPU, utility, the shell's renderer, and the tabs' renderers.
- **Secondary:** working set (counts shared pages once per process, so it overstates), CPU averaged over a 60 s quiet window per phase, tab-switch latency to a live hidden tab and to an unloaded one (which reloads), and the time to load and to unload all tabs.
- **Corpus:** §9.3's first part only, synthetic pages of controlled cost: S8's page, 10 MB of JavaScript heap and about 100 KB of DOM (`/cost/page` on the test fixture server), each tab on a site of its own (`m<i>.test`, mapped to the fixture server with `--host-resolver-rules`), so each gets its own renderer as real sites do. The openly licensed real-page corpus and the dynamic sites belong to Phase 6's report.
- **Scenarios:** 10, 25 and 50 tabs (100 doesn't fit in this laptop's 7.9 GB), each in §9.3's three modes, in one launch:
  - **A, all live:** every tab loaded, the last selected, automation paused;
  - **B, visually collapsed:** all but the selected tab moved to Sleeping by the user's command, still loaded;
  - **C, unloaded:** those tabs discarded, as automation would.
- **Protocol:** a fresh launch on a fresh profile per run, one warm-up run per size (discarded), then 5 measured runs; the median and the range are reported. Each phase settles 10 s first. The scenario is the only caller of `getAppMetrics()` while it runs (each call resets the CPU interval, §9.3).
- **Harness:** the `memory-benchmark` scenario (`src/main/testing/benchmark-scenarios.ts`, test builds only) runs inside the app with no Playwright, inspector or CDP attached, through the lifecycle harness (ADR-0008 4a); `tests/benchmarks/memory.bench.ts` runs it per size and run, records the machine (CPU, memory, Windows build, power, Defender) and the free memory at each run's start, and saves every run's raw reading, or its error, as JSON and CSV after each run.

## What happened on 2026-10-22

**Machine:** Intel Core i3-1215U (8 logical CPUs), 7,916 MB RAM, Windows 11 Home Single Language 10.0.26200, on AC power, Balanced power plan, Defender real-time protection on. Not idle: the user's other projects were running (an n8n server, a Next.js dev server, a Tauri Android build, several Claude windows, TradingView). Free memory was 93–690 MB during the day, and at the third attempt the commit charge stood at 28.1 of 31.7 GB.

| Attempt | Runner | What happened |
|---|---|---|
| 1 | first version | The 10-tab warm-up finished. Run 1 stopped when a page didn't answer the discard's probe within its 100 ms budget (`probe-unanswered`), which automation retries at its next evaluation. Free at start: 187 MB. |
| 2 | probes asked again, up to 4 times, as automation would | The 10-tab warm-up finished. In run 1 a tab took over 60 s to show its page, and the app then hung on its way out; the harness killed it after 640 s. Free at start: 268 MB. |
| 3 | each run saved; 180 s per load, a switch over 120 s recorded rather than failing | The 10-tab warm-up itself didn't finish within 980 s, and the harness killed it. Free at start: 187 MB; 93 MB when it was stopped. |

The attempts were stopped there: on a machine paging this hard, private bytes would still count correctly, but working set, CPU and latency would measure the paging, and the runs could not finish anyway. Verbatim output is in [data/phase-3-memory-2026-10-22-attempts.txt](data/phase-3-memory-2026-10-22-attempts.txt) and [data/phase-3-memory-2026-10-22-attempt-3-10-tabs.json](data/phase-3-memory-2026-10-22-attempt-3-10-tabs.json).

## The readings that finished

These were measured, but none is a result under the protocol: warm-ups are discarded by definition, and the harness check ran with a 2 s settle and a 3 s CPU window. They show the direction and the size of the effect on this laptop, nothing more.

| Reading | Conditions | A: all live | B: Sleeping, live | C: unloaded | A − C |
|---|---|---|---|---|---|
| 10-tab warm-up, attempt 1 | settle 10 s, CPU 60 s, 187 MB free | 613.8 MB | 629.8 MB | 306.6 MB | 307.2 MB |
| 10-tab warm-up, attempt 2 | settle 10 s, CPU 60 s, 268 MB free | 609.1 MB | 622.8 MB | 302.2 MB | 306.9 MB |
| 3-tab harness check, run 1 | settle 2 s, CPU 3 s, 690 MB free | 406.8 MB | 424.0 MB | 325.4 MB | 81.4 MB |

All are total private bytes of the process tree. In the harness check ([data](data/phase-3-memory-2026-10-22-harness-check-3-tabs.json)), a tab's renderer held 42.2 MB private in A, unloading 2 tabs freed 40.7 MB each, moving tabs to Sleeping alone freed nothing (B was 17.2 MB above A), and a switch took 51.5 ms to a live tab and 252.2 ms to an unloaded one, which reloads. The 10-tab warm-ups say the same at a larger size: unloading 9 tabs freed about 307 MB, about 34 MB each, and B was 14–16 MB above A.

For comparison, spike S8 measured the same page on the same laptop with its own harness, 5 runs: 20 live tabs 886 MB private (881–893), 1 live and 19 discarded 124 MB (122–127), so 762 MB freed (756–767), about 40 MB per tab.

## To complete it

On a quiet machine (close other apps; free memory well above 2 GB for the 50-tab size):

```bash
npm run bench:memory
node tests/benchmarks/summarize-memory.mjs docs/benchmarks/data/phase-3-memory-<date>-10-25-50.json.gz
```

The raw data is written gzipped (since Phase 4); the summarizer reads it, and the plain `.json` of the attempts above, alike.

Sizes can be run one at a time (`BENCH_SIZES=10`, `BENCH_SIZES=25`, `BENCH_SIZES=50`; the summarizer takes several files). The tables it prints replace the sections above, with the machine and the free memory of each run.
