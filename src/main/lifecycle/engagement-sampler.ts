// Feeds the engagement clock (core/lifecycle/engagement-clock.ts, assessment §4.6) from the
// system: `powerMonitor.getSystemIdleState(300)` every 30 s, and the suspend, resume, lock and
// unlock events. A suspend or a lock ends the interval it falls in; resuming re-samples first and
// then lets the scheduler re-evaluate, so waking the laptop never triggers a mass action.
//
// The state is persisted as the `engagement` document in app_state: at most every 5 minutes, on
// a new calendar day, and when the app quits (DataLifecycle's flush).
import {
  advance,
  dayKeyOf,
  IDLE_THRESHOLD_S,
  initialEngagement,
  MAX_SAMPLE_STEP_MS,
  parseEngagement,
  SAMPLE_INTERVAL_MS,
} from '../../core/lifecycle/engagement-clock';
import type { EngagementState } from '../../core/lifecycle/engagement-clock';
import type { Timers } from '../../core/lifecycle/discard';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';

export const ENGAGEMENT_DOCUMENT = 'engagement';
/** How often the clock is written while it advances. */
export const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

/** What the sampler reads from the system: Electron's powerMonitor in the app, a fake in tests. */
export interface SystemActivity {
  idleState(thresholdSeconds: number): 'active' | 'idle' | 'locked' | 'unknown';
  on(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', listener: () => void): void;
}

export interface EngagementSamplerOptions {
  readonly system: SystemActivity;
  /** A monotonic clock (ms): `performance.now()`. */
  readonly monotonic: () => number;
  /** The wall clock: `Date.now()`. */
  readonly wall: () => number;
  /** Minutes the local zone is behind UTC at a time (`new Date(t).getTimezoneOffset()`). */
  readonly timezoneOffset: (wallMs: number) => number;
  readonly timers: Timers;
  /** The stored clock, or null for a new profile (or an unreadable document). */
  readonly stored: EngagementState | null;
  readonly persist: (state: EngagementState) => Promise<void>;
  /** The system woke or was unlocked, and the clock has been re-sampled. */
  readonly onResume?: () => void;
  readonly logger: Logger;
}

export class EngagementSampler {
  readonly #options: EngagementSamplerOptions;
  #state: EngagementState;
  /** Monotonic time of the last sample. */
  #sampledAt: number;
  /** Whether the user counted as engaged from the last sample on. */
  #engaged = false;
  /** Suspended or locked: nothing counts until the system is back. */
  #away = false;
  #timer: unknown;
  #persistedAt: number;
  #persistedDay: string;
  #stopped = false;

  constructor(options: EngagementSamplerOptions) {
    this.#options = options;
    const wall = options.wall();
    this.#state = options.stored ?? initialEngagement(dayKeyOf(wall, options.timezoneOffset(wall)));
    this.#sampledAt = options.monotonic();
    this.#persistedAt = this.#sampledAt;
    this.#persistedDay = this.#state.dayKey;
  }

  /** Starts sampling: once now (which counts nothing yet), then every 30 s. */
  start(): void {
    const { system } = this.#options;
    system.on('suspend', () => {
      this.#goAway();
    });
    system.on('lock-screen', () => {
      this.#goAway();
    });
    system.on('resume', () => {
      this.#comeBack();
    });
    system.on('unlock-screen', () => {
      this.#comeBack();
    });
    this.sample();
    this.#schedule();
  }

  /** Stops sampling (shutdown); the state stays readable and `flush()` still writes it. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      this.#options.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** The clock now, counting the engaged part of the interval under way. */
  now(): EngagementState {
    if (!this.#engaged || this.#away) {
      return this.#state;
    }
    const partial = Math.min(
      Math.max(0, this.#options.monotonic() - this.#sampledAt),
      MAX_SAMPLE_STEP_MS,
    );
    return {
      ...this.#state,
      engagedMs: this.#state.engagedMs + partial,
      dayEngagedMs: this.#state.dayEngagedMs + partial,
    };
  }

  /** Takes a sample now: what the interval since the last one adds, then the user's state. */
  sample(): void {
    const { monotonic, wall, timezoneOffset } = this.#options;
    const at = monotonic();
    const wallNow = wall();
    this.#state = advance(this.#state, {
      elapsedMs: at - this.#sampledAt,
      engaged: this.#engaged && !this.#away,
      dayKey: dayKeyOf(wallNow, timezoneOffset(wallNow)),
    });
    this.#sampledAt = at;
    this.#engaged = !this.#away && this.#idleState() === 'active';
    if (
      this.#state.dayKey !== this.#persistedDay ||
      at - this.#persistedAt >= PERSIST_INTERVAL_MS
    ) {
      void this.flush();
    }
  }

  /** Writes the clock now. Never rejects. */
  async flush(): Promise<void> {
    this.#persistedAt = this.#options.monotonic();
    this.#persistedDay = this.#state.dayKey;
    try {
      await this.#options.persist(this.now());
    } catch {
      this.#options.logger.warn('engagement.saveFailed');
    }
  }

  #idleState(): ReturnType<SystemActivity['idleState']> {
    try {
      return this.#options.system.idleState(IDLE_THRESHOLD_S);
    } catch {
      return 'unknown';
    }
  }

  #schedule(): void {
    if (this.#stopped) {
      return;
    }
    this.#timer = this.#options.timers.setTimeout(() => {
      this.#timer = undefined;
      this.sample();
      this.#schedule();
    }, SAMPLE_INTERVAL_MS);
  }

  #goAway(): void {
    // The interval up to now counts as it was; nothing counts from here.
    this.sample();
    this.#away = true;
    this.#engaged = false;
  }

  #comeBack(): void {
    if (!this.#away) {
      return;
    }
    this.sample(); // Adds nothing: the user was away.
    this.#away = false;
    this.sample(); // The state from now on.
    this.#options.onResume?.();
  }
}

/** How long startup waits for the stored clock; without it the clock starts from zero. */
export const ENGAGEMENT_READ_TIMEOUT_MS = 3000;

/** The stored clock, checked like any input, or null (none, unreadable, or the read failed). */
export async function readStoredEngagement(
  data: Pick<DataClient, 'call'>,
  logger: Logger,
): Promise<EngagementState | null> {
  try {
    const { value } = await data.call(
      'appState.get',
      { key: ENGAGEMENT_DOCUMENT },
      { timeoutMs: ENGAGEMENT_READ_TIMEOUT_MS },
    );
    return value === null ? null : parseEngagement(value);
  } catch {
    logger.warn('engagement.readFailed');
    return null;
  }
}

/** Writes the clock as the `engagement` document. */
export function engagementWriter(
  data: Pick<DataClient, 'call'>,
): (state: EngagementState) => Promise<void> {
  return async (state) => {
    await data.call('appState.set', { key: ENGAGEMENT_DOCUMENT, value: { ...state } });
  };
}
