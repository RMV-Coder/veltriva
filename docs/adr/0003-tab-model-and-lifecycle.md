# ADR-0003: A four-dimension tab model, measured on an engagement clock

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | D2 |
| **Validated by** | [S1](../spikes/s1-view-lifecycle.md) (view lifecycle: confirmed); [S2](../spikes/s2-restore-fidelity.md) (restore fidelity: partly confirmed; restore order and page-state flush changed); [S3](../spikes/s3-unsaved-work-detection.md) (unsaved-work detection: confirmed; gating moved to `hasBeenActive`, probe timeout and trusted-input tracker added) |
| **Details** | Technical assessment Part 4 |

## Context

The brief proposed one state chain: `ACTIVE → IDLE → SLEEPING → ARCHIVED`, plus `RESTORING` and `ERROR`. That chain can't express two states the product needs:

- a tab hidden from the strip but still running, because it's protected;
- a tab shown in the strip but unloaded, which is every tab after a restart.

Wall-clock timers would also archive a user's workspace after a weekend away.

## Decision

1. **Each tab has four independent dimensions.**

   | Dimension | Values | Stored? |
   |---|---|---|
   | **Placement** | `strip`, `shelf`, `archive`, `closed` (UI: Tabs, Sleeping, Archive, Recently closed) | Persisted; user-visible |
   | **Runtime** | `unloaded`, `creating`, `live`, `frozen`, `discarding`, `crashed` | In memory only |
   | **Activity** | active, recent, idle, stale, dormant | Derived from timestamps |
   | **Protection** | A set of reasons, each hard or soft, each blocking specific actions | Derived on every evaluation |

2. **Invariants I1–I8** (assessment §4.5) are enforced by TabManager and asserted by model-based tests.

3. **The engagement clock.**
   - Visible changes (shelve, archive) use *engaged time* and *active days*. Both advance only while the user is actually using the computer.
   - Discards use wall-clock hidden time.

4. **Pure policy, one scheduler.**
   - `planLifecycle()` in `src/core/lifecycle` turns facts into actions, and each action names the rule that produced it.
   - A single 60-second scheduler executes them through per-tab serial queues, with rate limits.
   - Epochs make stale completions harmless.

5. **The discard procedure.**
   1. Re-validate the decision, thaw the tab if frozen, and run the isolated-world probe under a **hard timeout**. S3 saw a busy page delay the probe by about 680 ms. A timeout means "keep the tab".
   2. **Flush page state.** The probe also calls `history.replaceState(history.state, '')`, which makes Chromium commit fresh page state within about 10 ms instead of after about 1 s (visible) or 5 s (hidden) (spike S2). Ignore the `did-navigate-in-page` event this triggers.
   3. Snapshot `navigationHistory.getAllEntries()`. `pageState` stays in memory only.
   4. Close the tab. The probe's reading of `navigator.userActivation.hasBeenActive` decides how (spike S3). That flag resets on navigation and also flips when the user interacts inside an iframe, which our main-process input observers can't see.
      - **If it's true**, close with `waitForBeforeUnload`. `will-prevent-unload` is the decisive signal: if the page objects, the tab gains a protection instead. Remove the listener after each attempt.
      - **If it's false**, close directly. Electron's `close({ waitForBeforeUnload })` would first *grant* the page user activation, which lets untouched pages object too. A plain `close()` sends only `visibilitychange`, not `beforeunload`, `pagehide` or `unload`.
      - Veltriva never passes `userGesture: true` to scripts it runs in tabs, because that would forge activation.
   5. **Trusted-input tracker.** After each main-frame navigation, a passive listener in the probe's isolated world records trusted `input` and `change` events. The probe reads that record, which catches React-style inputs and edited `contenteditable` content that a `value`/focus check misses (S3). It holds no channel to main, and page scripts can't see it or forge trusted events.

6. **The restore procedure** (spike S2).
   - **Always restore into a brand-new view.** `restore()` only works on web contents that has never loaded anything. Any earlier load, even `about:blank`, makes it reject, and an un-awaited load corrupts the history.
   - **Attach the view before calling `restore()`.** If the tab isn't selected, attach it with `setVisible(false)`. Restoring into a detached view leaves the scroll position off by the display scale factor, and it never corrects itself.
   - **Validate persisted entries first.** Each URL must parse and pass the scheme allow-list, and each title must be a string. Omit `pageState` instead of storing `''`, which `restore()` rejects.
   - **Handle three failure shapes:**
     - A synchronous throw, or a rejection with no `did-fail-load`, is a creation failure: destroy the view and offer Retry with a new one.
     - A rejection after `did-fail-load` leaves the tab LIVE on an error page, with its history intact.
     - Don't use `did-finish-load` as the success signal: error pages emit it, and HTTP 404/500 responses resolve.
   - **Know what comes back.** Restores bring back the history stack, scroll position, and text, textarea, select and checkbox values. They don't bring back React-style controlled inputs or `contenteditable` content, so those cases stay protected rather than relying on recovery.

7. **Balanced-preset defaults are hypotheses**, tuned during dogfooding with a local regret metric:
   - discard hidden tabs after 60 min;
   - keep 10 unpinned tabs in the strip;
   - move extras to Sleeping after 2 engaged hours;
   - archive Sleeping tabs after 3 active days;
   - never discard pinned tabs;
   - freezing is an experiment, off by default.

8. **Explicit closes stay recoverable for 7 days.**

9. **As built in M1.3a** (live tabs only; the code is in `src/main/tabs`):
   - **The dimensions so far.**
     - Placement is always `strip`.
     - Runtime is `unloaded`, `creating`, `live` or `crashed`; `frozen` and `discarding` arrive with lifecycle automation in Phase 3.
     - Activity and protection aren't tracked yet.
   - **TabManager owns the strip.**
     - Ids are UUIDv7 (`src/core/id`), and pinned tabs come first.
     - A non-empty strip always has exactly one selected tab. Unit tests check this, including a 2,000-step random walk.
     - Closing the last tab opens a new one.
   - **One web contents per tab**, created with the `tab` role when the tab first loads a web page.
     - Internal pages (new tab, network error, crashed) have no web contents of their own: the tab's view is detached and the shell draws the page.
     - Only the selected tab's view is attached.
   - **Destruction stays explicit** (ADR-0002 §2): `removeChildView`, then `webContents.close()`, then drop every reference. When the window closes, its tabs are closed in the window's `closed` event, after the window is destroyed; LayoutManager then skips the detach, because touching the window would throw. A lifecycle check (ADR-0008, 4a) closes a window with live tabs and requires a clean, prompt exit.
   - **A crashed renderer** (`render-process-gone`) puts the tab in `crashed` and shows the crashed page. Reload restarts the renderer with `reload()`; we measured that this works after a crash.
   - **A failed load** (`did-fail-load`, except `ERR_ABORTED`) shows the network-error page with Chromium's error code and name, and clears the previous page's title and icon. A 404 is an ordinary commit.
   - **Stale events are ignored.** Each runtime carries a token, and events from a replaced runtime are dropped.

10. **As built in M1.3b** (TabManager, still without Electron imports):
    - **What the browser does to a page.**
      - **Find in page:** per tab, it ignores results from an older search and offers the last text again.
        - A new document closes the find bar, as in Chrome (a same-document navigation keeps it), and Ctrl+F reopens it with the same text.
        - Closing it also stops Chromium's find session. Without that, Chromium's find state carried over to the new page: there, the first search on a page with 2 matches reported 2 of 2. The E2E suite found this.
        - Chromium's own rule, kept as in Chrome: a new search whose first match is the current match moves on to the next one. Retyping the same word in another case therefore steps forward.
        - Unlike Chrome, a reload closes the bar too. That keeps the rule simple, and Ctrl+F brings the bar back.
      - **Zoom:** Chrome's preset steps. Chromium keeps zoom per host, so TabManager re-reads every tab's zoom after a change and after each commit.
      - **HTML fullscreen:** at most one tab, and always the selected one. A switch, close, crash or failed load ends it.
      - **DevTools.**
    - **Closed tabs can be reopened** (Ctrl+Shift+T): up to 25, in memory, by URL and place, without history. This is a stopgap until Phase 2's restore and the 7-day recoverable close (item 8).
    - **"Close other tabs" keeps pinned tabs**, as in Chrome: pinning is how the user says "keep this one". It is disabled when every other tab is pinned.
    - **Fullscreen counts as a hard protection** once the protection engine arrives (assessment §4.5). TabManager already tracks it.

11. **As built in M2.2a** (session restore; assessment §5.5, §5.7, §5.9):
    - **The `tabs` table is the live session.**
      - TabManager reports changes, and `src/main/session/session-store.ts` writes only the rows that changed.
      - It writes at most 1 s later, or 250 ms after a structural change (a tab opened, closed, moved, pinned or selected).
      - Each flush is one `session.save`, one transaction holding the rows, the deletions and the `session` and `window` documents. A hard kill therefore loses at most the last second, and never leaves half a flush.
    - **The persisted stack** (`src/core/session/history.ts`) holds URLs and titles only, at most 50 entries around the active one.
      - Only http:, https: and file: entries are kept, so a restore can never load veltriva:, javascript:, data: or another app's link.
      - Credentials are removed, and so is a fragment that carries a token (`#access_token=…`, `#/callback?code=…`).
      - Every stack is sanitized again when it is read back, because the file isn't trusted.
    - **Startup.**
      - The session is read before the window exists, within 10 s. If it can't be read, the app starts with a new tab and writes nothing, so the saved session survives.
      - The window opens at its saved place, if that is still on a screen.
      - Every tab comes back `unloaded`, and only the selected one is restored. Restores follow item 6: a brand-new web contents, attached before `restore()`, with the three failure shapes handled. A creation failure falls back to loading the address alone.
      - Another tab is restored when it is selected, and Reload restores an unloaded tab.
    - **Crashes.**
      - After a crash, a "Veltriva didn't close properly" notice says the tabs are back.
      - After two crashes in a row, each within 60 s of starting, the next start is in **safe mode** (`src/core/session/crash-loop.ts`). The tabs come back, none loads, and a notice explains it.
    - **Recently closed** (item 8).
      - A closed tab keeps its stack. Its row stays with placement `closed` and `closed_at`, and closed tabs older than 7 days are purged at startup.
      - Ctrl+Shift+T reopens the newest one, with its own id and stack, where it was. Up to 100 are reopenable per run, and the newest 100 are loaded at startup.
      - The schema allows a pin only in the strip, so a tab closed while pinned reopens unpinned after a restart.
    - **One instance per profile.** A second launch hands over to the first, which comes to the front, and quits.
      - Right after a hard kill, Windows can refuse Chromium's lock file for a moment ("Access is denied", seen in E2E). So a launch retries the lock for about 2 s before handing over; otherwise restarting after a crash would silently do nothing.
    - **Found by the tests and fixed:**
      - At 125% scaling, the window constructor rounded the size up, so the window grew on every restart. The saved bounds are now applied again with `setBounds`, which is exact.
      - A closed tab's place was lost on restart. Its row now keeps its strip index in `position`, so after a restart Ctrl+Shift+T puts it back where it was.
      - A restored tab's saved address and title are checked at restore, like any input. An address it may not load falls back to the stack's active entry, else the tab becomes a new-tab page.
      - A restored tab keeps its saved stack until its first commit.
    - **Shutdown.** The window's `closed` handler freezes the store before TabManager tears the tabs down; otherwise that would look like the user closing them all. The frozen state is written inside the 3 s cap (ADR-0004 item 8).
    - **Acceptance.** `tests/lifecycle/hard-kill.test.ts` runs 20 rounds on one profile. Each round is a launch that changes the session without pause, hard-killed at a seeded random moment, then a launch that reports what it restored.
      - The restored strip, Recently closed and selection must equal the state after the last acknowledged save, or the one in flight, rebuilt from the saves the churn printed.
      - Only the selected tab may be loaded.

12. **As built in M3.1** (the runtime dimension; assessment §4.3, §4.5, §4.9, §4.11):
    - **The state machine** is `src/core/lifecycle/runtime-machine.ts`, pure. TabManager asks it before every change, so an illegal transition throws. Every transition bumps the tab's **epoch**. The events, beyond §4.3's table:
      - `revive`: the tab is selected while its web contents is closing for a discard. It is `creating` at once (I2), and comes back as soon as the close settles: restored from the snapshot if the page closed, live again on the old web contents if it objected.
      - `internalPage`: a new-tab page replaces the web page, so the web contents is closed.
      - `gone`: the web contents was destroyed without TabManager asking. That is a discard's close that finished after TabManager stopped waiting, or anything else. The tab keeps what is known of its stack and is unloaded, like a discarded tab; a selected one restores at once.
      - `rendererGone` is also legal from `creating`: a renderer can die while a page loads.
    - **One serial queue per tab** (`src/core/lifecycle/serial-queue.ts`) runs `discard()` and `freeze()`. Each re-validates when its turn comes and again before its irreversible step (§4.11). A request may carry the epoch its decision saw; a later transition makes it `stale` (I5).
    - **The discard** (`TabManager.discard`, never rejects) answers `discarded`, `skipped` with why (`selected`, `loading`, `not-live`, `not-web`, `stale`, `cancelled`, `closed`, `no-history`) or `blocked` with the protection that kept the tab. Its steps:
      1. **Refuse** the selected tab, a loading one, one that isn't live or frozen, one on an error page (`not-web`: error pages aren't discarded in M3.1), and a stale decision. Then check the protections: the monitor's (M3.4) and, for automation, what an earlier attempt learned.
      2. **Thaw** a frozen page.
      3. **Wake, then probe.** The probe has the hard 100 ms budget of item 5, but it is preceded by a wake-up with a 5 s budget: the probe's dry run, without the flush. Measured on the reference laptop under load:
         - the first script call into a just-hidden tab took 0.9–2.5 s, and up to 3.1 s, even for a no-op;
         - after a no-op, the first probe still took 5–166 ms (compiling, and our world's view of the page's elements), against at most 32 ms for the second;
         - after the dry run, the probe took 3–59 ms (10 samples), and 4–14 ms in the discards that followed.

         Without the wake-up, most discards of a just-hidden tab ended "probe-unanswered" on this machine. No answer to either call still keeps the tab, for that attempt only.
      4. **The probe's verdict** (`src/core/lifecycle/probe.ts`):
         - Hard *unsaved input*: a field the trusted-input tracker saw the user type into that still holds text, or a changed field on a page the user activated. A changed field on an untouched page counts for nothing: typing activates a page, so the value came from the page's own script, or from a restore of its page state, which the next snapshot keeps again.
         - Soft *editing*: a focused `contenteditable`.
         - Soft *sensitive page*: password or payment fields.
         - Otherwise close with `beforeunload` if `hasBeenActive`, plainly if not.
      5. **The tracker** (`src/main/tabs/page-scripts.ts`) is installed on every `dom-ready` in world 1001, the same world as the probe. It keeps the 64 most recent fields with trusted `input` or `change` events, and a `contenteditable` host's text before its first `beforeinput`. So a search box the user typed into stays protected until the page navigates, as in Chrome. A field removed from the page no longer counts.
      6. **Snapshot**, then check again: not selected, not loading, unprotected, and the epoch is still the discard's own.
      7. **Close.** `will-prevent-unload` is never `preventDefault()`ed. An objection, or no close within 5 s, gives `page-unsaved-changes`.
    - **What a blocked attempt teaches.** `unsaved-input`, `page-unsaved-changes`, `editing` and `sensitive-page` are remembered for 30 minutes, or until the next cross-document commit. Automation doesn't ask the page again meanwhile; an explicit request always does.
    - **The flush's same-document commit** is dropped by the runtime (same URL, within 2 s), so it is neither a visit nor engagement.
    - **The snapshot** (`src/core/lifecycle/snapshot.ts`) passes the persisted stack's checks. An entry keeps Chromium's page state only if its URL came through them unchanged; above 256 KiB of page state per tab, only the active entry keeps its own. It lives in memory, is used once by the next restore if the tab's stack is still the same, and the session persists the stack without it.
    - **A renderer that dies mid-discard**, or a web contents that vanishes mid-probe, ends as a discard, with the entries Chromium still has, else the last stack reported.
    - **While a close is in flight,** what the user does to the tab (reload, navigate, back, a new-tab page) waits until the close settles. Closing the tab doesn't wait.
    - **Restore** (item 6) now also restores a discarded tab, with its page state.
      - A tab restored while not selected (Reload on an unloaded tab) is attached invisibly, under every view and sized like the content area, until its page stops loading. That avoids S2's scale-factor error. LayoutManager calls this `attachHidden`.
    - **Leaving fullscreen no longer passes `userGesture`.** It needs none, and the activation it granted would have told the discard that the user had been on the page (S3).
    - **Freezing** (experimental, off: nothing triggers it but a test hook) sends `Page.setWebLifecycleState` through `webContents.debugger`. A detach, such as DevTools taking the debugger, counts as thawed. A frozen tab that crashes is thawed first, so the next page isn't frozen. The model-based tests found that.
    - **Invariants as built.**
      - I2 allows `unloaded` for a selected tab that shows an internal page, and in safe mode until the user picks the tab (`lifecycleFacts().heldUnloaded`).
      - I1, I3 and I8 hold trivially until M3.3 adds the other placements.
      - I6: `create({ ephemeral: true })` exists, though no UI opens one. Such a tab, and a tab opened next to it (`afterTabId`), never reaches `sessionTabs()`, Recently closed or the history recorder, and the session's `#sessionTab` throws if one ever does.
    - **Tests.** `tab-manager-model.test.ts` runs random command sequences against fake runtimes. fast-check's scheduler releases their probes, closes, restores, loads and timers in random order, and I1–I8 are checked after every command and every released task. It runs:
      - 250 sequences on a fixed seed, which must reach every discard outcome and every transition;
      - 250 on a new seed each run;
      - three runs of exactly 10,000 commands, about 38,000 checks each.
      - Unit tests in `src/core/lifecycle` and `tab-manager-lifecycle.test.ts`.
      - E2E in `tests/e2e/lifecycle.spec.ts`, and harness checks in `tests/lifecycle/discard.test.ts` (ADR-0008 4a).
    - **Known limits.**
      - Closing a tab doesn't yet ask "Leave page?" for a page that objects (§4.9 *Close*); it closes at once, as in Phase 1.
      - The probe sees the top frame only (S3).
      - The tracker is blind to a page that stops `input` at the window in the capture phase before it is installed.

13. **As built in M3.2** (automation; assessment §4.6–§4.8):
    - **The engagement clock** (`src/core/lifecycle/engagement-clock.ts`, pure) follows §4.6.
      - Engaged time is measured on a monotonic clock, so changing the wall clock adds nothing. The wall clock only names the calendar day.
      - A step counts only if the previous sample found the user active and nothing suspended or locked the system since. One step adds at most 60 s.
      - Today's active-day index is 1 plus the earlier days that reached 10 minutes.
      - `src/main/lifecycle/engagement-sampler.ts` samples `powerMonitor.getSystemIdleState(300)` every 30 s, and on `suspend`, `resume`, `lock-screen` and `unlock-screen`. A resume samples first, then lets the scheduler re-evaluate.
      - It persists the `engagement` document in app_state every 5 minutes, on a new day, and at quit.
    - **Activity per tab** in TabManager.
      - A tab's last use is stamped by every clock when it is selected *and* when it is left. Hidden-since starts when it is left. The last input comes from the runtime's `interacted` event, at most once a second.
      - Last use is persisted in `tabs.last_used_engaged` and `last_used_active_day`. Phase 2 wrote 0 there, which reads as "now", as does any value from the future. Without that, an upgraded profile would look unused since the beginning of time; the first flush rewrites those rows once.
      - The selected tab's row keeps its stamp rather than "now", so a flush doesn't rewrite it every time.
    - **The policy** (`planLifecycle()`, `src/core/lifecycle/policy.ts`, pure) has §4.7's presets and rules. Every action names its rule and carries the epoch it saw.
      - The recent-interaction guard is a soft protection.
      - The selected tab always counts among the strip's kept tabs.
      - A tab gets at most one action.
      - Archiving a live tab whose discard is blocked isn't planned.
      - Under pressure, a tab must have been hidden 15 min (moderate) or 2 min (critical), and at most 1 or 3 are taken per evaluation, least recently used first. Critical overrides soft protections only.
      - Pause plans nothing.
    - **The scheduler** (`src/main/lifecycle/scheduler.ts`) follows §4.8.
      - It has one 60 s timer, plus triggers (a tab switch, a pressure change, a resume, the settings) that share one evaluation 1 s later.
      - Nothing runs in the first 2 minutes.
      - It starts at most 3 discards and 3 freezes per evaluation, 1 s apart, through TabManager's queues. Each request carries the action's epoch, so a stale one is refused (I5).
      - One evaluation runs at a time. A request made during one makes it run once more, and the caller waits for that re-run.
      - Every action is logged with its rule and result. An action planned but not carried out (`planned`, `rate-limited`) is logged only when it is new since the previous evaluation, so the log isn't flooded.
      - **Shelving and archiving are planned and logged, not carried out, until M3.3**, which adds the Sleeping and Archive sections. Otherwise tabs would vanish from the strip with nowhere to see them.
    - **Protections automation respects from M3.2** (`src/main/lifecycle/protection-signals.ts`):
      - audio, and for 2 minutes after (`audio-state-changed`, `isCurrentlyAudible()`; muted playback counts);
      - capture (`isBeingCaptured()`);
      - DevTools;
      - an open popup window (PopupWindows now remembers each popup's opener tab).

      Together with what discards learn, these keep automation from obvious harm before M3.4's monitor completes the table.
      - What a discard learned ages on the lifecycle clock, like everything automation compares.
      - **Capture is only `isBeingCaptured()` so far**: a page capturing the camera or the microphone with `getUserMedia` isn't seen yet. §4.10's "permission granted to the page" half comes with M3.4. Until then a call in a hidden tab is kept by its audio.
      - **The recent-interaction guard rarely bites with the shipped presets.** Only the shown tab takes input, and a tab's hidden time starts when it is left, so a tab hidden for 60 minutes was last touched at least 60 minutes ago. It matters for pressure discards under Gentle (a 30-minute guard against a 15-minute minimum) and for overrides with short times. It stays, as §4.10's safety net.
    - **Memory pressure** (`src/main/lifecycle/memory-pressure.ts`) polls `process.getSystemMemoryInfo()` every 10 s, and goes critical for 2 minutes when a renderer dies with `oom` or `memory-eviction` (`app`'s `render-process-gone`).
      - **Measured** on the reference laptop (i3-1215U, 7.9 GB, Windows 11) over 10 minutes while tests ran: Electron's `free` equalled Node's `os.freemem()` in every sample, and tracked the "Available MBytes" counter (`typeperf`), so on Windows it is *available* memory. `swapTotal` and `swapFree` are the commit limit and the commit left.
        - Available ran from 97 to 955 MB (median 632, 8%).
        - Commit was 22.8–24.3 GB of 31.7 GB.
        - Hard faults reached about 9,700 pages a second.
        - The script is `spikes/m3.2-memory-info/main.js` (from `spikes`: `electron m3.2-memory-info/main.js`, `MEMSAMPLE_SECONDS` sets the length); the readings are in `results.json` beside it.
      - **Levels**, as fractions of the total so they scale with other machines: *critical* under 4% (316 MB here), *moderate* under 10% (790 MB here). Rising needs 2 polls in a row; falling needs 2 points of margin.
      - On this laptop that means moderate most of the time: at most one discard per evaluation of a tab hidden 15 minutes or more. Given the measured paging, that is the intent. The thresholds are hypotheses to tune by dogfooding, like the presets.
    - **Settings.** The settings document has a `lifecycle` section: preset (Balanced), auto-archive (on), the freeze experiment (off), pause (off), and bounded overrides of each preset value. Each field falls back to its default alone. Nothing writes it until Phase 5; a test hook does.
    - **The accelerated clock** (`src/main/testing/test-clock.ts`) is test-only. It adds offsets to the wall clock, engaged time and active days that the lifecycle sees, and overrides the pressure. The hooks are `advanceLifecycleClock`, `lifecyclePlan`, `lifecycleEvaluate` (now, ignoring the quiet start), `lifecycleLog`, `setMemoryPressure` and `setLifecycleSettings`, all in the production check.
14. **As built in M3.3** (placement; assessment §4.4, §4.12, §4.13):
    - **The placement dimension** lives in TabManager (`src/core/lifecycle/placement.ts` has its types).
      - **Strip and Sleeping** tabs are live records: a Sleeping tab keeps its runtime, so it may still be loaded. Sleeping is a list, most recently moved first.
      - **An archived tab is data only** (I3): it has no record and no runtime. Archiving a loaded page runs the discard procedure first, so a page that objects keeps its tab where it is, and a crashed one has its runtime let go. Main keeps the newest 200 archived tabs in memory; the database keeps them all (ADR-0004 item 11).
      - **Closed** is as before: a Sleeping tab that is closed reopens at the end of the strip.
      - **Never pinned outside the strip** (I8): a pinned tab can't be shelved, pinning a Sleeping tab brings it to the strip first, and a restored session drops a pin from a Sleeping row.
      - **Restore puts a tab next to the current one** and selects it. Selecting a Sleeping tab restores it; so does `tabs.restore` from Sleeping or the Archive (an archived tab whose id is taken comes back under a new one).
      - **The user may move the selected tab**: the tab next to it is selected first, and the strip is never left empty.
    - **Automation moves tabs** (`src/main/lifecycle/scheduler.ts`). Shelving, and archiving a tab that isn't loaded, cost nothing, so they aren't limited or staggered. Archiving a loaded tab discards it, so it counts against the 3 discards per evaluation and is staggered like one. Automation re-validates at commit time, as for discards: never the selected tab, a busy one or a stale epoch, and nothing a protection blocks.
    - **User protection** is the hard protection `user-protected` ("Protect from automation" in the tab menu): automation never freezes, discards, shelves or archives the tab. The user's own moves still work.
    - **Undo** (`src/main/lifecycle/undo.ts`): one evaluation's moves are one batch, offered for undo for a minute; the user's own move to Sleeping or the Archive is offered the same way (§4.13: every move has an Undo). A newer batch replaces the offer. Undo puts each tab back where it was, unless the user moved it since, and **counts as using it**, so automation doesn't move it straight back. Discards and freezes aren't undoable: selecting the tab reloads it.
    - **The activity log** (`src/main/lifecycle/activity-log.ts`, §4.12): every automatic discard, freeze and move that took effect, with its rule, the memory pressure for a pressure discard (M3.4's "why" names it), the tab's title and address at the time, and its batch; and the undos of automation. Skips, blocks and rate limits change nothing and stay in the scheduler's own log. The newest 500 entries persist; a private tab's entries never do (I6).
    - **Why a tab is unloaded** is part of its state (`unloadedBy`: automation, memory pressure or the user), from a successful discard until it loads again, so its tooltip can say so (§4.13). A tab that hasn't loaded since the restart has none.
    - **"Leave page?"** (§4.9 Close): a user close (Ctrl+W, the close button, the tab menu) of a page the user activated asks the page (`beforeunload`). If it objects or doesn't answer within 5 s, the tab is selected and the toolbar asks "Leave <site>? Changes you made may not be saved." Leave closes it plainly; Stay keeps it. Closing it again while the question waits doesn't ask the page again. A page the user never activated closes at once, as Chromium's would (S3).
    - **Tests.**
      - The model test (`tab-manager-model.test.ts`) gained the placement commands (the user's and automation's shelve and archive, restore, Undo, protection, user closes with every answer to "Leave page?") and runs the policy's shelves and archives. I1, I3 and I8 are now checked for real after every step, with the strip never empty. The fixed seed runs 500 sequences: with the larger command pool, 250 no longer reached every transition. The three 10,000-command runs reach about 54,000 checks.
      - These tests found three bugs, fixed in M3.3: a Sleeping tab whose page objected to a close was selected out of sight (I1); "Protect from automation" also stopped the user's own archive or discard; and `move()` of a Sleeping tab cut the strip.
      - Unit tests: `tab-manager-placement.test.ts`, and the scheduler's, Undo's and the activity log's. E2E: `placement.spec.ts` (main's side through the commands), `placement-sidebar.spec.ts` (the sidebar), and `automation.spec.ts` (fifty tabs now go all the way to the Archive; Undo of an automated batch).
    - **Limits found.** "Archived today" counts the archived tabs main has in memory (the newest 200). Closing the window doesn't ask any page: the session keeps every tab, but not unsaved text. Drag between Sleeping and the strip isn't built; the menu and a click are.
15. **As built in M3.4** (the protection monitor, the "why", preview, the regret metric; assessment §4.10, §4.13):
    - **The protection table is complete** (`src/core/lifecycle/protections.ts`). New reasons:
      - `protected-site` (hard, blocks everything): the user's "Always protect ‹site›" in the tab menu. A site is the registrable domain of the page's host (`src/core/url/site.ts`; a host without one, such as localhost or an IP address, is its own site). The list is the settings document's `lifecycle.protectedSites`. The check reads the tab's address from TabManager, so it holds for an unloaded tab too.
      - `video` (hard, freeze and discard): a `<video>` or `<audio>` element of the page playing (not paused, not ended, with data), muted or not, **as the discard's probe finds it** at decision time, learned like unsaved input (`LEARNED_RECHECK_MS`, forgotten by a new document). The first build counted `media-started-playing` less `media-paused`, as §4.10 proposed; E2E showed that a page whose Web Audio context stays open, even silent, never gets `media-paused`, so the count stuck and kept such a tab forever (many sites keep one open). A muted element is never audible, so this protection, not the audio one, covers it; audible playback is the audio protection's, as in Chrome. **Top frame only**, like the other probe findings: main can't run isolated-world scripts in subframes, so a muted video playing inside a cross-origin iframe (an embedded player) isn't seen, and its tab can be unloaded. Audible playback anywhere in the page, frames included, is still protected, by the audio protection.
      - `capture` now has §4.10's second half: the permission broker reports a camera or microphone grant to a tab's page, which protects the tab until its next document (`did-navigate`) or its close, whatever `isBeingCaptured()` says later.
      - `fullscreen` (hard, everything): the tab TabManager has in HTML fullscreen.
      - `notifications` (soft, freeze and discard): the user allowed the page's origin to show notifications.
      - `background-activity` (soft, freeze and discard): a title or icon change while the tab has been hidden for at least 30 s (a page finishing its load in the background isn't activity) keeps it for 60 minutes after the last change; a new document forgets it.
      - Upload in progress stays a documented gap, and downloads need no protection (S7), as §4.10 says.
    - **The monitor watches each tab's web contents from its creation** (`ProtectionSignals.attach`, called by the tab runtime factory), so a sound or a grant before the first evaluation is seen. A change the sidebar shows (audio, capture, the end of the 2-minute audio grace) marks the snapshot dirty.
    - **The user's protection stops automation only**, as M3.3 fixed; a protected site likewise never stops the user's own moves.
    - **The "why" (§4.13).** Each tab's snapshot has `keptAwake`, the reasons observed now in one fixed order (`PROTECTION_REASONS`: what the user did first, then the page), and the sidebar says them in plain words ("Kept awake: playing audio"). It never claims a tab is safe, only what was observed. An unload says who did it and, for memory pressure, how low memory was (`unloadPressure`: "very low" for critical), carried from the scheduler's pressure in the discard request. A Sleeping tab says whether automation or the user moved it there (`movedBy`, this run only).
    - **Preview mode** (`isPreviewActive`, `PREVIEW_ACTIVE_DAYS` = 3). On the first 3 active days, by the engagement clock, the scheduler plans moves to Sleeping and the Archive but doesn't carry them out. It logs them `planned`, once each while they stay planned, and marks the tabs (`previewMove`), which the sidebar shows. Unloads and freezes go on: they change nothing the user sees but a reload, and memory pressure doesn't wait. On day 4, or when the user clicks "Start now" (settings `lifecycle.preview: 'off'`), the next evaluation carries the moves out in one batch, with its Undo.
    - **Pause automation** is a sidebar switch saved in the settings document (`lifecycle.paused`, which existed since M3.2); paused plans nothing.
    - **The regret metric** (`src/main/lifecycle/regret.ts`, §4.13): an automated move the user takes back within one engaged hour (a restore from Sleeping or the Archive, or an Undo) is a regret; separately, an automatic unload the user reloads within the hour. The counts and the newest 200 events are the `regret` app_state document; what automation last did to each tab is remembered in memory for the hour. The rates show only on the local diagnostics page (`veltriva://diagnostics`), with the engagement clock, the settings, the pressure and the memory automation sees. There is no telemetry.
    - **Limits found.**
      - Playing media is known only once a discard has asked the page, so the "why" names it after the first attempt, not before.
      - A muted video in a cross-origin iframe is not protected (top frame only, above); with its sound on, it is.
      - `background-activity` can't tell a chat's new message from any other title change while hidden; it is soft, so critical pressure gets past it.
      - The regret metric forgets pending moves at a restart (the totals persist), and doesn't count a tab restored under a new id.

16. **As built in M5.0: "Leave page?" for a navigation.**
   - **The problem, measured on Electron 45:** a page whose `beforeunload` objects used to stop the user's own navigation silently. Electron cancels the typed address, the reload, or back and forward with no dialog (`will-prevent-unload` left alone). The address stayed and nothing said why; only closing the tab asked (M3.3).
   - **The fix.** TabManager keeps each tab's last user navigation for 5 s, until a commit. The runtime reports an objection outside a close as `unloadBlocked`, and the selected tab is then asked the same "Leave page?" as for a close. Leave calls `allowNextUnload()` (the next `will-prevent-unload` is `preventDefault`ed, once) and repeats the navigation.
   - **Not asked:**
     - a background tab;
     - an objection while a question already waits;
     - a navigation the page started itself, such as a link in it. Its handler runs in the renderer before main hears of any navigation (*measured*), so there is nothing to repeat, and the page's objection stands, as before.

## Consequences

- **Positive:** both product-critical states are first-class, the policy is unit-testable without Electron, and every automatic action can be explained.
- **Positive:** weekends and vacations never empty the workspace.
- **Negative:** more concepts than a single enum, so the UI must translate them into plain language.
- **Negative:** detecting unsaved work stays heuristic, because in-memory app state is invisible. Mitigations: conservative defaults, in-run page-state restore, Undo, and user protection.

## Alternatives considered

- **The brief's single linear state machine.** Rejected for the reasons in Context.
- **Wall-clock thresholds everywhere** (Arc's model). Rejected for visible changes; kept for discards.
- **CDP freezing as the main "sleep" mechanism.** Kept only as an off-by-default experiment: the protocol command is experimental, and the debugger detaches when DevTools opens.
