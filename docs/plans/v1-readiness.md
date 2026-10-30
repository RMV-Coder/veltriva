# v1.0.0 readiness

**Checked on 2026-10-30**, against main at d1acda1 plus the four pull requests of the v1.0.0 engineering pass (listed below). The question is whether the MVP acceptance criteria of [the technical assessment §7.4](../architecture/technical-assessment.md#74-mvp-acceptance-criteria) are met, and what is still the owner's to do before `npm run release -- 1.0.0`.

**Verdict: not ready to tag yet, by design.** Five of the seven criteria are met by tests and measurements in the repository. Two can only be met by the owner: a week of real use (criterion 1) and clean Windows 10 and 11 installs (criterion 7). The final manual checklist and the code-signing decision come on top. Nothing in this pass bumps the version or tags anything.

**Status vocabulary:**
- **Met:** the evidence named in the row proves it, and it can be run again.
- **Met, with a stated gap:** met, except for one gap the row names, which the release notes state as a known limitation.
- **Needs the owner:** only a person can prove it, with real use, real machines or a decision. The engineering side is listed, so it is clear what the owner's check adds.

## The seven criteria (§7.4)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | With 100+ tabs over a week of real use, you never *need* to close a tab manually. The strip stays at its cap, except for tabs used recently. | **Needs the owner:** a week of real use | **Engineering side, met.** Automation carries out exactly what the policy plans. In a seeded 50-tab session on an accelerated clock, it discards the 10 planned tabs, 3 at a time; shelves exactly the 38 beyond the 10 most recently used (`shelve-beyond-cap`); then archives them after three active days. Pinned and selected tabs keep their pages. Proved by `tests/e2e/automation.spec.ts`, "exactly the actions the policy plans are carried out", and the presets test; see the [Phase 3 acceptance](phase-3-plan.md#phase-3-acceptance-assessment-82). **What the owner's week adds:** whether the Balanced defaults (unload after an hour, Sleeping after 2 hours of use, the Archive after 3 days) suit a real workload of 100+ tabs. `veltriva://diagnostics` shows the regret rate, the tabs taken back soon after automation moved them. |
| 2 | Every tab that left the strip can be found with a few partial words from its title, URL or site, and restored in one action. Search latency meets the targets in §5.4, or the targets are revised with measurements. | **Met** | `tests/e2e/memory.spec.ts`: an archived tab is found by a few partial words of its title, and Enter brings it back to the strip, selected, on its page. `src/data/repos/search-golden.test.ts`: 30 ranking expectations, in the unit suite. Latency ([docs/benchmarks/search.md](../benchmarks/search.md)), end to end through the app's own data RPC, median of 3 runs: p95 4.3 ms at 10,000 pages (target ≤ 30); at 50,000 pages, p95 10.3 ms (≤ 50), p99 12.8 ms (≤ 60) and a first search on a cold index of 25 ms (≤ 100). They were measured on the laptop under load. The quiet-machine re-run is in the final checklist (12.x). |
| 3 | No automated action ever touches a tab with a hard protection. Fixture tests cover every protection signal. | **Met, with a stated gap** | **Hard signals, each with a fixture test that runs the clock far ahead under critical pressure:** sound, camera or microphone capture, a page that objects to unloading, unsaved input, an open popup and open DevTools (`automation.spec.ts`, "audio, capture, …"). Playing media, muted or not (`protection.spec.ts`), and fullscreen. A protected tab or site, loaded or not, across a restart. **Soft signals**, which critical pressure overrides as designed: notifications, background activity, a recent interaction, a focused editor and a sensitive page (`automation.spec.ts`, `protection.spec.ts`). The discard's own checks are in `lifecycle.spec.ts` and `tests/lifecycle/discard.test.ts`. Model-based runs of 10,000 commands check the invariants I1–I8 after every step (`src/main/tabs/tab-manager-model.test.ts`). **The gap:** the discard's probe sees the top frame only, so a *muted* video in a cross-origin iframe isn't protected; with its sound on, it is (ADR-0003). The v1.0.0 release notes state it; the README's known limitations don't yet (see the follow-ups). |
| 4 | A hard kill at any moment loses at most about 2 s of changes. Relaunch restores the workspace and loads only the selected tab. | **Met** | `tests/lifecycle/hard-kill.test.ts`: 20 kills at random moments (0.3–5.3 s), on a profile that grows past 100 tabs. Each restores exactly the last saved session, or the save in flight at the kill, and only the selected tab loads. The session is saved 1 s after a change (250 ms for a structural one), within the 2 s. `tests/e2e/session.spec.ts`: "only the selected tab loads", and safe mode after two quick crashes. See the [Phase 2 acceptance](phase-2-plan.md). **Run again on Electron 45.1.0** in this pass (#12): the 20-kill restore passed in each of three lifecycle runs. Each run lost one *other* check to a pre-existing intermittent (see the follow-ups). |
| 5 | With 50 fixture tabs, "discarded" mode uses measurably less total private memory than "all live" mode. Numbers are published with their method; nothing is claimed before it is measured. | **Met** | [docs/benchmarks/memory.md](../benchmarks/memory.md), method §9.3, 5 of 5 measured runs at each size, raw files in `docs/benchmarks/data/`. At 50 tabs: **2,010 MB all live against 357 MB unloaded, 1,654 MB freed (33.8 MB per tab)**. Moving tabs to Sleeping without unloading them frees nothing (2,036 MB). It was measured with the laptop under load, and the load is recorded. A quiet-machine run is a Required item of the final checklist (12.4–12.7). |
| 6 | The security checklist passes, and the hostile-page fixture can't reach any Veltriva API. | **Met** | [docs/security/security-review.md](../security/security-review.md) (M6.1): every Part 6 item and threats T1–T16, each **Holds**, **Fixed** or a stated **Residual**, and nothing **Open**. The residuals are all in the README's known limitations. `tests/e2e/hostile.spec.ts`: a hostile page has no preload API and no Node; it can't navigate to `app://` or `veltriva://`, open windows, frame the shell or fetch `app://shell`; and it is denied every permission. `tests/e2e/ipc-sender.spec.ts`: a tab that sends IPC is answered "forbidden" whatever it sends, and events go to the shell only. Eight Veyra intents guard the security mechanisms, with `veyra.intentPolicy=block`. **Re-checked 2026-10-30:** `npm audit --omit=dev` finds 0 advisories. The full audit finds 7, all in build tools that don't ship (see below). Electron 45.1.0 brings Chromium 156.0.8078.49 and Node 24.22.1. |
| 7 | The installer works on clean Windows 10 and Windows 11 virtual machines. | **Needs the owner:** clean VMs | **On this machine, met:** `scripts/installer-test.ps1` runs install, launch, uninstall keeping the profile, reinstall, uninstall removing it, and both silent uninstalls (M6.3, with an upgrade from 0.0.0 to 0.1.0). **Run again on Electron 45.1.0** in this pass (#12): every step passed. That covers the install, its shortcuts with the AppUserModelID, the licenses and the fuses, three launches each exiting 0, both uninstall answers, and both silent uninstalls. **What the VMs add:** a Windows that has never seen Veltriva, Node or this repository; SmartScreen; and what a person sees in the dialogs, the Start menu and Settings ▸ Apps. That is section 14 of the final checklist. |

### The dependency audit, 2026-10-30

| Severity | Package (installed) | Comes from | Ships? |
|---|---|---|---|
| high | `zod` 3.25.76 (GHSA-mrhx-c7xc-m3w5, below 4.6.6) | the shadcn CLI (`shadcn`, `@shadcn/registry`) | **No.** The app bundles its own `zod` 4.6.7, outside the affected range. |
| high | `systeminformation` 5.33.15 | the shadcn CLI, through `@dotenvx/dotenvx` | No |
| high | `body-parser` 2.3.0 | the shadcn CLI, through `@modelcontextprotocol/sdk` and express | No |
| high | `shadcn`, `@shadcn/registry` | the chain above | No: only one CSS file from `shadcn` ships |
| moderate | `fast-uri` 3.1.8 | electron-builder, through `ajv` (packaging time) | No |
| low | `deepmerge` 4.3.1 | the shadcn CLI | No |

The list of what ships is `THIRD_PARTY_NOTICES.txt`, generated from what the build bundled. shadcn 4.23.0 clears `shadcn`, `@shadcn/registry`, `zod` 3 and `deepmerge`. Dependabot hasn't offered it yet, because its limit of five open npm pull requests was full (see the follow-ups). `systeminformation`, `body-parser` and `fast-uri` have fixed versions within their ranges (`npm audit fix`, lockfile only).

## What only the owner can do

1. **A week of real use** with 100+ tabs (criterion 1). Watch the regret rate and Activity, and note any tab you had to close by hand.
2. **The final manual checklist,** [docs/testing/final-manual-checklist.md](../testing/final-manual-checklist.md), with its six **Required** items:
   - the OAuth popup on a real site (4.4–4.6);
   - the JS dialogs (9.1–9.3);
   - installing and uninstalling by hand (sections 1 and 13);
   - clean Windows 10 and 11 VMs (section 14, criterion 7);
   - the memory benchmark on a quiet machine (12.4–12.7);
   - code signing (15.1).
3. **Code signing,** your decision (ADR-0007 item 5, [docs/distribution/signing.md](../distribution/signing.md)). Unsigned is a valid v1.0.0, stated in the release notes; signing changes the release workflow and costs money.
4. **Each merge and the release itself:** merging the pull requests below, `npm run release -- 1.0.0 --notes-range HEAD`, and pushing the tag and publishing the draft release. The release script pushes nothing.

## This engineering pass (2026-10-30)

Each needs the owner's OK to merge, and CI green first. Merge #12 before #14, which is stacked on it.

| Pull request | What | Local gates |
|---|---|---|
| [#12](https://github.com/RMV-Coder/veltriva/pull/12) | Electron 45.0.0 → 45.1.0: Chromium 156.0.8078.49, Node 24.22.1; the zip's SHA-256 checked; recorded in ADR-0001 | **Clean:** typecheck, lint, format, unit 8,620/8,620 with coverage. **E2E 483/485:** the About spec failed on the stale notices, fixed in #12 and then 6/6; the other failure is the drag intermittent, fixed in #13. **Lifecycle 12/13** in each of three runs: the 20-kill restore always passed, and the failure each time was a pre-existing intermittent. **Packaging:** `package:dir` with the fuse read-back, a packaged launch, `package:installer` and `installer-test.ps1`, all passed. |
| [#14](https://github.com/RMV-Coder/veltriva/pull/14) | All seven Dependabot updates folded (#5–#11), the notices regenerated, the CodeQL actions grouped. Stacked on #12 | **Clean:** typecheck, lint, format, unit 8,620/8,620 with coverage. **E2E 484/485:** the one failure was the drag intermittent that #13 fixes. **Lifecycle 10/13:** the three misses all depend on window visibility, the same environmental intermittent as above. Alone they passed 4/4, then 3/4. **Packaging, with electron-builder 26.18.0:** `package:dir` with the fuse read-back, a packaged launch, `package:installer` and `installer-test.ps1`, all passed. |
| [#13](https://github.com/RMV-Coder/veltriva/pull/13) | `tabs.spec.ts`: the drag-reorder test waits for the shell's pin and drag state, not the clock | **Before the fix,** on main: 3/15 runs passed. **After:** 15/15 with `--repeat-each`, and 15/15 as separate runs. `tabs.spec` and `session.spec` 27/27; the automation presets test 1/1. |
| This one | Release notes grouped by feature area; the v1.0.0 draft; this file | Clean: typecheck, lint, format, and unit 8,663/8,663 with coverage, including the 43 new release-notes tests. |

## Follow-ups before `npm run release -- 1.0.0`

- **The README** still says "version 0.1.0" and "the repository has no remote", though the repository has been public since 2026-10-29. It also says to leave the update notice off "until releases are published". Update all three with the version bump.
- **The README's known limitations** should gain the cross-origin iframe gap of criterion 3, as the v1.0.0 release notes have.
- **The v1.0.0 draft's "Since the v0.1.0 preview"** names Electron 45.1.0 and the dependency updates. That assumes #12 and #14 are merged; edit it if either isn't.
- **The local `v0.1.0` tag** (654e29e) was never pushed. Push it or delete it, as you choose. The release notes use `--notes-range HEAD` either way, because v0.1.0 was never published.
- **An upgrade test from 0.1.0:** `scripts/installer-test.ps1 -Upgrade` with the v1.0.0 installer over a v0.1.0 install. M6.3 tested 0.0.0 → 0.1.0.
- **shadcn 4.23.0** (dev only), once Dependabot offers it, or by hand. It clears four of the seven advisories above.
- **The JS-dialog API:** Electron 45.1.0's notes add no dialog handler, so ADR-0002 item 12's decision (native dialogs for v1.0) stands. Re-check it with each Electron release.
- **A lifecycle-harness intermittent.** On this laptop on 2026-10-30, the full lifecycle suite lost one check in each of three runs, a different one each time, and each passed 3/3 alone.
  - **Twice, typed text never arrived:** in `discard.test.ts`, a `sendInputEvent` click didn't focus the field, so the typing didn't land ("Typing … did not arrive in 8 attempts").
  - **Once, a selected tab reported `hidden`:** in `background-tab.test.ts`, where the test expects `visible`.

  The typing failure reproduced on Electron 45.0.0 too (1 run in 4 of `discard.test.ts` alone), so it predates #12. Both are likely the desktop's focus or occlusion state, with other windows in use. On #14's branch, three such misses came in one run: the freeze experiment, a page under the palette, and the selected tab. It wants the same treatment as the drag test: find the state to wait for, then prove it with repeated runs. Not a release blocker: GitHub's runner passed the suite 13/13 on #12.
- **Unit tests that time out on GitHub's runner.** Two first CI runs on 2026-10-30 each lost a `src/data` test to vitest's 5-second default:
  - on #13, two tests in `integrity.test.ts`;
  - on #14, one in `search.test.ts`.

  Both build SQLite databases, and neither pull request touches them; reruns were requested. A `testTimeout` for the data tests, or faster fixtures, would end it.
