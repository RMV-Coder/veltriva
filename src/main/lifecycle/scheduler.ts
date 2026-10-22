// The lifecycle scheduler (assessment §4.8): one timer for the whole browser. It evaluates the
// policy (core/lifecycle/policy.ts) every 60 s and on events (a tab hidden, settings changed, the
// pressure level changed, the system resumed), and carries out what it plans through TabManager's
// per-tab queues, which re-validate everything at commit time (§4.11).
//   - Quiet start: nothing happens in the first 2 minutes, while the restored session settles.
//   - At most 3 discards (and 3 freezes) per evaluation, started about 1 s apart, so automation
//     never causes jank.
//   - One evaluation at a time; one asked for meanwhile runs right after.
//   - Archiving a live tab discards it, so it counts against the same limit and the same stagger.
//     Shelving, and archiving a tab that isn't loaded, cost nothing and aren't limited.
//   - Every planned action is logged with the rule that produced it and what came of it.
//   - The tabs one evaluation moved (to Sleeping or the Archive) are one batch, which the user
//     can undo (M3.3).
import type { DiscardOutcome, DiscardRequest, Timers } from '../../core/lifecycle/discard';
import type { MoveOutcome, MoveRequest, PlacementMove } from '../../core/lifecycle/placement';
import { planLifecycle } from '../../core/lifecycle/policy';
import type {
  LifecycleAction,
  LifecycleClock,
  LifecycleSettings,
  MemoryPressure,
  TabFacts,
} from '../../core/lifecycle/policy';
import type { RuntimeState } from '../../core/lifecycle/runtime-machine';
import type { Logger } from '../platform/logger';
import type { FreezeOutcome, TabId } from '../tabs/tab-manager';

export const TICK_MS = 60_000;
export const QUIET_START_MS = 2 * 60_000;
export const MAX_DISCARDS_PER_EVALUATION = 3;
export const MAX_FREEZES_PER_EVALUATION = 3;
export const STAGGER_MS = 1000;
/** Events come in bursts (a tab switch, then another): they share one evaluation. */
export const TRIGGER_DELAY_MS = 1000;
/** The in-memory log keeps the newest actions. */
export const LOG_SIZE = 500;

/** What came of a planned action. */
export type ActionResult =
  | DiscardOutcome
  | FreezeOutcome
  | MoveOutcome
  /** Over the evaluation's limit: the next evaluation plans it again if it still applies. */
  | { readonly outcome: 'rate-limited' }
  /** Planned only, not carried out (M3.4's preview mode). */
  | { readonly outcome: 'planned' }
  /** Automation was paused before its turn came. */
  | { readonly outcome: 'paused' };

export interface ActionRecord extends LifecycleAction {
  /** Wall-clock time of the evaluation that planned it. */
  readonly at: number;
  /** The evaluation's batch: the moves it made are undone together. */
  readonly batchId: string;
  /** The memory pressure when it was planned: the "why" names it (M3.4). */
  readonly pressure: MemoryPressure;
  readonly result: ActionResult;
}

/** The tabs one evaluation moved, in the order it moved them. */
export interface MoveBatch {
  readonly id: string;
  readonly at: number;
  readonly moves: readonly PlacementMove[];
}

export interface SchedulerTabs {
  lifecycleTabs(): TabFacts[];
  discard(tabId: TabId, request: DiscardRequest): Promise<DiscardOutcome>;
  freeze(tabId: TabId): Promise<FreezeOutcome>;
  shelve(tabId: TabId, request: MoveRequest): MoveOutcome;
  archive(tabId: TabId, request: MoveRequest): Promise<MoveOutcome>;
}

export interface LifecycleSchedulerOptions {
  readonly tabs: SchedulerTabs;
  readonly settings: () => LifecycleSettings;
  readonly clock: () => LifecycleClock;
  readonly pressure: () => MemoryPressure;
  readonly timers: Timers;
  readonly logger: Logger;
  /** Each action once it has a result (the activity log, M3.3). */
  readonly onAction?: (record: ActionRecord) => void;
  /** The tabs an evaluation moved, once all its actions have settled (Undo, M3.3). */
  readonly onBatch?: (batch: MoveBatch) => void;
}

/** One evaluation, as its actions are carried out. */
interface Batch {
  readonly id: string;
  readonly at: number;
  readonly pressure: MemoryPressure;
  readonly moves: PlacementMove[];
}

function recordOf(action: LifecycleAction, batch: Batch, result: ActionResult): ActionRecord {
  return { ...action, at: batch.at, batchId: batch.id, pressure: batch.pressure, result };
}

/** Archiving a tab in one of these discards its page first: that costs what a discard does. */
function archiveDiscards(runtime: RuntimeState | undefined): boolean {
  return runtime === 'live' || runtime === 'frozen';
}

export class LifecycleScheduler {
  readonly #options: LifecycleSchedulerOptions;
  readonly #log: ActionRecord[] = [];
  #tickTimer: unknown;
  #triggerTimer: unknown;
  #quiet = true;
  #running: Promise<void> | null = null;
  #again = false;
  /** The actions the last evaluation left over its limits, so each is logged once. */
  #plannedBefore = new Set<string>();
  #stopped = false;
  #evaluations = 0;

  constructor(options: LifecycleSchedulerOptions) {
    this.#options = options;
  }

  /** Starts the timer. The first evaluation comes after the quiet start. */
  start(): void {
    this.#tickTimer = this.#options.timers.setTimeout(() => {
      this.#quiet = false;
      this.#tick();
    }, QUIET_START_MS);
  }

  /** Stops everything (shutdown, §4.11 item 5). Operations already handed to TabManager finish. */
  stop(): void {
    this.#stopped = true;
    for (const timer of [this.#tickTimer, this.#triggerTimer]) {
      if (timer !== undefined) {
        this.#options.timers.clearTimeout(timer);
      }
    }
    this.#tickTimer = undefined;
    this.#triggerTimer = undefined;
  }

  /**
   * Something changed that may call for action (a tab hidden, the settings, the pressure level,
   * the system resumed): evaluate soon, but not during the quiet start.
   */
  trigger(): void {
    if (this.#stopped || this.#quiet || this.#triggerTimer !== undefined) {
      return;
    }
    this.#triggerTimer = this.#options.timers.setTimeout(() => {
      this.#triggerTimer = undefined;
      void this.evaluate();
    }, TRIGGER_DELAY_MS);
  }

  /** The actions the policy calls for now, without carrying any out. */
  plan(): LifecycleAction[] {
    return this.#planFor(this.#options.tabs.lifecycleTabs());
  }

  #planFor(tabs: TabFacts[]): LifecycleAction[] {
    return planLifecycle({
      tabs,
      settings: this.#options.settings(),
      clock: this.#options.clock(),
      pressure: this.#options.pressure(),
    });
  }

  /** The newest actions, oldest first. */
  log(): readonly ActionRecord[] {
    return [...this.#log];
  }

  /**
   * Evaluates and carries out what the policy plans. Resolves when every operation it started
   * has settled. Never rejects. If one is under way, this one runs right after it.
   */
  evaluate(): Promise<void> {
    if (this.#stopped) {
      return Promise.resolve();
    }
    if (this.#running !== null) {
      // The evaluation under way runs once more when it ends; this resolves after that, so every
      // caller waits for an evaluation that started after its request (found by E2E).
      this.#again = true;
      return this.#running;
    }
    const running = this.#loop().finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  /** Evaluations back to back while one was asked for during the last. */
  async #loop(): Promise<void> {
    do {
      this.#again = false;
      await this.#run();
      // Read again after the await: stop() may have run meanwhile.
    } while (this.#againRequested() && !this.#isStopped());
  }

  // Read through methods: both change during the awaits above.
  #againRequested(): boolean {
    return this.#again;
  }

  #isStopped(): boolean {
    return this.#stopped;
  }

  #tick(): void {
    if (this.#stopped) {
      return;
    }
    void this.evaluate().finally(() => {
      if (!this.#stopped) {
        this.#tickTimer = this.#options.timers.setTimeout(() => {
          this.#tick();
        }, TICK_MS);
      }
    });
  }

  async #run(): Promise<void> {
    let actions: LifecycleAction[];
    let runtimes: Map<string, RuntimeState>;
    try {
      const tabs = this.#options.tabs.lifecycleTabs();
      runtimes = new Map(tabs.map((tab) => [tab.id, tab.runtime]));
      actions = this.#planFor(tabs);
    } catch {
      this.#options.logger.error('lifecycle.planFailed');
      return;
    }
    const at = this.#options.clock().wallNow;
    this.#evaluations += 1;
    const batch: Batch = {
      id: `batch-${String(this.#evaluations)}`,
      at,
      pressure: this.#options.pressure(),
      moves: [],
    };
    const started: Promise<void>[] = [];
    let discards = 0;
    let freezes = 0;
    // What this evaluation left over its limits: logged only when new (no log spam).
    const planned = new Set<string>();
    for (const action of actions) {
      if (this.#stopped) {
        break;
      }
      // Shelving, and archiving a tab that isn't loaded, free nothing and cost nothing.
      const free =
        action.kind === 'shelve' ||
        (action.kind === 'archive' && !archiveDiscards(runtimes.get(action.tabId)));
      if (free) {
        if (this.#options.settings().paused) {
          this.#record(recordOf(action, batch, { outcome: 'paused' }));
          continue;
        }
        started.push(this.#carryOut(action, batch));
        continue;
      }
      const isDiscard = action.kind !== 'freeze';
      const count = isDiscard ? discards : freezes;
      const limit = isDiscard ? MAX_DISCARDS_PER_EVALUATION : MAX_FREEZES_PER_EVALUATION;
      if (count >= limit) {
        const key = `limited:${action.kind}:${action.tabId}`;
        planned.add(key);
        if (!this.#plannedBefore.has(key)) {
          this.#record(recordOf(action, batch, { outcome: 'rate-limited' }));
        }
        continue;
      }
      if (discards + freezes > 0) {
        await this.#wait(STAGGER_MS);
        // stop() may have run during the wait: nothing new starts after it (found by tests).
        if (this.#isStopped()) {
          break;
        }
      }
      if (this.#options.settings().paused) {
        this.#record(recordOf(action, batch, { outcome: 'paused' }));
        continue;
      }
      if (isDiscard) {
        discards += 1;
      } else {
        freezes += 1;
      }
      started.push(this.#carryOut(action, batch));
    }
    this.#plannedBefore = planned;
    await Promise.all(started);
    // After stop() (shutdown) nobody can undo anything: the batch isn't offered.
    if (batch.moves.length > 0 && !this.#isStopped()) {
      try {
        this.#options.onBatch?.({ id: batch.id, at: batch.at, moves: [...batch.moves] });
      } catch {
        // A listener's bug must not make an evaluation reject.
        this.#options.logger.error('lifecycle.onBatchFailed');
      }
    }
  }

  async #carryOut(action: LifecycleAction, batch: Batch): Promise<void> {
    const tabs = this.#options.tabs;
    const move: MoveRequest = { origin: 'automation', epoch: action.epoch };
    let result: ActionResult;
    try {
      switch (action.kind) {
        case 'discard':
          result = await tabs.discard(action.tabId, {
            origin: action.rule === 'pressure-discard' ? 'pressure' : 'automation',
            epoch: action.epoch,
            overrideSoft: action.overrideSoft,
          });
          break;
        case 'freeze':
          result = await tabs.freeze(action.tabId);
          break;
        case 'shelve':
          result = tabs.shelve(action.tabId, move);
          break;
        case 'archive':
          result = await tabs.archive(action.tabId, move);
          break;
      }
    } catch {
      // TabManager never rejects; a bug here must not stop the scheduler.
      this.#options.logger.error('lifecycle.actionFailed', { kind: action.kind });
      return;
    }
    if (result.outcome === 'moved') {
      batch.moves.push(result.move);
    }
    this.#record(recordOf(action, batch, result));
  }

  #record(record: ActionRecord): void {
    this.#log.push(record);
    if (this.#log.length > LOG_SIZE) {
      this.#log.shift();
    }
    try {
      this.#options.onAction?.(record);
    } catch {
      // A listener's bug must not make an evaluation reject (found by tests).
      this.#options.logger.error('lifecycle.onActionFailed');
    }
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#options.timers.setTimeout(resolve, ms);
    });
  }
}
