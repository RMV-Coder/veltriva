# S8: Memory measurement method

| | |
|---|---|
| **Question** | Which memory numbers can Veltriva's benchmarks trust (assessment §9.3), and how repeatable are they? |
| **Status** | Done |
| **Result** | **Confirmed.** Use the sum of **private bytes** from `app.getAppMetrics()`. It matches Windows' own counters exactly, covers the whole process tree, and varied by only 0.5–1.3% across five fresh launches. Working set is unsuitable as the headline number: about 2.3× private memory and 9% run-to-run variation |
| **Environment** | Windows 11 10.0.26200, Electron 44.7.2 (Chromium 152), Node 24.13, Intel Core i3 laptop |
| **Code** | [spikes/s8-measurement](../../spikes/s8-measurement) |

## What we tested

- **Five fresh Electron launches** (`run.js`), each with an always-on-top 900×600 window.
- **Three phases per launch:**
  1. Empty window, no tabs.
  2. **20 live tabs** loading `/page?heapMB=10&domKB=100` on 20 distinct sites (`m0.test`–`m19.test`), one attached and 19 detached, then a 10 s settle.
  3. **19 of them discarded** (`removeChildView` + `close()`), then a 10 s settle.
- **Two sources per phase:**
  - Electron's `app.getAppMetrics()`.
  - Windows' own counters (`Win32_Process.PrivatePageCount` and `WorkingSetSize`) for every process in our process tree, found by walking parent IDs from the main process.

  The PowerShell process doing the measuring is excluded. The first functional run showed it would otherwise count itself.

## Results

Median (minimum–maximum) over 5 launches, in MB; CV is the coefficient of variation.

| Phase | Private bytes, `getAppMetrics` | Private bytes, Windows tree | CV | Working set (both sources) | CV |
|---|---|---|---|---|---|
| Empty window | 62 (62–63) | 62 (62–63) | 0.6% | — | — |
| 20 live tabs | **886** (881–893) | 886 (881–893) | 0.5% | 2,004 (1,612–2,087) | 8.9% |
| 1 live + 19 discarded | **124** (122–127) | 124 (122–127) | 1.3% | 332 (330–334) | 0.4% |
| **Freed by discarding 19 tabs** | **762** (756–767) | — | 0.5% | — | — |

| Check | Observed | Verdict |
|---|---|---|
| Same processes, two sources | Private and working set identical in every phase of every run (for example 881/881, 891/891 MB) | Confirmed: either source |
| Processes missing from `getAppMetrics()` | None in any run, once the measuring PowerShell is excluded | Confirmed: complete on Windows |
| Breakdown, empty | Browser 33, GPU 18, Utility (network) 12 MB | Electron's fixed baseline, before any shell UI |
| Breakdown, 20 live | Browser 53, GPU 19, Utility 14, **20 renderers 795 MB** (about 40 MB each) | Info |
| Breakdown, 19 discarded | Browser 50, GPU 19, Utility 13, 1 renderer 42 MB | Renderer memory is what discards free |

## What this means for the design

- **Headline metric: total private bytes of the process tree**, read with `app.getAppMetrics()`, broken down by process type (assessment §9.3). It's exact, complete and repeatable, and needs no external tooling inside the app.
- **Report working set only as a secondary number, with a caveat.** It counts shared pages once per process, so summing it overstates the total about 2.3×. It's also the noisiest number.
- **Cross-browser comparisons use the Windows counters**, because they apply to any browser's process tree. S8 shows they agree exactly with Electron's for Veltriva.
- **Expected savings:** about 40 MB per discarded tab for these light fixtures. Real sites will differ, which is why Phase 6 also measures openly licensed real pages.
- **Baseline to disclose:** about 62 MB of private memory before any tab, plus the shell UI renderer. Based on the S4 overlay view, that's likely about 25 MB more (inferred).
- **Benchmark harness hygiene:** run measurement tools outside the process tree, or exclude them, as here. Make one service the only caller of `getAppMetrics()`, because it resets the CPU interval for every caller.

## Caveats and follow-ups

- One machine, with synthetic pages of controlled cost. Not measured: CPU, GPU memory accounting, Windows memory compression, or behavior under real memory pressure.
- Tested at 20 tabs; the 10/25/50/100-tab ladder belongs to the Phase 6 benchmark.

## How to reproduce

```bash
cd spikes
node s8-measurement/run.js 5
```

This writes `spikes/s8-measurement/results/s8-run-<n>.json` per launch, plus `s8-summary.json`. It takes about 5 minutes. `run.js` deletes `ELECTRON_RUN_AS_NODE` from the child environment; setting it to an empty string is not enough, because Electron treats an empty variable as set.
