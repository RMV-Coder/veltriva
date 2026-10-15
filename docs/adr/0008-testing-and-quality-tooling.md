# ADR-0008: Testing strategy and quality tooling

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | The approved architecture (testing) |
| **Validated by** | Spike S6 (test reach) |
| **Details** | Technical assessment Part 9 |

## Decision

1. **Unit tests.** Vitest 5 on Node 24, with `*.test.ts` files next to the code. `src/core` needs at least 90% line and branch coverage.
2. **Model-based tests (fast-check 4).**
   - Random command sequences run against TabManager with fake tab runtimes.
   - Async completions are reordered with `fc.scheduler()` and `scheduledModelRun`.
   - Invariants I1–I8 are checked after every step.
3. **Integration tests** cover the data worker and migrations on Node, using the same N-API SQLite binary as the app:
   - every historical schema version is upgraded;
   - FTS integrity;
   - secure deletion;
   - crash consistency, using child processes killed mid-transaction.
4. **End-to-end tests (Playwright, pinned version).**
   - Tests drive the **built but unpackaged** app through `_electron.launch()`.
   - `WebContentsView`s are reachable as Pages, and main-process assertions use `electronApp.evaluate`.
   - Test hooks (`advanceClock`, `getTabStates`, `setMemoryPressure`, `crashRenderer`) exist only in test builds.
   - Pages come from a deterministic local fixture server; no critical test depends on an external site.
   - The test environment clears `ELECTRON_RUN_AS_NODE`.
5. **Installer smoke test**, without Playwright: install, launch, read back the fuses, assert that no test hooks exist, uninstall.
6. **Security tests:**
   - a hostile fixture page;
   - malformed payloads for every IPC handler;
   - navigation guards;
   - the protocol blocklist.
7. **Accessibility:** `@axe-core/playwright` on shell views, plus a keyboard-only walkthrough.
8. **CI (GitHub Actions, `windows-latest`).**
   - Every PR: typecheck, lint, unit, integration and E2E tests, plus a license check.
   - `main`: also an unsigned NSIS build artifact.
   - Benchmarks run manually.
   - Releases are manual drafts; nothing is published automatically.
9. **Tooling.**
   - TypeScript 6.0 with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
   - ESLint 10 (flat config), typescript-eslint (type-aware rules such as `no-floating-promises`) and Prettier.
   - TypeScript 7 and oxlint get revisited once typescript-eslint supports TypeScript 7.

## Consequences

- **Positive:** race conditions are explored systematically, not just through hand-written cases.
- **Positive:** no special test-runner tricks. Vitest can't run inside Electron, and with N-API it doesn't need to.
- **Negative:** packaged-build behavior is covered by a thinner smoke test rather than full E2E.

## Alternatives considered

- **Running Vitest under `ELECTRON_RUN_AS_NODE`.** Unsupported by Vitest, and unnecessary with N-API.
- **TypeScript 7 now.** Faster, but typescript-eslint doesn't support it yet.
