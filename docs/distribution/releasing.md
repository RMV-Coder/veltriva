# Releasing Veltriva (M6.3)

How a version is built, checked and prepared. **Nothing here publishes anything:**
- the repository has no remote;
- the release script only tags locally;
- the CI workflows run only once you push to GitHub yourself.

Publishing, like code signing ([signing.md](signing.md)), is your decision.

## The installer

`npm run package:installer` builds `release/Veltriva-Browser-Setup-<version>.exe` with electron-builder's NSIS target (ADR-0007). Before electron-builder runs, `build:release` checks the build:
- the pinned SQLite binary;
- a production build;
- no test hooks;
- data isolation;
- the license notices.

Afterwards, `check-packaged-app.mjs` checks `release/win-unpacked`:
- the fuses, read back from the binary;
- the unpacked files;
- the license files.

| | |
|---|---|
| Install | One click, per user, no admin rights, into `%LOCALAPPDATA%\Programs\veltriva`. Starts Veltriva when done |
| Shortcuts | Start menu and desktop, "Veltriva Browser", stamped with the AppUserModelID `io.github.rmv-coder.veltriva`, which the app also sets for itself |
| Profile | `%APPDATA%\Veltriva`: tabs, history, settings, site data |
| Uninstall | Settings ▸ Apps ▸ Installed apps ▸ Veltriva Browser ▸ Uninstall. It confirms ("Are you sure you want to uninstall Veltriva Browser?"), then asks: **"Also remove your Veltriva data from this computer?"** (No is the default) |
| Reinstall / update | Running a newer installer replaces the app and keeps the profile. The uninstall step an update runs never asks and never removes it |
| Silent uninstall | `"%LOCALAPPDATA%\Programs\veltriva\Uninstall Veltriva.exe" /currentuser /S` keeps the profile; add `--delete-app-data` to remove it |
| Icon | `build/icon.ico`, drawn by `scripts/make-icon.mjs` (run it again after changing the design) |

The uninstaller's question is `build/installer.nsh` (electron-builder's `customUnInstall` hook).

## The update notice

**Off by default, and silent while off.** No request, no DNS lookup and no timer runs until the user turns on **Settings ▸ Updates ▸ Check for new versions** (`src/main/updates/update-checker.ts`).

- **When on,** Veltriva asks the release feed for the newest version 2 minutes after it starts, then once a day, or when the user presses **Check now**.
  - The request goes through a separate in-memory session, with no cookies or cache from browsing.
  - It is https only (or http to this machine), and the answer is capped at 1 MB.
- **A newer version** shows a notice with **View release** (main opens the release page in a tab), **Skip this version** and **Dismiss**. Nothing is downloaded or installed. Silent auto-update waits for signed builds (ADR-0007 item 4).
- **The default feed** is GitHub's latest-release API for `RMV-Coder/veltriva`: `https://api.github.com/repos/RMV-Coder/veltriva/releases/latest`. The feed can be changed in Settings. Any feed that answers in GitHub's release format works: `tag_name` (`v1.2.3`) and `html_url` (https), with drafts and prereleases skipped.
- **Leave it off until releases are published.** The repository has no remote yet. Until a release exists there, a check finds nothing, or fails, and says so.

## CI (`.github/workflows/`)

`ci.yml` runs on every push to main and every pull request. Each step is an npm script that also runs locally:

| CI step | Local command |
|---|---|
| Install dependencies | `npm run setup` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` (locally, split as `eslint src/main`, `src/renderer`, … when memory is short) |
| Check formatting | `npm run format:check` |
| Unit tests | `npm test` (locally `--maxWorkers=2` on a small machine) |
| Build and check the release build | `npm run build:release` |
| E2E tests | `npm run test:e2e` |
| Lifecycle tests | `npm run test:lifecycle` |
| Build the installer (main only) | `npm run package:installer` |

The other workflows:
- **`codeql.yml`:** CodeQL's JavaScript and TypeScript analysis, on pushes, pull requests and weekly.
- **`release.yml`:** runs on a pushed `v*.*.*` tag. It builds the installer, writes `SHA256SUMS.txt` and creates a **draft** GitHub release with both. Publishing the draft is a click on GitHub.
- **`.github/dependabot.yml`:** weekly dependency pull requests, which CI checks like any other.

Every third-party action is pinned to a full commit SHA, with its release in a comment. The pins were checked against GitHub's API on 2026-10-23:
- `actions/checkout` v7.0.1;
- `actions/setup-node` v7.1.0;
- `actions/upload-artifact` v7.0.2;
- `github/codeql-action` v4.38.3.

## The release script

```bash
npm run release -- 0.2.0
```

It stops at the first failure, and `veyra undo` reverses its commits and its tag. In order:
1. **Checks:** a plain `MAJOR.MINOR.PATCH` version, a clean working tree, and a tag name that is free.
2. **The version:** sets it in `package.json` and `package-lock.json`, and commits "Release v0.2.0: the version" with Veyra.
3. **The tests:** runs the unit tests under `veyra attest run`, so the release commit carries a test attestation (`--skip-tests` to skip).
4. **The tag:** writes the release notes (`veyra release notes`), then tags the commit (`veyra release prepare v0.2.0`). The tag is annotated and local.
5. **The installer:** builds it, with every packaging check (`npm run package:installer`).
6. **The checksum:** writes `release/SHA256SUMS.txt`.
7. **The draft page:** writes `docs/releases/v0.2.0.md` (the notes, the file and its SHA-256, how to check it, install and remove), and commits it.

Options:
- `--assisted-by "<model>"` and `--trailer "<line>"` pass through to the commits.

**To publish later (your decision):**
1. Push the branch and the tag: `veyra push origin main`, `veyra push origin v0.2.0`.
2. `release.yml` makes a draft release, or you make one by hand with the installer and `SHA256SUMS.txt`.
3. Fill in the draft page's highlights, then publish the release on GitHub.
