# Phase 6 plan: quality and release

Pre-approved by the user on 2026-10-22, with Phases 2–6 ("make commits and merge when done … finish all phases"). The orchestrator reviews each milestone, re-runs the checks, scans with Veyra and merges. The user runs the manual checks once all phases are done.

**Sources of truth:**
- ADR-0001 (the Electron upgrade policy), ADR-0002 (trust zones and the web policy), ADR-0007 (build, packaging, signing and identity) and ADR-0008 (testing and tooling).
- The technical assessment:
  - Part 6: the security model and threats T1–T15;
  - §7.2: the Release row (installer, fuses, About, update notification);
  - §8.2: the Phase 6 acceptance;
  - Part 9: testing, the §9.3 benchmark method and §9.4 CI.

**Working rules:**
- One stacked branch per milestone, each started from the previous one's tip.
- Commits with Veyra (`--assisted-by`), never pushed or merged by the implementer.
- **Still the user's call:** paid code signing, and anything public. There is no remote, so nothing is pushed and no release is published.

## The milestones as planned

- **M6.1, the security review and hardening** (`claude/m6.1-security`).
  - Walk Part 6 and T1–T15 against the code; record each item's status and evidence in `docs/security/security-review.md`; fix what's cheap.
  - **Known items:** log redaction beyond field names; DNS rebinding for favicons (T5); an Electron dialog-handler API; the newest 45.x patch.
  - **Dependency and license audit:** `npm audit`, runtime vs build-only; every shipped license, MIT-compatible; `THIRD_PARTY_NOTICES` in the packaged app.
  - **Veyra across the history:** `analyze`, `security scan --rev`, `intent verify`; new intents where an invariant belongs.
- **M6.2, the accessibility pass** (`claude/m6.2-a11y`): keyboard reach everywhere (the sidebar as an ARIA tree, the palette as a listbox), focus rings, WCAG AA contrast in both themes, `prefers-reduced-motion`, text for state icons; axe-core in E2E for the shell's pages; `docs/testing/accessibility.md` with the Narrator checks.
- **M6.3, packaging and release** (`claude/m6.3-release`): the NSIS installer (per-user, AppUserModelID, Start-menu shortcut, icon, uninstall keeps or removes the profile), built and exercised on this machine; signing documented, not bought; `veltriva://about`; an update notification, off by default and with no traffic unless enabled; CI that runs exactly the local gates, every step run locally; a release script that tags locally only.
- **M6.4, the benchmark report and final docs** (`claude/m6.4-docs`): 10, 25, 50 and 100 tabs × the §9.3 modes, with the machine load recorded and the Phase 3 memory measurement retried; the user-facing README; screenshots; v0.1.0 release notes; `docs/testing/final-manual-checklist.md`.

## Phase 6 acceptance (§8.2, adapted)

| Criterion | Status |
|---|---|
| A clean install works on this machine; VM checks listed for the user | **Met on this machine (M6.3)**: install, uninstall both ways, reinstall and upgrade, by `scripts/installer-test.ps1`. Clean Windows 10 and 11 VMs are in the final manual checklist |
| The benchmark report is reproducible | **Met (M6.4)**: [docs/benchmarks/memory.md](../benchmarks/memory.md), 10, 25, 50 and 100 tabs × the three modes, 20 of 20 measured runs; the raw files and the commands that reproduce them are committed, and the machine's load at each run's start is recorded. A quiet-machine run is in the final manual checklist |
| Known limitations are documented | **Met (M6.4)**: the README's known limitations, with M6.1's two, what this version leaves out, and the clean-VM check still to come |
| Every CI step passes locally | **Met (M6.3)**: every `ci.yml` step, in a fresh clone and the milestone gates; `release.yml`'s steps with `gh` stubbed |

## As built

### M6.1

See [docs/security/security-review.md](../security/security-review.md) for the full checklist. In short:
- **Fixed:** favicon redirects into the local network (measured, now each hop re-checked); public names resolving to local addresses (now resolved and checked); addresses in free-text log fields (now scrubbed); no fuse read-back (now on every `package:dir`).
- **Added:** `THIRD_PARTY_NOTICES.txt` from what the build actually bundled, shipped in `resources/`, with a license check in `package:dir` and CI.
- **Unchanged decisions:** native JS dialogs (no Electron API yet); Electron 45.0.0 (no newer 45.x on 2026-10-23).
- **Residual, stated:** DNS rebinding between main's lookup and the request.
- **Deviations from the brief:** none. `veyra analyze`'s only findings across the history are a Postgres-only index rule on SQLite migrations and the rename already accepted in M2.2b.

### M6.2

Most of §7.3 was already built in earlier phases: a roving-tabindex tab list with arrow keys, Home and End, Enter, Delete and Alt+Shift moves; `aria-describedby` state text for every icon; `motion-reduce` variants on every animation; live regions for the palette, the Undo toast, the prompts and the notices. M6.2 measured it and filled the gaps:
- **axe-core** (`@axe-core/playwright` 4.13.0, dev-only) scans 10 shell states in both themes against WCAG 2.2 A and AA (`tests/e2e/accessibility.spec.ts`). It found nothing on the code as built. A negative control (faint sidebar text injected) made it fail in both themes, so the scans aren't vacuous; each scan also asserts that `color-contrast` was checked.
- **What axe can't see, fixed by measurement:**
  - **Focus rings:** the Button's `ring-ring/50` measured 1.5:1, and the browser's own outline color the same. Both now use the full ring color at 4.7:1 (3:1 is required).
  - **The light theme's `--ring`** went from 0.708 (2.6:1) to 0.556.
  - **The popup bar's muted text** went from 4.4:1 to 5.4:1.
  - **`--muted-foreground`** went from 4.3:1 to 5.5:1 on the sidebar. No shell text uses it yet; shadcn's components do.
- **Keyboard:** F6 now cycles the address bar, the sidebar's selected tab and the page. Before, it alternated between the address bar and the page.
- **Screen readers:**
  - The address bar announces how many suggestions appeared.
  - The palette's announcement names the filter, since Tab changes it while the field keeps focus.
- **Deviation, recorded in ADR-0009 item 6:** the sidebar stays a vertical `tablist` plus disclosure sections, not the `tree` §7.3 named.
- **The user's checks:** `docs/testing/accessibility.md` (Narrator, keyboard only, contrast themes, text size, reduced motion).

### M6.3

Details are in [docs/distribution/releasing.md](../distribution/releasing.md) and ADR-0007 item 8.
- **The installer** (`npm run package:installer`): one click, per user, into `%LOCALAPPDATA%\Programs\veltriva`. Start-menu and desktop shortcuts carry the AppUserModelID. The icon is drawn by a script. The build is unsigned; `docs/distribution/signing.md` says what each signing route needs.
- **Uninstall:**
  - It confirms, then asks whether to remove `%APPDATA%\Veltriva`; No is the default.
  - `/S` keeps the profile; `/S --delete-app-data` removes it; an update never asks.
  - **Found by running it:** the first build never asked. A one-click uninstaller turns itself silent after its own confirmation, so the hook now decides by the command line.
- **Tested on this machine** with `scripts/installer-test.ps1`: install, launch, both uninstall answers, reinstall, the scripted uninstalls, and an upgrade from 0.0.0 to 0.1.0. The user's profile was renamed aside and restored each time.
- **`veltriva://about`:** the versions, the MIT license, the third-party notices and the update status.
- **The update notice:** off by default, and silent while off (no request, no DNS lookup, no timer). When on, it checks GitHub's latest-release API daily, or a feed the user sets, and shows a notice with a link. It downloads nothing.
- **CI:**
  - `ci.yml` runs the same npm scripts as the local gates. `codeql.yml`, Dependabot and a draft-release `release.yml` were added, with every action pinned by SHA.
  - **Every step ran locally**, in a fresh clone (setup, typecheck, the whole `eslint .`, format, unit, `build:release`) and as the milestone gates (E2E, lifecycle, the installer). `release.yml`'s steps also ran, with `gh` stubbed.
- **The release script** (`npm run release -- <version>`) prepared **v0.1.0** locally:
  - the version commit, with an attested unit run;
  - an annotated, unsigned tag on 654e29e, never pushed;
  - the installer and its SHA-256;
  - a draft `docs/releases/v0.1.0.md`.
  - **Found by running it:** `veyra attest run` runs its command through `sh -c`, so the script now passes plain `node`.
- **Deviations:** none from the brief. CI has never run on GitHub (there is no remote), and clean-VM installs are the user's (the final checklist).

### M6.4

- **The memory benchmark** ([docs/benchmarks/memory.md](../benchmarks/memory.md)): the measurement Phase 3 couldn't finish, retried and finished at 10, 25, 50 and 100 tabs.
  - Unloading frees 33.7–34.2 MB per tab at every size, 3,385 MB with 99 of 100 tabs unloaded. Moving tabs to Sleeping alone frees nothing.
  - The laptop was under load, and the harness now records how loaded at each run's start: free memory, commit charge, processor load, the largest processes.
  - **The 100-tab size ran here** (about 3.8 GB live, with paging), though Phase 3 had expected it not to fit in 7.9 GB.
- **A user-facing README:** what Veltriva is, install and uninstall, what it does, privacy, accessibility, shortcuts, the benchmarks and the known limitations. The developer material moved to [docs/development.md](../development.md).
- **[docs/architecture/overview.md](../architecture/overview.md):** how v0.1.0 works, as built, pointing into the ADRs and the assessment. Writing it found five places where an ADR had drifted from the code; each is corrected.
- **Screenshots and GIFs** in `docs/images/`, generated by `npm run docs:images` from the test build on a demo web of pages written for the project, so the pictures can be redone when the shell changes.
- **The v0.1.0 release notes:** the "What's new" section of `docs/releases/v0.1.0.md`, with the measured numbers.
- **[docs/testing/final-manual-checklist.md](../testing/final-manual-checklist.md):** the one list for the user, merging the five phase checklists with Phase 6's checks. The brief's six required items are marked: the OAuth popup, JS dialogs, the installer by hand, clean VMs, the quiet-machine benchmark and code signing.
- **Deviations:**
  - §9.3's real-page corpus and dynamic sites aren't measured; they need pages and accounts the repository doesn't hold. The report says so.
  - Coverage isn't measured: no coverage provider is installed, so ADR-0008's 90% target is unenforced. Recorded in ADR-0008; a follow-up.
