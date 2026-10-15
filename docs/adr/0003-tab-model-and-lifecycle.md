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

## Consequences

- **Positive:** both product-critical states are first-class, the policy is unit-testable without Electron, and every automatic action can be explained.
- **Positive:** weekends and vacations never empty the workspace.
- **Negative:** more concepts than a single enum, so the UI must translate them into plain language.
- **Negative:** detecting unsaved work stays heuristic, because in-memory app state is invisible. Mitigations: conservative defaults, in-run page-state restore, Undo, and user protection.

## Alternatives considered

- **The brief's single linear state machine.** Rejected for the reasons in Context.
- **Wall-clock thresholds everywhere** (Arc's model). Rejected for visible changes; kept for discards.
- **CDP freezing as the main "sleep" mechanism.** Kept only as an off-by-default experiment: the protocol command is experimental, and the debugger detaches when DevTools opens.
