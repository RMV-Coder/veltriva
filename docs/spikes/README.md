# Phase 0 spikes

Spikes are time-boxed experiments. They test the riskiest assumptions in the [technical assessment](../architecture/technical-assessment.md) (§8.3) before any product code is written. Spike code lives in [`/spikes`](../../spikes) and is never shipped. Each spike has a report, raw results in `spikes/<spike>/results/`, and exact commands to reproduce it.

**Environment:** Windows 11 Home 10.0.26200 (one machine, Core i3, 125% display scaling), Node 24.13.0, Electron 44.7.2 (Chromium 152).

**How the work was split:** S2, S3, S5, S6 and S7 were run by Sonnet subagents, each owning one folder. S1, S4 and S8 were run by the orchestrator. Before accepting a delegated report, the orchestrator re-ran its headline checks (table below). The final measurement runs of S1, S4 and S8 happened with no other spike running.

| Spike | Question | Result | Report |
|---|---|---|---|
| S1 | View lifecycle: hidden-view visibility and throttling, renderer release, media events | **Confirmed.** Detaching hides and throttles a page, and re-attaching restores it. Only `close()` releases renderers predictably (about 55 MB per tab). Opaque views or windows covering a page also make it `hidden` | [s1-view-lifecycle.md](s1-view-lifecycle.md) |
| S2 | Restore fidelity of `navigationHistory.restore()` | **Partly confirmed.** The stack and plain form values restore. The view must be attached before `restore()`, and page state must be flushed before a snapshot. `contenteditable` and React-style inputs don't come back | [s2-restore-fidelity.md](s2-restore-fidelity.md) |
| S3 | Unsaved-work detection: `beforeunload` on close, input observers, form probe | **Confirmed, with changes.** `will-prevent-unload` is reliable and silent. The close path is gated on `hasBeenActive`, the probe gets a caller-side timeout, and a trusted-input tracker covers React-style inputs and `contenteditable` | [s3-unsaved-work-detection.md](s3-unsaved-work-detection.md) |
| S4 | Overlay strategy | **New option A′ adopted.** Raising the transparent shell above the tab keeps the page visible and live, shows the overlay in 12 ms, and needs no extra renderer. Snapshot takeover is rejected because it hides the page | [s4-overlay-strategy.md](s4-overlay-strategy.md) |
| S5 | Data stack: better-sqlite3 13 in a worker, packaged build, FTS5 latency, `node:sqlite` | **Confirmed, with amendments.** Search p95 at 50k pages is 23 ms round trip (about 11 ms with the restructured query). The packaged build needs no compiler. Statements can't be interrupted, so shutdown needs a hard-kill backstop | [s5-data-stack.md](s5-data-stack.md) |
| S6 | Test reach: Playwright and `WebContentsView` | **Partly confirmed.** Every view is reachable, but Playwright masks hidden-tab behavior, so lifecycle behavior gets its own non-Playwright test layer | [s6-test-reach.md](s6-test-reach.md) |
| S7 | Web compatibility and Electron defaults | **Automated checks done; four manual checks pending** (Google sign-in, an OAuth popup, YouTube, a real PDF). The unsafe defaults are confirmed, and PDF-frame, popup, download and user-agent details were added to ADR-0002 | [s7-web-compatibility.md](s7-web-compatibility.md) |
| S8 | Memory measurement method | **Confirmed.** `getAppMetrics()` private bytes match Windows' counters exactly and vary by only 0.5–1.3% between runs. Discarding 19 of 20 tabs freed 762 MB. Working set is a secondary number only | [s8-measurement-method.md](s8-measurement-method.md) |

## Independent verification of the delegated spikes

| Spike | Re-run by the orchestrator | Outcome |
|---|---|---|
| S2 | `s2-restore/main.js --only=q2b --reps=1 --tag=verify` | Reproduced. Restoring into a detached view lost the active scroll position (0/2); restoring into an attached-but-hidden view kept it (2/2) |
| S3 | `s3-unsaved-work/main.js --part=a` | Reproduced. An untouched page objected within 1.8 ms and stayed alive with no dialog. `close()` flipped `hasBeenActive` from false to true. A plain `close()` delivered only `visibilitychange`. A script-only dirty page was still honored |
| S5 | `s5d-packaged-check.js` | Reproduced. The worker loads from `app.asar`, the native module loads from `app.asar.unpacked`, and FTS5 works in the packaged worker. The slim build applies ADR-0007's fuses and shrinks the unpacked size from 26 MiB to 1.9 MiB |
| S6 | `S6_ONLY=bisect node s6-test-reach/run.js` | Reproduced. `Emulation.setFocusEmulationEnabled(true)` makes a hidden tab report `visible` (13 ticks and 83 frames per 1.3 s); `false` restores `hidden` (1 tick, 0 frames) |
| S7 | `pdf.js`, `downloads.js`, plus reading a `Zone.Identifier` stream directly | Reproduced. The strict guard blanks the PDF and allowing the viewer origin fixes it. Downloads survive closing or crashing their tab. Mark-of-the-Web is `ZoneId=3` + `HostUrl=about:internet` |

## Open follow-ups

- **S7 manual checks M1–M4** (Google sign-in, an OAuth popup, YouTube, a real-world PDF) need a person and real accounts. Steps are in the [S7 report](s7-web-compatibility.md#manual-checks-not-yet-run).
- **Real OS typing inside cross-site iframes:** do the main-process input observers see it? Automation can't produce that input. The design no longer depends on the answer ([S1 caveats](s1-view-lifecycle.md#caveats-and-follow-ups)).
- **Packaged-installer checks:** Mark-of-the-Web and SmartScreen behavior with Defender active, and quitting with an active download. These belong to Phase 6.
- **Real sites:** S2's `history.replaceState` flush and S3's trusted-input tracker were verified only on fixtures. They get re-checked on real single-page apps in Phase 3.
