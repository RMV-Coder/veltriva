# Phase 5 plan: settings, privacy and control

Pre-approved by the user on 2026-10-22, with Phases 2–6 ("make commits and merge when done … finish all phases"). The orchestrator reviews each milestone, re-runs the checks, scans with Veyra and merges. The user runs the manual checks once all phases are done.

**Sources of truth:**
- ADR-0002: trust zones and the web policy (dialogs, printing, site data, the log).
- ADR-0003: the tab model and lifecycle (presets, site rules, startup).
- ADR-0004: persistence and the data worker (migration 3, clearing data, the scroll document).
- ADR-0005: main is authoritative, Zod IPC (settings, privacy and diagnostics commands).
- ADR-0009: MVP product decisions (D5, the search engine chosen at first run).
- The technical assessment:
  - §5.7: retention, deletion, excluded sites;
  - §6.6: the privacy posture, diagnostic logging;
  - §7.2: the MVP feature list (Must and Should);
  - §8.2: the Phase 5 acceptance.

**Working rules:**
- One stacked branch per milestone, each started from the previous one's tip.
- Commits with Veyra (`--assisted-by`), never pushed or merged by the implementer.
- `veyra analyze --migration` output in the report whenever SQL changes (M5.1's migration 3).

**Status: done.** M5.0–M5.3 meet the acceptance below. Each is on its own stacked branch, reported in the orchestrator's shared notes.

## The milestones as planned

- **M5.0, the MVP gap audit.** Check every §7.2 Must and Should against main and write `docs/plans/mvp-gap-audit.md`.
  - **Checks in particular:** JS dialogs and `beforeunload` (safe and modal per tab), the file chooser, Print, Duplicate tab, the default search engine at first run, startup behavior, the dark theme, onboarding, per-tab memory, Pause memory, scroll restore.
  - **Small gaps** are fixed in M5.0; **large ones** go to M5.1–M5.3. About, licenses, the installer and the update notification are Phase 6's.
- **M5.1, the settings UI.**
  - **`veltriva://settings`**, drawn by the shell and backed by the Zod settings document: presets with plain descriptions, every advanced threshold, the search engine (DuckDuckGo by default, a template checked), startup behavior, Pause automation and Pause memory.
  - **Main validates** and rejects invalid values; the shell never writes the document. The rejections are unit-tested.
  - **Site rules (§5.3):** protect a site; exclude it from the memory (never recorded, never auto-archived, closing keeps no record). Reachable from Settings and from the tab menu.
- **M5.2, clear data and permissions.**
  - **Clear data (§5.7):** one entry, forget a site, or a time range. Each is one transaction, with the FTS triggers, `secure_delete` and FTS5 `secure-delete`, then `wal_checkpoint(TRUNCATE)` and `incremental_vacuum`. Optionally Chromium's cookies, cache and site storage, scoped where possible, and the UI says where they can't be.
  - **Deletion tests:** the rows go and the index has no hit; the database and WAL files shrink; a deleted page's unique word is absent from the file's raw bytes after a checkpoint.
  - **Permission management:** list, change and revoke stored decisions per site. **Retention:** N days, default 365.
- **M5.3, diagnostics and control polish.**
  - **The diagnostics page gains:** the regret rate (since M3.4), per-tab memory (`getAppMetrics` private bytes, S8), automation activity, pressure history, the database size and last backup, and an "export diagnostics" JSON with no URLs unless the user opts in.
  - **Diagnostic logging opt-in (§6.6):** URLs in logs only when on; logs rotate at 5 × 5 MB.
  - **The rest of the audit:** scroll restore across restarts, and the per-tab memory display.

## As built

Each milestone's full report (features, decisions, tests run, limitations) is in the orchestrator's shared notes. The design as built is recorded in:
- ADR-0002 items 12–14;
- ADR-0003 items 16–17;
- ADR-0004 items 13–15;
- ADR-0005 items 14–16;
- ADR-0009 item 5.

| Milestone | Branch, tip | Result |
|---|---|---|
| M5.0 | `claude/m5.0-gap-audit`, 002d546 | The gap audit; "Leave page?" for the user's own navigations; Ctrl+P and "Print…"; the README's known limitations |
| M5.1 | `claude/m5.1-settings`, 08cb065 | Settings and Welcome; a strict change schema; site rules in `site_rules` (migration 3); Pause memory; startup; the `excluded-site` protection |
| M5.2 | `claude/m5.2-privacy`, c2951a1 | `memory.forget` (one entry, a site, a range); Chromium data; Shift+Delete in the palette; site permissions; retention |
| M5.3 | `claude/m5.3-diagnostics`, 90dae30 (this wrap-up follows it) | Diagnostics: memory per tab, automation, pressure history, the database, the export; the log file with opt-in addresses; scroll restore across restarts |

### Deviations from the plan

- **M5.0: JS dialogs stay Electron's native ones**, recommended in M5.0 and accepted on review (2026-10-23). Measured on Electron 45:
  - `alert` and `confirm` disable the whole window and don't name the site, and `prompt()` returns null.
  - No Electron API replaces them: the DevTools protocol's dialog events never fire.
  - **The alternatives:** turning dialogs off breaks every `confirm`, and an in-page replacement breaks ADR-0002.
  - **So the limitation is stated:** in the README, ADR-0002 item 12, the assessment's threat T6 and §6.7, and the manual checks.
- **M5.0: "Leave page?" covers the user's own navigations, not a link inside the page.** For a link, Electron reports the objection before main hears of any navigation, so there is nothing to repeat; the page's objection stands, as before (measured).
- **M5.1: site rules moved to the `site_rules` table** (migration 3), out of M3.4's settings list, so protect and exclude live together as §5.3 has them.
- **M5.1: "Start with a new tab" archives the open tabs** instead of dropping them; pinned tabs stay.
- **M5.1: first run is a new profile**, and test builds show the welcome page only on request.
- **M5.2: the vacuum comes before the checkpoint.** §5.7 lists `wal_checkpoint(TRUNCATE)`, then `incremental_vacuum`. In that order, the vacuum's own writes stayed in the WAL (600 KB in the test), so it runs first.
- **M5.2: Chromium can't clear by time.** A range clears cookies, site data and the cache for all time, and the page says so. A site's cookies are matched by domain; its storage and cache by the origins Veltriva knows.
- **M5.3: per-tab memory is on the diagnostics page**, not in each tab's tooltip, since it needs a fresh `getAppMetrics` reading.
- **M5.3: scroll positions are an app_state document of their own**, not part of `restore_state`. Chromium's page state stays out of the database (ADR-0004 item 4).

### Phase 5 acceptance (assessment §8.2)

| Criterion | Evidence | Proved by |
|---|---|---|
| **Every automatic action is explainable and reversible from the UI** | **Explained:** each unload, move to Sleeping and archive has its rule in the activity log and the "why" in the tab's tooltip (M3.3–M3.4). The diagnostics page counts them and shows the pressure that caused them (M5.3).<br>**Reversed:** every move has Undo and one-click restore.<br>**Controlled:** Settings sets every value automation runs on and pauses it (M5.1). A site can be protected, or excluded from the memory, from the tab menu or Settings.<br>**Retention** is the one automatic deletion: its period is a setting (M5.2), and it is stated there. | `settings.spec.ts`, `diagnostics.spec.ts`, `placement.spec.ts`, `automation.spec.ts` |
| **Tests verify deletion: rows, index entries and file shrink** | **On a real file:**<br>• rows gone and no FTS hit, the integrity check passing;<br>• the database under half its size and the WAL at 0 bytes, with no free pages;<br>• a deleted page's unique word in neither file's raw bytes after the deletion's checkpoint.<br>**In the app:** "Everything" removes the archived and closed tabs' words from the profile database's raw bytes. | `src/data/repos/forget.test.ts`; `tests/e2e/privacy.spec.ts` |
| **Invalid settings are rejected** | **The strict change schema refuses** an unknown field, a wrong type, a value out of range or an unsafe template, and fails the whole change. The document a change makes is checked too (critical pressure below moderate).<br>**Main answers `invalid_input`** and keeps, writes and announces nothing: tested in the service, and in the app with changes sent straight to main. | `src/shared/contracts/settings.test.ts`; `src/main/settings/settings-service.test.ts`; `tests/e2e/settings.spec.ts` |

**The other gates**, per milestone (full numbers in each report):
- **M5.0:** static clean; unit 8,129/8,129; E2E 443/444. The one failure, `history.spec.ts:583`, is a hard-kill flake that predates Phase 5: it fails on main 4 times in 14 runs. Lifecycle 13/13, with the freeze timing test rerun alone after a run with other jobs. Packaging and a packaged launch were clean.
- **M5.1:** unit 8,312/8,313 and E2E 452/453; each failure was a stale test, fixed in 08cb065 and passing on rerun. Lifecycle 13/13. Packaging clean; the packaged launch ran migration 3.
- **M5.2:** unit 8,383/8,384 (a timeout, fixed in c2951a1) and E2E 457/459 (two load flakes, 2/2 each on rerun). Lifecycle 13/13. Packaging and a packaged launch were clean.
- **M5.3:** static clean; unit 8,420/8,420; E2E 463/463; lifecycle 13/13. Packaging and a packaged launch were clean.

## For Phase 6

- **Check each Electron release for a dialog-handler API** (ADR-0002 item 12). With one, `alert` and `confirm` could become per-tab questions that name the site.

## What only a person can check

The checklist is [docs/testing/phase-5-manual-checks.md](../testing/phase-5-manual-checks.md). It covers:
- Settings, Welcome and site rules on your own browsing;
- JS dialogs, "Leave page?" and Print on real sites;
- clearing data, and forgetting a site you're signed in to;
- the diagnostics page with heavy real pages, and its export;
- diagnostic logging;
- scroll restore across a restart;
- a screen reader on the new pages;
- the packaged build.
