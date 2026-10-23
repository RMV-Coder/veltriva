# ADR-0007: Build, packaging, signing and app identity

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | D6 (app identity) and D7 (packaging and signing) |
| **Validated by** | [Spike S5](../spikes/s5-data-stack.md) (packaged `--dir` build: worker in `asar`, native module unpacked, FTS5 working, this fuse set applied, no compiler needed) |
| **Details** | Technical assessment §2.4, §6.2, §10.2 |

## Decision

1. **Build.** electron-vite 6 (Vite 8) builds main, preload and renderer, with renderer HMR and hot restart for main and preload. If electron-vite's maintenance falters, building moves to Electron Forge 8's Vite plugin (now stable), and packaging stays on electron-builder.
2. **Package.** electron-builder 26 produces a **per-user NSIS installer** that needs no admin rights.
   - Native modules are unpacked from `asar` automatically. The data worker script loads from inside `app.asar` with no extra configuration (S5).
   - **The native rebuild step stays disabled** (`npmRebuild: false`). better-sqlite3 13 ships N-API prebuilds, and with rebuilding on, electron-builder runs node-gyp and MSBuild, which need Python and Visual Studio.
   - **A `files` filter ships only better-sqlite3's `lib/`, `package.json` and `prebuilds/win32-x64.node`.** Unfiltered, the whole package (26 MiB, every platform's binary and the C sources) lands in `app.asar.unpacked`; filtered, it's 1.9 MiB.
   - **As built in M2.1a.**
     - The filter also drops `binding.gyp`, the README and node-addon-api, but keeps the license.
     - Smart unpacking is off, and `asarUnpack` names only `prebuilds/win32-x64.node`. Windows can't map a DLL from inside the archive, and Electron redirects the worker's `require()` of it to `app.asar.unpacked`. The worker script and better-sqlite3's JavaScript stay in `app.asar`.
     - `scripts/check-packaged-app.mjs` runs at the end of `package:dir`. It reads the asar header and checks that the binary is the only unpacked file, that it matches the pinned SHA-256, and that no build input, other platform's binary or node-addon-api shipped.
3. **Fuses**, set through `electronFuses`:
   - `RunAsNode` off;
   - `EnableCookieEncryption` **on** (one-way);
   - `EnableNodeOptionsEnvironmentVariable` off;
   - `EnableNodeCliInspectArguments` off;
   - `EnableEmbeddedAsarIntegrityValidation` on;
   - `OnlyLoadAppFromAsar` on;
   - `GrantFileProtocolExtraPrivileges` off.
4. **Updates.**
   - Before any public release: an update-available notification, checked against GitHub Releases.
   - Once builds are signed: silent auto-update through `electron-updater`, with differential (blockmap) downloads.
5. **Signing.** Apply to SignPath Foundation's free signing for open-source projects once the repo is public. It requires an OSI license, builds from the repository, and MFA. Azure Artifact Signing is the paid alternative, and its public-trust tier is region-limited for individuals.
6. **App identity.** These are one-way doors:

   | Item | Value |
   |---|---|
   | Product name | Veltriva Browser |
   | Executable | `Veltriva.exe` |
   | AppUserModelID | `io.github.rmv-coder.veltriva` |
   | User data folder | `%APPDATA%\Veltriva`, set with `app.setPath('userData', …)` before `ready` so it doesn't follow the product name |
   | Browsing partition | `persist:browsing` |
   | License | MIT, confirmed by the dependency license review in M6.1 (below) |

7. **Licenses, as built in M6.1** ([docs/security/security-review.md](../security/security-review.md#licenses)).
   - **Every license the app ships is permissive:** MIT, ISC and Apache-2.0, all compatible with shipping an MIT app.
   - **What ships is recorded by the build.** A Vite plugin (`scripts/bundled-packages.mjs`) writes each bundle's packages to `out/third-party/*.json`, which isn't packaged. `scripts/third-party-notices.mjs` adds the style sheets' packages, the bundlers' helpers, better-sqlite3 and what its binary compiles in, and Electron.
   - **`THIRD_PARTY_NOTICES.txt`** is generated from that, committed, and shipped in `resources/` beside `LICENSE.txt` (`extraResources`). electron-builder puts `LICENSE.electron.txt` and `LICENSES.chromium.html` (Chromium and Node.js) next to `Veltriva.exe`.
   - **The license check** (`third-party-notices.mjs --check`, in `package:dir` and CI) fails when the file is stale or a license isn't on the allow-list. `check-packaged-app.mjs` checks that all four files ship, and reads the fuses back from `Veltriva.exe`.

8. **As built in M6.3** ([docs/distribution/releasing.md](../distribution/releasing.md)).
   - **The installer** (`npm run package:installer`): one-click and per-user, with Start-menu and desktop shortcuts carrying the AppUserModelID.
     - **The uninstaller asks** whether to remove `%APPDATA%\Veltriva` (`build/installer.nsh`, the `customUnInstall` hook). An update's uninstall step, and a silent uninstall, never remove it.
     - **The icon** is drawn by `scripts/make-icon.mjs`, with no image tool: bitmaps up to 64 px, PNG at 128 and 256.
   - **Signing** stays off, the user's decision; [docs/distribution/signing.md](../distribution/signing.md) says what unsigned means and what to add for each route.
   - **The update notice** (item 4's "update-available notification"): `src/main/updates`, off by default.
     - **While off:** no request, DNS lookup or timer.
     - **When on:** a check 2 minutes after startup and then daily, against GitHub's latest-release API for `RMV-Coder/veltriva`, or a feed the user sets. The request uses a separate in-memory session, https only (or http to this machine), and reads at most 1 MB.
     - **What the user sees:** a notice for a newer version, with "View release". Main opens the page it read from the feed, so the shell never names a URL. Nothing is downloaded.
   - **`veltriva://about`:** the versions (Veltriva, Electron, Chromium, Node.js, V8), the MIT license, `THIRD_PARTY_NOTICES.txt`, and the update status.
   - **CI:**
     - every step of `ci.yml` is an npm script that also runs locally;
     - `codeql.yml` and Dependabot added (threat T12);
     - `release.yml` builds and makes a **draft** release from a pushed tag;
     - every action is pinned by SHA, checked against GitHub's API.
   - **The release script** (`npm run release -- <version>`), all local, never pushed:
     - the version bump, committed with Veyra;
     - attested unit tests;
     - `veyra release notes`, and `veyra release prepare` for an annotated tag;
     - the installer, its SHA-256, and a draft `docs/releases/v<version>.md`.

## Consequences

- **Positive:** a mature per-user installer with delta updates, and fuses with no extra dependency.
- **Negative:** two third-party build tools (electron-vite and electron-builder) instead of Forge's single toolchain.
- **Negative:** unsigned builds show SmartScreen warnings until signing is set up.
- **Negative:** Playwright needs the inspect fuse left on, so E2E runs against the unpackaged build (ADR-0008).

## Alternatives considered

- **Electron Forge 8 end to end.** Its Vite plugin is now stable, but its Windows makers are Squirrel, WiX, MSIX and AppX. NSIS is available only through electron-builder's own maker, and `electron-updater` doesn't support Squirrel.
- **Squirrel.Windows with Electron's built-in updater.** Dated, and gives no control over the install location.
