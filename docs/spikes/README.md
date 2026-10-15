# Phase 0 spikes

Spikes are time-boxed experiments. They test the riskiest assumptions in the [technical assessment](../architecture/technical-assessment.md) (§8.3) before any product code is written. Spike code lives in [`/spikes`](../../spikes) and is never shipped.

**Environment:** Windows 11 Home 10.0.26200, Node 24.13.0, Electron 44.7.2 (Chromium 152).

| Spike | Question | Status | Report |
|---|---|---|---|
| S1 | View lifecycle: hidden-view visibility and throttling, renderer release, media and input events | In progress | — |
| S2 | Restore fidelity of `navigationHistory.restore()` | In progress | — |
| S3 | Unsaved-work detection: `beforeunload` on close, form probe accuracy | In progress | — |
| S4 | Overlay strategy: snapshot takeover vs overlay view | In progress | — |
| S5 | Data stack: better-sqlite3 13 in a worker, packaged build, FTS5 latency, `node:sqlite` | In progress | — |
| S6 | Test reach: Playwright and `WebContentsView` | In progress | — |
| S7 | Web compatibility smoke tests | In progress | — |
| S8 | Memory measurement method | In progress | — |
