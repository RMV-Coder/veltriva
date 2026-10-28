# Memory benchmark (assessment §9.3), v0.1.0

**Measured on 2026-10-24** on the development laptop, at 10, 25, 50 and 100 tabs in §9.3's three modes: **every measured run finished** (5 of 5 at each size, plus a discarded warm-up each). The laptop was **not idle**: other programs were running, and the machine's load at each run's start is recorded below and in the raw files. Every number here comes from the raw files in [`data/`](data/), through `tests/benchmarks/summarize-memory.mjs`. Nothing is estimated.

The quiet-machine run in the final manual checklist (section 12) confirms or replaces these numbers.

## The result

Private bytes of Veltriva's whole process tree (§9.3's headline metric): the median of 5 runs, and the range.

| Tabs | A: all live | B: moved to Sleeping, still live | C: unloaded (1 live) | Freed by unloading (A − C) | Per unloaded tab |
|---|---|---|---|---|---|
| 10 | 608 MB (602–616) | 620 MB (610–628) | 304 MB (298–311) | **306 MB** (291–311) | 34.0 MB (32.4–34.5) |
| 25 | 1,141 MB (1,132–1,159) | 1,161 MB (1,154–1,176) | 336 MB (329–350) | **809 MB** (782–830) | 33.7 MB (32.6–34.6) |
| 50 | 2,010 MB (1,992–2,025) | 2,036 MB (2,017–2,056) | 357 MB (342–361) | **1,654 MB** (1,640–1,673) | 33.8 MB (33.5–34.1) |
| 100 | 3,771 MB (3,753–3,775) | 3,785 MB (3,773–3,791) | 383 MB (374–398) | **3,385 MB** (3,377–3,392) | 34.2 MB (34.1–34.3) |

What it shows:

- **Unloading frees about 34 MB per tab, and the saving grows linearly with the number of tabs:** 306, 809, 1,654 and 3,385 MB at 10, 25, 50 and 100. With 99 of 100 tabs unloaded, Veltriva holds 383 MB: 130 MB above the empty browser, and 3,385 MB below the same 100 tabs live.
- **Moving tabs out of sight frees nothing.** B (the same tabs moved to Sleeping, still loaded) was 12, 22, 32 and 16 MB *above* A. §9.3 includes this mode to show exactly that: visual organization alone saves no memory; only unloading does.
  - The rise is spread over the browser, GPU and tab processes; the shell's own renderer barely moves (39, 44, 54 and 70 MB in A; 39, 45, 55 and 71 MB in B). B is measured after A in the same launch, so the harness doesn't separate the move from the passing time. The difference is reported as measured, without a cause.
- **The empty browser** (the shell and one new-tab page, before any tab loads) holds 253–257 MB.
- **A tab's renderer** holds 33.7–33.9 MB private, the same at every size: Chromium gives each site its own renderer, and the benchmark puts each tab on a site of its own, as real browsing does.
- **What grows besides the tabs:** with every tab unloaded, the browser process and the shell grow a little with the number of tabs they keep track of (C is 304 MB at 10 tabs, 383 MB at 100).
- **Switching to a tab:** to a live hidden tab, a median of 79, 37, 30 and 79 ms at 10, 25, 50 and 100 tabs; to an unloaded tab, which reloads its page, 198, 134, 115 and 213 ms.
- **CPU while quiet** (60 s per phase, the whole tree): 0.11–0.69% with every tab live, 0.02% unloaded.
- **Loading every tab** took a median of 1.6, 3.6, 6.8 and 20.3 s; **unloading** all but one took 0.6, 0.24, 0.35 and 1.7 s.

### Per size

The summarizer's tables, verbatim. Working set counts shared pages once per process, so it overstates; it is a secondary number (§9.3, spike S8). On this machine it also swung widely (for example 72–2,881 MB at 25 tabs, all live): Windows trims working sets when memory runs short, and the machine's free memory moved between 507 and 2,434 MB across the runs. Private bytes don't move with trimming, which is why they are the headline.

#### 10 tabs (5 of 5 measured runs finished)

| Phase | Live tabs | Private MB, total | Tab renderers, private MB | Working set MB | CPU % (60 s quiet) |
|---|---|---|---|---|---|
| Empty (start) | 0 (0–0) | 257 (253–262) | 0 (0–0) | 408 (405–412) | — |
| A: all live | 10 (10–10) | 608 (602–616) | 339 (338–342) | 900 (666–1412) | 0.11 (0.1–0.15) |
| B: moved to Sleeping, live | 10 (10–10) | 620 (610–628) | 344 (343–347) | 774 (361–1362) | 0.04 (0.03–0.09) |
| C: unloaded | 1 (1–1) | 304 (298–311) | 35 (35–36) | 303 (211–425) | 0.02 (0.01–0.04) |

- Freed by unloading (A − C): 306 (291–311) MB private
- Freed per unloaded tab: 34 (32.4–34.5) MB
- A tab renderer in A: 33.9 (33.8–34.2) MB private
- B − A (moving to Sleeping alone): 12.1 (2–22.3) MB
- Switch to a live hidden tab: 78.6 (38.2–81.3) ms; to an unloaded one (it reloads): 197.8 (183.1–309.5) ms; switches over 120 s: 0
- Loading all 10: 1610 (1529–2448) ms; unloading 9: 609 (83–1622) ms
- Probes asked again after missing their 100 ms (all runs): 2
- Free memory at each run's start: 1178 (884–1267) MB
- Commit charge at each run's start: 17524 (17256–17912) MB of 26165 (26165–26165) MB; processor load 39 (29–46) %
- Largest processes at run 1's start (working set, MB): Memory Compression 971, claude 727, claude 333, MsMpEng 312, claude 310, svchost 214, Taskmgr 106, explorer 93, dwm 87, claude 83

#### 25 tabs (5 of 5 measured runs finished)

| Phase | Live tabs | Private MB, total | Tab renderers, private MB | Working set MB | CPU % (60 s quiet) |
|---|---|---|---|---|---|
| Empty (start) | 0 (0–0) | 254 (252–257) | 0 (0–0) | 391 (349–404) | — |
| A: all live | 25 (25–25) | 1141 (1132–1159) | 846 (841–850) | 1764 (72–2881) | 0.22 (0.13–1.83) |
| B: moved to Sleeping, live | 25 (25–25) | 1161 (1154–1176) | 851 (847–861) | 1594 (10–2882) | 0.03 (0.03–0.24) |
| C: unloaded | 1 (1–1) | 336 (329–350) | 35 (35–38) | 263 (10–489) | 0.02 (0.01–0.14) |

- Freed by unloading (A − C): 809 (782–830) MB private
- Freed per unloaded tab: 33.7 (32.6–34.6) MB
- A tab renderer in A: 33.8 (33.6–34) MB private
- B − A (moving to Sleeping alone): 22.2 (-4.5–43.6) MB
- Switch to a live hidden tab: 37.1 (33.6–1082) ms; to an unloaded one (it reloads): 133.7 (112.3–6014.3) ms; switches over 120 s: 0
- Loading all 25: 3628 (2627–4451) ms; unloading 24: 241 (156–4824) ms
- Probes asked again after missing their 100 ms (all runs): 1
- Free memory at each run's start: 1210 (507–2211) MB
- Commit charge at each run's start: 17502 (16647–19383) MB of 26165 (26165–26165) MB; processor load 9 (0–33) %
- Largest processes at run 1's start (working set, MB): Memory Compression 1154, claude 755, claude 301, MsMpEng 232, claude 157, svchost 126, dwm 99, snyk-win 89, snyk-win 88, claude 86

#### 50 tabs (5 of 5 measured runs finished)

| Phase | Live tabs | Private MB, total | Tab renderers, private MB | Working set MB | CPU % (60 s quiet) |
|---|---|---|---|---|---|
| Empty (start) | 0 (0–0) | 255 (252–256) | 0 (0–0) | 406 (404–408) | — |
| A: all live | 50 (50–50) | 2010 (1992–2025) | 1686 (1677–1703) | 5122 (3355–5609) | 0.28 (0.28–0.33) |
| B: moved to Sleeping, live | 50 (50–50) | 2036 (2017–2056) | 1693 (1689–1713) | 5154 (2861–5643) | 0.06 (0.05–0.06) |
| C: unloaded | 1 (1–1) | 357 (342–361) | 36 (35–38) | 554 (375–564) | 0.02 (0.02–0.02) |

- Freed by unloading (A − C): 1654 (1640–1673) MB private
- Freed per unloaded tab: 33.8 (33.5–34.1) MB
- A tab renderer in A: 33.7 (33.5–34.1) MB private
- B − A (moving to Sleeping alone): 31.7 (1.2–41) MB
- Switch to a live hidden tab: 29.5 (21.3–42.2) ms; to an unloaded one (it reloads): 115.4 (109.7–193.8) ms; switches over 120 s: 0
- Loading all 50: 6758 (5767–8020) ms; unloading 49: 351 (321–483) ms
- Probes asked again after missing their 100 ms (all runs): 0
- Free memory at each run's start: 2350 (1652–2434) MB
- Commit charge at each run's start: 16463 (16394–17352) MB of 26165 (26165–26165) MB; processor load 20 (17–32) %
- Largest processes at run 1's start (working set, MB): claude 665, Memory Compression 303, MsMpEng 268, claude 259, Creative Cloud UI Helper 242, claude 152, Creative Cloud UI Helper 109, dwm 100, snyk-win 88, snyk-win 88

#### 100 tabs (5 of 5 measured runs finished)

Run separately (`BENCH_SIZES=100`), right after the other sizes. 100 live tabs take about 3.8 GB of private memory on a 7.9 GB laptop with other programs open; Windows compressed and paged what didn't fit, which the private-bytes total doesn't feel and the switch and load times do.

| Phase | Live tabs | Private MB, total | Tab renderers, private MB | Working set MB | CPU % (60 s quiet) |
|---|---|---|---|---|---|
| Empty (start) | 0 (0–0) | 253 (253–259) | 0 (0–0) | 403 (403–408) | — |
| A: all live | 100 (100–100) | 3771 (3753–3775) | 3392 (3376–3401) | 5727 (5078–6540) | 0.69 (0.57–1.1) |
| B: moved to Sleeping, live | 100 (100–100) | 3785 (3773–3791) | 3399 (3382–3405) | 5546 (5140–5865) | 0.09 (0.08–0.11) |
| C: unloaded | 1 (1–1) | 383 (374–398) | 36 (35–37) | 450 (430–475) | 0.02 (0.02–0.03) |

- Freed by unloading (A − C): 3385 (3377–3392) MB private
- Freed per unloaded tab: 34.2 (34.1–34.3) MB
- A tab renderer in A: 33.9 (33.8–34) MB private
- B − A (moving to Sleeping alone): 16.3 (8.4–19.5) MB
- Switch to a live hidden tab: 79.4 (40.6–136.5) ms; to an unloaded one (it reloads): 212.7 (133.7–317.7) ms; switches over 120 s: 0
- Loading all 100: 20328 (15458–24432) ms; unloading 99: 1674 (1485–2209) ms
- Probes asked again after missing their 100 ms (all runs): 1
- Free memory at each run's start: 2090 (1571–2345) MB
- Commit charge at each run's start: 17040 (16616–17089) MB of 26165 (26165–26165) MB; processor load 14 (1–44) %
- Largest processes at run 1's start (working set, MB): claude 738, claude 283, MsMpEng 258, claude 257, Creative Cloud UI Helper 237, Memory Compression 205, PhoneExperienceHost 174, Creative Cloud UI Helper 100, dwm 96, claude 89

## The machine, and how loaded it was

- **Machine:** Intel Core i3-1215U (8 logical CPUs), 7,916 MB RAM, Windows 11 Home Single Language 10.0.26200, on AC power, the Balanced power plan, Defender real-time protection on. Electron 45.0.0 (Chromium 156), Veltriva 0.1.0's test build.
- **Not idle.** The Claude desktop app (the session that ran this benchmark, among others) held several processes of up to 755 MB; Defender, Adobe Creative Cloud's helpers and a Snyk process were running too. The largest processes at the start of each size are listed above.
- **Load at each run's start** (all sizes): free memory 507–2,434 MB; commit charge 16.4–19.4 GB of a 26.2 GB limit; processor load 0–46%. The 10-tab runs came first, on the busiest machine (29–46% processor load); it was quieter by the 50- and 100-tab runs.
- **What that does to the numbers:**
  - **Private bytes** count the memory each process committed, whether or not Windows keeps it in RAM, so the headline holds under load. The ranges agree: every A and B reading is within 2% of its median, and every C reading within 4.2%.
  - **Working set, CPU and switch times** do feel the load. The working-set ranges are one sign. The 25-tab outliers are another: a 6.0 s reload, a 1.1 s switch and a 4.8 s unload, all in run 2, which started with 788 MB free.

## Compared with earlier readings

- **The Phase 3 attempts** (2026-10-22, [phase-3-memory.md](phase-3-memory.md)) never finished a measured run on a far more loaded machine (93–690 MB free). Their 10-tab warm-ups read A − C as 307 MB, about 34 MB a tab: the same as here.
- **Spike S8** measured about 40 MB per tab (20 live tabs 886 MB, 762 MB freed by discarding 19), with its own harness on Electron 44.7.2 (Chromium 152). This report doesn't explain the 6 MB difference; the per-tab figure here is the one measured on v0.1.0 (Electron 45.0.0).

## The method

[phase-3-memory.md](phase-3-memory.md#the-method-as-built) describes the harness in detail. In short, it follows §9.3 and spike S8:
- **Metric:** the sum of private bytes over the whole process tree from `app.getAppMetrics()`, grouped as browser, GPU, utility, shell and tabs. The scenario is the only caller while it runs.
- **Corpus:** §9.3's synthetic part only. Every tab is the same controlled-cost page (10 MB of JavaScript heap, about 100 KB of DOM), each on a site of its own (`m<i>.test`, mapped to the local fixture server), so each gets its own renderer.
- **Modes,** in one launch: A, all tabs loaded, the last selected, automation paused; B, all but the selected tab moved to Sleeping by the user's command, still loaded; C, those tabs unloaded, as automation would. Each phase settles 10 s, then CPU is averaged over 60 s.
- **Protocol:** a fresh launch on a fresh profile per run; one warm-up per size, discarded; 5 measured runs; the median and the range.
- **Not covered here:**
  - §9.3's openly licensed real-page corpus and the dynamic sites (Gmail, YouTube), which need pages and accounts this repository doesn't hold;
  - session-restore latency and startup time, which no benchmark measures yet;
  - the database's size, which the diagnostics page shows but this benchmark doesn't record;
  - the optional cross-browser comparison.

## Reproduce it

```bash
npm run bench:memory
BENCH_SIZES=100 npm run bench:memory
node tests/benchmarks/summarize-memory.mjs docs/benchmarks/data/memory-<date>-10-25-50.json.gz
```

`npm run bench:memory` builds the test variant and runs 10, 25 and 50 tabs, which took 74 minutes here; 100 tabs took 26 more. The raw files are written after every run, so an interrupted run keeps what it measured; a failed run is recorded with its error.

**Raw data** (every run, with the machine and its load at each run's start; dated in UTC, which was still 2026-10-23 when the runs started):
- [`memory-2026-10-23-10-25-50.json.gz`](data/memory-2026-10-23-10-25-50.json.gz) and [`.csv`](data/memory-2026-10-23-10-25-50.csv);
- [`memory-2026-10-23-100.json.gz`](data/memory-2026-10-23-100.json.gz) and [`.csv`](data/memory-2026-10-23-100.csv).
