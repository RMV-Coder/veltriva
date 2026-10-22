// The lifecycle scheduler (assessment §4.8): one timer for the whole browser. It evaluates the
// policy (core/lifecycle/policy.ts) every 60 s and on events (a tab hidden, settings changed, the
// pressure level changed, the system resumed), and carries out what it plans through TabManager's
// per-tab queues, which re-validate everything at commit time (§4.11).
//   - Quiet start: nothing happens in the first 2 minutes, while the restored session settles.
//   - At most 3 discards (and 3 freezes) per evaluation, started about 1 s apart, so automation
//     never causes jank.
//   - One evaluation at a time; one asked for meanwhile runs right after.
//   - Every planned action is logged with the rule that produced it and what came of it.
// M3.2 carries out discards and freezes. Shelving and archiving are planned and logged, and are
// carried out from M3.3 on, together with the Sleeping and Archive sections that show them.
import type { DiscardOutcome, DiscardRequest, Timers } from '../../core/lifecycle/discard';
import { planLifecycle } from '../../core/lifecycle/policy';
import type {
  LifecycleAction,
  LifecycleClock,
  LifecycleSettings,
  MemoryPressure,
  TabFacts,
} from '../../core/lifecycle/policy';
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
  /** Over the evaluation's limit: the next evaluation plans it again if it still applies. */
  | { readonly outcome: 'rate-limited' }
  /** Planned only: shelving and archiving are carried out from M3.3 on. */
  | { readonly outcome: 'planned' }
  /** Automation was paused before its turn came. */
  | { readonly outcome: 'paused' };

export interface ActionRecord extends LifecycleAction {
  /** Wall-clock time of the evaluation that planned it. */
  readonly at: number;
  readonly result: ActionResult;
}

export interface SchedulerTabs {
  lifecycleTabs(): TabFacts[];
  discard(tabId: TabId, request: DiscardRequest): Promise<DiscardOutcome>;
  freeze(tabId: TabId): Promise<FreezeOutcome>;
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
}

export class LifecycleScheduler {
  readonly #options: LifecycleSchedulerOptions;
  readonly #log: ActionRecord[] = [];
  #tickTimer: unknown;
  #triggerTimer: unknown;
  #quiet = true;
  #running: Promise<void> | null = null;
  #again = false;
  /** The shelves and archives the last evaluation planned, so each is logged once. */
  #plannedBefore = new Set<string>();
  #stopped = false;

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
    return planLifecycle({
      tabs: this.#options.tabs.lifecycleTabs(),
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
  async evaluate(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    if (this.#running !== null) {
      this.#again = true;
      await this.#running;
      return;
    }
    const running = this.#run().finally(() => {
      this.#running = null;
    });
    this.#running = running;
    await running;
    // Read again after the await: stop() may have run meanwhile.
    if (this.#again && !this.#isStopped()) {
      this.#again = false;
      await this.evaluate();
    }
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
    try {
      actions = this.plan();
    } catch {
      this.#options.logger.error('lifecycle.planFailed');
      return;
    }
    const at = this.#options.clock().wallNow;
    const started: Promise<void>[] = [];
    let discards = 0;
    let freezes = 0;
    const planned = new Set<string>();
    for (const action of actions) {
      if (this.#stopped) {
        break;
      }
      if (action.kind === 'shelve' || action.kind === 'archive') {
        const key = `${action.kind}:${action.tabId}`;
        planned.add(key);
        if (!this.#plannedBefore.has(key)) {
          this.#record({ ...action, at, result: { outcome: 'planned' } });
        }
        continue;
      }
      const isDiscard = action.kind === 'discard';
      const count = isDiscard ? discards : freezes;
      const limit = isDiscard ? MAX_DISCARDS_PER_EVALUATION : MAX_FREEZES_PER_EVALUATION;
      if (count >= limit) {
        this.#record({ ...action, at, result: { outcome: 'rate-limited' } });
        continue;
      }
      if (discards + freezes > 0) {
        await this.#wait(STAGGER_MS);
      }
      if (this.#options.settings().paused) {
        this.#record({ ...action, at, result: { outcome: 'paused' } });
        continue;
      }
      if (isDiscard) {
        discards += 1;
      } else {
        freezes += 1;
      }
      started.push(this.#carryOut(action, at));
    }
    this.#plannedBefore = planned;
    await Promise.all(started);
  }

  async #carryOut(action: LifecycleAction, at: number): Promise<void> {
    let result: ActionResult;
    try {
      result =
        action.kind === 'discard'
          ? await this.#options.tabs.discard(action.tabId, {
              origin: action.rule === 'pressure-discard' ? 'pressure' : 'automation',
              epoch: action.epoch,
              overrideSoft: action.overrideSoft,
            })
          : await this.#options.tabs.freeze(action.tabId);
    } catch {
      // TabManager never rejects; a bug here must not stop the scheduler.
      this.#options.logger.error('lifecycle.actionFailed', { kind: action.kind });
      return;
    }
    this.#record({ ...action, at, result });
  }

  #record(record: ActionRecord): void {
    this.#log.push(record);
    if (this.#log.length > LOG_SIZE) {
      this.#log.shift();
    }
    this.#options.onAction?.(record);
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#options.timers.setTimeout(resolve, ms);
    });
  }
}
