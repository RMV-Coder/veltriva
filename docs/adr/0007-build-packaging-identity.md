# ADR-0007: Build, packaging, signing and app identity

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | D6 (app identity) and D7 (packaging and signing) |
| **Validated by** | Spike S5 (packaged build) |
| **Details** | Technical assessment §2.4, §6.2, §10.2 |

## Decision

1. **Build.** electron-vite 6 (Vite 8) builds main, preload and renderer, with renderer HMR and hot restart for main and preload. If electron-vite's maintenance falters, building moves to Electron Forge 8's Vite plugin (now stable), and packaging stays on electron-builder.
2. **Package.** electron-builder 26 produces a **per-user NSIS installer** that needs no admin rights. Native modules are unpacked from `asar` automatically. The native rebuild step is disabled, because better-sqlite3 13 ships N-API prebuilds.
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
   | License | MIT, after a dependency license review in Phase 6 |

## Consequences

- **Positive:** a mature per-user installer with delta updates, and fuses with no extra dependency.
- **Negative:** two third-party build tools (electron-vite and electron-builder) instead of Forge's single toolchain.
- **Negative:** unsigned builds show SmartScreen warnings until signing is set up.
- **Negative:** Playwright needs the inspect fuse left on, so E2E runs against the unpackaged build (ADR-0008).

## Alternatives considered

- **Electron Forge 8 end to end.** Its Vite plugin is now stable, but its Windows makers are Squirrel, WiX, MSIX and AppX. NSIS is available only through electron-builder's own maker, and `electron-updater` doesn't support Squirrel.
- **Squirrel.Windows with Electron's built-in updater.** Dated, and gives no control over the install location.
