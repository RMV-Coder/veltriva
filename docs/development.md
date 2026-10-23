# Development

How to build, test and package Veltriva Browser. For what it does and how to install it, see the [README](../README.md).

## Platform and stack

Windows 10/11 x64. Electron 45 (`BaseWindow` + `WebContentsView`), TypeScript 6 (strict), React 19, Tailwind CSS 4 with shadcn/ui, built with electron-vite and packaged with electron-builder. Tested with Vitest and Playwright. SQLite with FTS5 through better-sqlite3 13, in a worker thread.

## Requirements

Windows 10 or 11 x64, Node.js 24 (24.13 or later in the 24 line; `.nvmrc` names the version CI uses), npm 11 and Git. Setup installs nothing system-wide, and no Python or Visual Studio build tools are needed.

`npm run release` also needs Veyra on the PATH. It is the project's version-control tool and reads and writes ordinary Git repositories.

## Setup

```bash
npm run setup
npm run dev
```

`npm run setup` runs `npm ci` and then downloads Electron's binary explicitly with `node node_modules/electron/install.js`. It then checks that better-sqlite3's prebuilt Windows binary, which ships inside its npm package, matches the reviewed hash (`scripts/verify-sqlite-binary.mjs`). The repository's `.npmrc` sets `ignore-scripts=true`, so dependency install scripts never run, and `save-exact=true`, so every dependency is pinned to an exact version.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Starts electron-vite, which serves the renderer with hot reload and opens the app window. Changes to main or preload rebuild and restart the app. |
| `npm run build` | Production build of main, preload and renderer into `out/`. |
| `npm run build:test` | The same build with the E2E test hooks compiled in (`--mode test`). Never package it. |
| `npm run build:release` | A production build plus every check a release needs: the pinned SQLite binary (`verify-sqlite-binary.mjs`), the build itself, no test-only code in it (`check-production-build.mjs`), only the data worker loading SQLite (`check-data-isolation.mjs`), and `THIRD_PARTY_NOTICES.txt` current with every bundled license on the allow-list (`third-party-notices.mjs --check`). The packaging scripts and CI run it first. |
| `npm run typecheck` | `tsc -b` over every target's tsconfig (core, main, preload, renderer and node tooling). |
| `npm run lint` | ESLint with type-aware typescript-eslint rules and the React hooks rules. On a small laptop it can run out of memory; lint one folder at a time (`npx eslint src/main`, `npx eslint src/renderer`, and so on). |
| `npm run format` / `npm run format:check` | Prettier writes or checks formatting. Markdown is excluded. |
| `npm test` | Vitest unit tests on Node. On a small machine, `npm test -- --maxWorkers=2`. |
| `npm run test:e2e` | Builds the test variant, then runs the Playwright tests against the built, unpackaged app. They cover the shell, its CSP and protocol, the IPC contract and a hostile page in a tab. They also cover tabs, navigation, the address bar, crashes, PDFs, the clipboard and generated (`data:`, `blob:`) documents, find, zoom, fullscreen and its notice, DevTools, the keyboard shortcuts (against a page that tries to block them), keyboard focus and the context menus. Later phases add the tab lifecycle, search, settings and privacy, diagnostics, About and the update notice, and an axe-core accessibility scan of the shell in both themes. Every page comes from a local fixture server. |
| `npm run test:lifecycle` | Builds the test variant, then runs the lifecycle-behavior checks without Playwright (ADR-0008 4a): a background tab is hidden and throttled, closing the window with live tabs quits cleanly, and a page under the fullscreen notice stays visible and live. It also covers the database across launches (a quit capped at 3 s while a statement runs, recovery from a damaged file), session restore after 20 hard kills at random moments, which takes a few minutes, and what a discard does to real hidden tabs: the page state it keeps, the renderer it frees, a page that objects, and the freeze experiment. |
| `npm run bench:memory` | Builds the test variant, then runs the memory benchmark of assessment §9.3 without Playwright: 10, 25 and 50 tabs of a controlled-cost page, all live, moved to Sleeping, and unloaded, one warm-up and 5 measured runs each. `BENCH_SIZES=100` runs 100 tabs (about 4 GB of tab renderers, so a machine with room); `BENCH_SIZES` and `BENCH_RUNS` take any sizes and run count. It takes hours, records how loaded the machine was at each run's start, and writes its raw readings, gzipped, to `docs/benchmarks/data/`; `node tests/benchmarks/summarize-memory.mjs <file>` prints the tables. Run it on a quiet machine. The report is [benchmarks/memory.md](benchmarks/memory.md). |
| `npm run bench:search` | Builds the test variant, then measures search latency (assessment §5.4) without Playwright: 1,000, 10,000 and 50,000 pages of synthetic memory, 3 runs each, end to end through the app's own data RPC. It takes about 15 minutes and writes its raw data, gzipped, to `docs/benchmarks/data/`; `node tests/benchmarks/summarize-search.mjs <file>` prints the tables. Run it on a quiet machine. |
| `npm run package:dir` | Runs `build:release`, then packages an unpacked app with electron-builder into `release/win-unpacked/` (`Veltriva.exe`), with the production Electron fuses applied. It is unsigned, and no installer is built or installed. Last, `check-packaged-app.mjs` checks the result: only SQLite's binary is unpacked from `app.asar` (and it is the pinned one), the fuses read back from `Veltriva.exe` are the ones ADR-0007 sets, and all four license files ship. |
| `npm run package:installer` | Runs `build:release`, then builds the per-user NSIS installer, `release/Veltriva-Browser-Setup-<version>.exe`, and `release/win-unpacked/`, then runs the same `check-packaged-app.mjs`. It is unsigned ([signing](distribution/signing.md)). It builds an installer; it does not install it. |
| `npm run release -- <version>` | Prepares a release locally, e.g. `npm run release -- 0.2.0`: sets the version and commits it, runs the unit tests under `veyra attest run`, writes the release notes and tags the commit (local, annotated), builds the installer, writes `release/SHA256SUMS.txt`, and drafts `docs/releases/v<version>.md`. It stops at the first failure and pushes nothing. Options and the steps to publish are in [releasing](distribution/releasing.md). |
| `npm run licenses` | Builds, then regenerates `THIRD_PARTY_NOTICES.txt` from what the build bundled (`scripts/third-party-notices.mjs`). Commit the result when a dependency changes: `build:release` and CI fail on a stale file. |
| `scripts/installer-test.ps1` | Not an npm script. Runs an installer end to end on this machine and prints what it found at each step: install, launch, uninstall keeping the profile, reinstall, launch, uninstall removing the profile, then the silent uninstalls; `-Upgrade <newer installer>` also checks an upgrade over an install. Run it with `powershell -ExecutionPolicy Bypass -File scripts\installer-test.ps1 -Installer release\Veltriva-Browser-Setup-<version>.exe`. It renames your own profile aside and puts it back, and refuses to run while Veltriva is running or installed. Details in [releasing](distribution/releasing.md#testing-an-installer-on-this-machine). |

## Project layout

```text
veltriva/
├─ src/
│  ├─ core/
│  ├─ data/
│  ├─ main/
│  ├─ preload/
│  │  └─ shell.ts
│  ├─ renderer/
│  └─ shared/
├─ tests/
│  ├─ e2e/
│  ├─ lifecycle/
│  └─ benchmarks/
├─ scripts/
├─ build/
├─ docs/
├─ spikes/
└─ .github/
```

- `src/core/`: pure TypeScript with no Electron or Node imports, enforced by ESLint and by its own tsconfig.
- `src/data/`: the data worker, a worker thread that owns the SQLite database. It is the only code that may load SQLite (ESLint); main starts it by file name.
- `src/main/`: the Electron main process, which owns all state.
- `src/preload/shell.ts`: the preload for the shell UI. Web pages never get a preload.
- `src/renderer/`: the React shell UI.
- `src/shared/`: constants and types shared by several processes. Also pure.
- `tests/e2e/`: Playwright tests.
- `tests/lifecycle/`: lifecycle-behavior checks that run the app without Playwright.
- `tests/benchmarks/`: the memory and search benchmarks and their summarizers.
- `scripts/`: build, packaging and release tooling: the build checks, the SQLite pin, the notices generator, the release script, the icon drawing (`make-icon.mjs` writes `build/icon.ico`) and `installer-test.ps1`.
- `build/`: electron-builder's resources: the icon and `installer.nsh`, the uninstaller's question about the profile. Never packaged into the app.
- `docs/`: the assessment, ADRs, spike reports, plans, benchmarks, security review, distribution guides and manual checklists.
- `spikes/`: the Phase 0 experiments. Frozen, never shipped.
- `.github/`: the CI, CodeQL and release workflows, and Dependabot's configuration.

The full plan is in [technical assessment §3.8](architecture/technical-assessment.md#38-project-structure).

## Notes

- **E2E runs against the unpackaged app.** Tests launch it through Playwright's `_electron.launch` with `executablePath`. Playwright can't drive a packaged build, because the packaged app turns off the `EnableNodeCliInspectArguments` fuse. See [ADR-0008](adr/0008-testing-and-quality-tooling.md).
- **`ELECTRON_RUN_AS_NODE` must not be set** when you run `npm run dev`, because it makes Electron run as plain Node. The E2E test removes it from the app's environment and checks that it's gone before launch.
- **A separate profile for development.** Unpackaged builds (development and E2E) accept `VELTRIVA_USER_DATA_DIR=<absolute path>`. Packaged builds ignore it and always use `%APPDATA%\Veltriva`.
- **The shell loads from `app://shell`** in builds, and from the Vite dev server (with a development CSP) under `npm run dev`. Commands and events between the shell and main are defined in `src/shared/contracts`; see [ADR-0005](adr/0005-state-ownership-and-ipc.md).
- **Small machines.** Lint one folder at a time and cap the unit tests' workers (see the scripts table). Close other heavy programs before a benchmark: the reports say how loaded the machine was.
- **CI.** GitHub Actions workflows live in `.github/`, and none of them runs until the repository is pushed to GitHub (it has no remote yet).
  - **`ci.yml`** runs on `windows-latest` for every push to `main` and every pull request: setup, typecheck, lint, the format check, unit tests, `build:release`, the E2E tests and the lifecycle checks. On a push to `main` it also builds the installer (`npm run package:installer`) and keeps it as an artifact for 7 days. Each step is the same npm script you run locally.
  - **`codeql.yml`** runs CodeQL's JavaScript and TypeScript analysis on pushes to `main`, on pull requests and weekly.
  - **`release.yml`** runs when a `v*.*.*` tag is pushed. It builds the installer, writes `SHA256SUMS.txt` and creates a **draft** GitHub release. Publishing the draft is a click on GitHub.
  - **`dependabot.yml`** opens weekly pull requests for npm and GitHub Actions updates.
  - Every third-party action is pinned to a full commit SHA.
- **Releasing and signing.** [docs/distribution/releasing.md](distribution/releasing.md) covers the installer, the update notice, CI and the release script. [docs/distribution/signing.md](distribution/signing.md) covers what to change once you choose a signing route. Nothing in the repository publishes or signs anything on its own.

## License

[MIT](../LICENSE). Third-party licenses are in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
