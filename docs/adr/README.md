# Architecture decision records

Each ADR records one decision that shapes Veltriva: why it was made, and what it costs. The [technical assessment](../architecture/technical-assessment.md) holds the full reasoning, and its section numbers (§) are referenced throughout. Once an ADR is accepted, it is the source of truth. A superseded ADR stays in place, with a link to the ADR that replaces it.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-platform-electron.md) | Build on Electron with `BaseWindow` + `WebContentsView` | Accepted |
| [0002](0002-trust-zones-and-web-policy.md) | Trust zones, window composition and web policy | Accepted |
| [0003](0003-tab-model-and-lifecycle.md) | A four-dimension tab model, measured on an engagement clock | Accepted |
| [0004](0004-persistence-sqlite-worker.md) | SQLite via better-sqlite3 13, in a worker thread | Accepted |
| [0005](0005-state-ownership-and-ipc.md) | Main-process-authoritative state and a typed IPC contract | Accepted |
| [0006](0006-overlay-strategy.md) | Overlays above web content | Proposed, pending spike S4 |
| [0007](0007-build-packaging-identity.md) | Build, packaging, signing and app identity | Accepted |
| [0008](0008-testing-and-quality-tooling.md) | Testing strategy and quality tooling | Accepted |
| [0009](0009-mvp-product-decisions.md) | MVP product decisions: roadmap order, layout, search engine, single window | Accepted |

**Format.** Each ADR lists its status, date, the approved decision it implements (D1–D8 in assessment §11.3), and the spikes that validate it. It then covers context, decision, consequences and the alternatives considered.
