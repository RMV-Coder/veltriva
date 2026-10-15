# ADR-0003: A four-dimension tab model, measured on an engagement clock

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Implements** | D2 |
| **Validated by** | Spikes S1 (view lifecycle), S2 (restore fidelity), S3 (unsaved-work detection) |
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
   1. Re-validate the decision, thaw the tab if frozen, and run the isolated-world probe.
   2. Snapshot `navigationHistory.getAllEntries()`. `pageState` stays in memory only.
   3. Close the tab:
      - **Tabs that had real input since their last navigation** close with `waitForBeforeUnload`. If the page objects, the tab gains a protection instead.
      - **Untouched tabs** close directly, because Electron's `close()` grants user activation before `beforeunload`.

   Restore calls `navigationHistory.restore()` before any `loadURL`.

6. **Balanced-preset defaults are hypotheses**, tuned during dogfooding with a local regret metric:
   - discard hidden tabs after 60 min;
   - keep 10 unpinned tabs in the strip;
   - move extras to Sleeping after 2 engaged hours;
   - archive Sleeping tabs after 3 active days;
   - never discard pinned tabs;
   - freezing is an experiment, off by default.

7. **Explicit closes stay recoverable for 7 days.**

## Consequences

- **Positive:** both product-critical states are first-class, the policy is unit-testable without Electron, and every automatic action can be explained.
- **Positive:** weekends and vacations never empty the workspace.
- **Negative:** more concepts than a single enum, so the UI must translate them into plain language.
- **Negative:** detecting unsaved work stays heuristic, because in-memory app state is invisible. Mitigations: conservative defaults, in-run page-state restore, Undo, and user protection.

## Alternatives considered

- **The brief's single linear state machine.** Rejected for the reasons in Context.
- **Wall-clock thresholds everywhere** (Arc's model). Rejected for visible changes; kept for discards.
- **CDP freezing as the main "sleep" mechanism.** Kept only as an off-by-default experiment: the protocol command is experimental, and the debugger detaches when DevTools opens.
