// The regret metric (assessment §4.13): when the user brings a tab back within one engaged hour of
// automation moving it (to Sleeping or the Archive), that is a regret event; undoing an automated
// batch is one too, the plainest. The rate, regrets per automated move, is the metric for tuning
// the defaults while dogfooding. Automatic unloads are counted apart: a tab the user selects
// within an engaged hour of automation or memory pressure unloading it reloads, which is a
// regret of its own kind. Everything stays on this machine: the `regret` app_state document,
// read only by the diagnostics page. There is no telemetry.
//
// What automation did is remembered per tab for the hour it can be regretted, in memory only: a
// restart forgets it (an engaged hour rarely spans one), and the totals persist.
import { z } from 'zod';

import type { Timers } from '../../core/lifecycle/discard';
import { LIFECYCLE_RULES } from '../../core/lifecycle/policy';
import type { LifecycleRule } from '../../core/lifecycle/policy';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';

/** §4.13: a restore within one engaged hour of the move. */
export const REGRET_WINDOW_ENGAGED_MS = 60 * 60 * 1000;
export const REGRET_DOCUMENT = 'regret';
/** The newest regret events kept, for the diagnostics page. */
export const MAX_REGRET_EVENTS = 200;
/** Counts come in bursts (an evaluation): one write covers a burst. */
export const REGRET_WRITE_DELAY_MS = 10_000;
const REGRET_READ_TIMEOUT_MS = 2000;

export type RegretAction = 'shelve' | 'archive' | 'discard';

const eventSchema = z.object({
  /** Wall-clock time of the regret. */
  at: z.number().int().nonnegative(),
  /** How the user brought the tab back: a restore, an Undo, or a reload of an unloaded tab. */
  how: z.enum(['restore', 'undo', 'reload']),
  action: z.enum(['shelve', 'archive', 'discard']),
  rule: z.enum(LIFECYCLE_RULES),
  /** Engaged time between automation's action and the user's. */
  afterEngagedMs: z.number().int().nonnegative(),
});
export type RegretEvent = z.infer<typeof eventSchema>;

const countsSchema = z.object({
  /** Automated moves (to Sleeping or the Archive) and the regretted ones. */
  moves: z.number().int().nonnegative(),
  moveRegrets: z.number().int().nonnegative(),
  /** Automatic unloads (by the rules or memory pressure) and the ones reloaded within the hour. */
  unloads: z.number().int().nonnegative(),
  unloadRegrets: z.number().int().nonnegative(),
});
export type RegretCounts = z.infer<typeof countsSchema>;

const storedSchema = z.object({
  /** Wall-clock time counting started. */
  since: z.number().int().nonnegative(),
  counts: countsSchema,
  events: z.array(z.unknown()),
});

export interface RegretState {
  readonly since: number;
  readonly counts: RegretCounts;
  /** Newest first. */
  readonly events: readonly RegretEvent[];
}

export interface RegretClock {
  readonly wallNow: number;
  readonly engagedNow: number;
}

export interface RegretTrackerOptions {
  readonly stored: RegretState | null;
  readonly persist: (state: RegretState) => Promise<void>;
  readonly clock: () => RegretClock;
  readonly timers: Timers;
  readonly logger: Logger;
}

interface Pending {
  readonly action: RegretAction;
  readonly rule: LifecycleRule;
  readonly engagedAt: number;
}

const ZERO: RegretCounts = { moves: 0, moveRegrets: 0, unloads: 0, unloadRegrets: 0 };

export class RegretTracker {
  readonly #options: RegretTrackerOptions;
  #since: number;
  #counts: RegretCounts;
  /** Newest last. */
  readonly #events: RegretEvent[];
  /** What automation last did to each tab, while it can still be regretted. */
  readonly #pending = new Map<string, Pending>();
  #timer: unknown;
  #dirty = false;
  #writing: Promise<void> = Promise.resolve();

  constructor(options: RegretTrackerOptions) {
    this.#options = options;
    const stored = options.stored;
    this.#since = stored?.since ?? options.clock().wallNow;
    this.#counts = stored?.counts ?? ZERO;
    this.#events = [...(stored?.events ?? [])].reverse().slice(-MAX_REGRET_EVENTS);
    if (stored === null) {
      this.#dirty = true; // The start of counting is worth keeping.
    }
  }

  /** Automation moved or unloaded a tab: counted, and watched for an engaged hour. */
  automated(tabId: string, action: RegretAction, rule: LifecycleRule): void {
    const key = action === 'discard' ? 'unloads' : 'moves';
    this.#counts = { ...this.#counts, [key]: this.#counts[key] + 1 };
    this.#pending.set(tabId, { action, rule, engagedAt: this.#options.clock().engagedNow });
    this.#changed();
  }

  /** The user brought a Sleeping or archived tab back (`restore`), or undid automation (`undo`). */
  restored(tabId: string, how: 'restore' | 'undo'): void {
    const pending = this.#pending.get(tabId);
    if (pending === undefined || pending.action === 'discard') {
      return;
    }
    this.#regret(tabId, pending, how);
  }

  /** The user selected a tab automation or memory pressure had unloaded: it reloads. */
  reloaded(tabId: string): void {
    const pending = this.#pending.get(tabId);
    if (pending?.action !== 'discard') {
      return;
    }
    this.#regret(tabId, pending, 'reload');
  }

  state(): RegretState {
    return {
      since: this.#since,
      counts: this.#counts,
      events: [...this.#events].reverse(),
    };
  }

  /** Writes what changed now (the app is quitting). Never rejects. */
  flush(): Promise<void> {
    this.#cancelTimer();
    if (!this.#dirty) {
      return this.#writing;
    }
    this.#dirty = false;
    const state = this.state();
    this.#writing = this.#writing
      .then(() => this.#options.persist(state))
      .catch(() => {
        this.#options.logger.warn('regret.writeFailed');
      });
    return this.#writing;
  }

  stop(): void {
    this.#cancelTimer();
  }

  #regret(tabId: string, pending: Pending, how: RegretEvent['how']): void {
    this.#pending.delete(tabId);
    const { wallNow, engagedNow } = this.#options.clock();
    const after = Math.max(0, engagedNow - pending.engagedAt);
    if (after > REGRET_WINDOW_ENGAGED_MS) {
      return; // Long enough ago: the user just came back to it.
    }
    const key = pending.action === 'discard' ? 'unloadRegrets' : 'moveRegrets';
    this.#counts = { ...this.#counts, [key]: this.#counts[key] + 1 };
    this.#events.push({
      at: wallNow,
      how,
      action: pending.action,
      rule: pending.rule,
      afterEngagedMs: Math.round(after),
    });
    if (this.#events.length > MAX_REGRET_EVENTS) {
      this.#events.shift();
    }
    this.#changed();
  }

  #changed(): void {
    this.#dirty = true;
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = this.#options.timers.setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, REGRET_WRITE_DELAY_MS);
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      this.#options.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

/** The stored document, checked; anything unreadable starts counting again. */
export function parseRegret(raw: unknown): RegretState | null {
  const stored = storedSchema.safeParse(raw);
  if (!stored.success) {
    return null;
  }
  const events: RegretEvent[] = [];
  for (const candidate of stored.data.events.slice(0, MAX_REGRET_EVENTS)) {
    const event = eventSchema.safeParse(candidate);
    if (event.success) {
      events.push(event.data);
    }
  }
  return { since: stored.data.since, counts: stored.data.counts, events };
}

export async function readStoredRegret(
  data: Pick<DataClient, 'call'>,
  logger: Logger,
): Promise<RegretState | null> {
  try {
    const { value } = await data.call(
      'appState.get',
      { key: REGRET_DOCUMENT },
      { timeoutMs: REGRET_READ_TIMEOUT_MS },
    );
    return value === null ? null : parseRegret(value);
  } catch {
    logger.warn('regret.readFailed');
    return null;
  }
}

/** Writes the state as the `regret` document. */
export function regretWriter(
  data: Pick<DataClient, 'call'>,
): (state: RegretState) => Promise<void> {
  return async (state) => {
    await data.call('appState.set', {
      key: REGRET_DOCUMENT,
      value: {
        since: state.since,
        counts: { ...state.counts },
        events: state.events.map((event) => ({ ...event })),
      },
    });
  };
}
