# Veltriva Browser

> **Browse freely. Remember effortlessly.**

Veltriva is a local-first, Chromium-powered desktop browser that intelligently manages inactive tabs, preserves browsing context, and makes previously visited pages instantly searchable.

**Status: Phase 1.** Phase 0 (architecture and spikes) is done, apart from four manual web-compatibility checks. Phase 1 is under way:
- Milestone 1.1 built the project scaffold and CI.
- Milestone 1.2 built the secure shell. The UI is served from `app://shell` with a strict Content Security Policy. It talks to the main process through a typed, validated IPC contract, and every web page gets a role and a locked-down policy.
- Milestone 1.3a made it a browser, with tabs in a vertical sidebar (pinned first; reorder by dragging or with Alt+Shift+arrow keys). Its pieces:
  - **Address bar:** back, forward and reload, with search through DuckDuckGo by default.
  - **Internal pages:** new-tab, network-error and crashed-tab pages.
  - **Favicons:** validated before the shell shows them. They are never fetched from your own machine or local network unless the page itself is there.
- Milestone 1.3b added the everyday browser controls:
  - **Find in page:** Ctrl+F, with match counts.
  - **Zoom:** per site, with Chrome's zoom steps and an indicator in the address bar.
  - **Context menus:** right-click menus for pages, links, images, text fields and spelling, plus a menu for each sidebar tab.
  - **Fullscreen:** a page that asks for fullscreen gets it, with a notice naming the site.
  - **DevTools:** F12 opens a page's DevTools in their own window.
  - **Keyboard shortcuts:** listed under [Keyboard shortcuts](#keyboard-shortcuts).
- Milestone 1.4a lets pages ask for things, safely:
  - **Permissions:** a page that wants your camera, microphone, location, notifications or clipboard asks in a strip under the toolbar, naming the site. Your answer is remembered for the session. Everything else is refused.
  - **Pop-ups:** a pop-up opens only right after you click or press a key in the page; otherwise it's blocked, and the strip offers to open it. Sign-in and payment pop-ups open in a small window with a read-only address bar.
  - **Other apps:** a link to another app (Zoom, Teams, email) opens it only after you click it and say yes. Dangerous link types are always refused.

## Why

Some people keep 50 or 100 tabs open because closing one feels like losing it. Veltriva is built for them. It manages tabs *for* you, and it keeps everything findable:

- **Tabs you stop using move out of the way:** Tabs → Sleeping → Archive. Inactivity is measured in *your* browsing time, so a weekend away never empties your workspace.
- **Inactive pages are unloaded to free memory**, and their back/forward history is kept.
- **Pages that might hold unsaved work are left alone**, for example ones playing audio, sharing your camera, or declaring unsaved changes.
- **Every tab stays in a private, local, searchable memory**, one keystroke away (Ctrl+Shift+K).
- **Nothing leaves your machine:** no telemetry, no cloud, no remote search suggestions.

## Principles

- **Velocity:** fast browsing with intelligent resource management.
- **Retrieval:** effortlessly rediscover previously visited websites.
- **Continuity:** resume browsing sessions without losing context.

## Keyboard shortcuts

The browser keeps these keys for itself, so a page can't block them:

| Keys | Action |
|---|---|
| Ctrl+T | New tab |
| Ctrl+W, Ctrl+F4 | Close the tab |
| Ctrl+Shift+T | Reopen the last closed tab |
| Ctrl+Tab, Ctrl+Shift+Tab | Next or previous tab |
| Ctrl+1 to Ctrl+8, Ctrl+9 | Go to that tab, or to the last one |
| Ctrl+L, Alt+D | Go to the address bar |
| F6 | Switch between the address bar and the page |
| F5, Ctrl+R | Reload |
| Shift+F5, Ctrl+F5, Ctrl+Shift+R | Reload without the cache |
| Alt+Left, Alt+Right | Back or forward |
| F11 | Fullscreen (it also ends a page's fullscreen) |
| F12 | The page's DevTools |
| Ctrl+Shift+K | Reserved for the memory palette (Phase 4) |

A page gets these keys first, and the browser acts only if the page doesn't use them. That way a web app with its own find, such as an online editor, keeps it:

| Keys | Action |
|---|---|
| Ctrl+F | Find in page |
| F3, Ctrl+G and Shift+F3, Ctrl+Shift+G | Next or previous match |
| Ctrl+Plus, Ctrl+Minus, Ctrl+0 | Zoom in, zoom out, or back to 100% (also Ctrl+mouse wheel) |

Esc leaves a page's fullscreen. AltGr combinations always go to the page, because they type characters on many keyboard layouts.

## Documentation

- [Technical assessment and architecture proposal](docs/architecture/technical-assessment.md)
- [Architecture decision records](docs/adr/README.md)
- [Phase 0 spike reports](docs/spikes/README.md)

## Platform and stack

Windows 10/11 x64. Electron 44 (`BaseWindow` + `WebContentsView`), TypeScript 6 (strict), React 19, Tailwind CSS 4 with shadcn/ui, built with electron-vite and packaged with electron-builder. Tested with Vitest and Playwright. SQLite with FTS5 arrives in Phase 2 (persistence and session restore).

## Development

### Requirements

Windows 10 or 11 x64, Node.js 24 (24.13 or later in the 24 line; `.nvmrc` names the version CI uses), npm 11 and Git. Setup installs nothing system-wide, and no Python or Visual Studio build tools are needed.

### Setup

```bash
npm run setup
npm run dev
```

`npm run setup` runs `npm ci` and then downloads Electron's binary explicitly with `node node_modules/electron/install.js`. The repository's `.npmrc` sets `ignore-scripts=true`, so dependency install scripts never run, and `save-exact=true`, so every dependency is pinned to an exact version.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Starts electron-vite, which serves the renderer with hot reload and opens the app window. Changes to main or preload rebuild and restart the app. |
| `npm run build` | Production build of main, preload and renderer into `out/`. |
| `npm run build:test` | The same build with the E2E test hooks compiled in (`--mode test`). Never package it. |
| `npm run typecheck` | `tsc -b` over every target's tsconfig (core, main, preload, renderer and node tooling). |
| `npm run lint` | ESLint with type-aware typescript-eslint rules and the React hooks rules. |
| `npm run format` / `npm run format:check` | Prettier writes or checks formatting. Markdown is excluded. |
| `npm test` | Vitest unit tests on Node. |
| `npm run test:e2e` | Builds the test variant, then runs the Playwright tests against the built, unpackaged app. They cover the shell, its CSP and protocol, the IPC contract and a hostile page in a tab. They also cover tabs, navigation, the address bar, crashes, PDFs, the clipboard and generated (`data:`, `blob:`) documents. M1.3b adds find, zoom, fullscreen and its notice, DevTools, the keyboard shortcuts (against a page that tries to block them), keyboard focus and the context menus. Every page comes from a local fixture server. |
| `npm run test:lifecycle` | Builds the test variant, then runs the lifecycle-behavior checks without Playwright (ADR-0008 4a): a background tab is hidden and throttled, closing the window with live tabs quits cleanly, and a page under the fullscreen notice stays visible and live. |
| `npm run package:dir` | Builds, checks that the build contains no test-only code (the test hooks, the lifecycle runner and the test build's crash handler), then packages an unpacked app with electron-builder into `release/win-unpacked/` (`Veltriva.exe`), with the production Electron fuses applied. It is unsigned, and no installer is built or installed. |

### Project layout

```text
veltriva/
├─ src/
│  ├─ core/
│  ├─ main/
│  ├─ preload/
│  │  └─ shell.ts
│  ├─ renderer/
│  └─ shared/
└─ tests/
   ├─ e2e/
   └─ lifecycle/
```

- `src/core/`: pure TypeScript with no Electron or Node imports, enforced by ESLint and by its own tsconfig.
- `src/main/`: the Electron main process, which owns all state.
- `src/preload/shell.ts`: the preload for the shell UI. Web pages never get a preload.
- `src/renderer/`: the React shell UI.
- `src/shared/`: constants and types shared by several processes. Also pure.
- `tests/e2e/`: Playwright tests.
- `tests/lifecycle/`: lifecycle-behavior checks that run the app without Playwright.

The full plan is in [technical assessment §3.8](docs/architecture/technical-assessment.md#38-project-structure).

### Notes

- **E2E runs against the unpackaged app.** Tests launch it through Playwright's `_electron.launch` with `executablePath`. Playwright can't drive a packaged build, because the packaged app turns off the `EnableNodeCliInspectArguments` fuse. See [ADR-0008](docs/adr/0008-testing-and-quality-tooling.md).
- **`ELECTRON_RUN_AS_NODE` must not be set** when you run `npm run dev`, because it makes Electron run as plain Node. The E2E test removes it from the app's environment and checks that it's gone before launch.
- **A separate profile for development.** Unpackaged builds (development and E2E) accept `VELTRIVA_USER_DATA_DIR=<absolute path>`. Packaged builds ignore it and always use `%APPDATA%\Veltriva`.
- **The shell loads from `app://shell`** in builds, and from the Vite dev server (with a development CSP) under `npm run dev`. Commands and events between the shell and main are defined in `src/shared/contracts`; see [ADR-0005](docs/adr/0005-state-ownership-and-ipc.md).
- **CI.** GitHub Actions on `windows-latest` runs typecheck, lint, the format check, unit tests, the production build with its no-test-hooks check, the E2E tests and the lifecycle checks on every push to `main` and every pull request (`.github/workflows/ci.yml`).

## License

[MIT](LICENSE). Dependency licenses will be reviewed before the first release.
