// The engagement clock (assessment §4.6): inactivity measured in the user's time, so a weekend
// away never empties the workspace. Pure; main/lifecycle/engagement-sampler.ts feeds it.
//
// Engaged time advances only while the app runs, the system is neither suspended nor locked, and
// the user was active in the last 5 minutes (`powerMonitor.getSystemIdleState(300)` says
// 'active'), sampled every 30 s. The time between two samples comes from a monotonic source, so a
// wall-clock change (daylight saving, the user setting the time) never adds or removes
// engagement; the wall clock only names the calendar day.
//
// Active days: today's index is 1 + the number of earlier calendar days on which engagement
// reached 10 minutes. A tab stamps the index when it is used, and "unused for N active days" is
// `today - stamped >= N`. Days away, or days with only a glance at the screen, don't count.

/** How often the sampler asks the system whether the user is active. */
export const SAMPLE_INTERVAL_MS = 30_000;
/** "Active" means some input in the last 5 minutes (§4.6). */
export const IDLE_THRESHOLD_S = 300;
/** A calendar day counts once engagement reaches this. */
export const ACTIVE_DAY_THRESHOLD_MS = 10 * 60 * 1000;
/**
 * The most one sample may add: two intervals. A longer gap means the process didn't run (a sleep
 * without a `suspend` event, a debugger, a stalled machine), and that time is never counted.
 */
export const MAX_SAMPLE_STEP_MS = 2 * SAMPLE_INTERVAL_MS;

export interface EngagementState {
  /** Engaged milliseconds since the profile began. */
  readonly engagedMs: number;
  /** 1 + the calendar days before `dayKey` that reached ACTIVE_DAY_THRESHOLD_MS. */
  readonly activeDay: number;
  /** The local calendar day being counted, `YYYY-MM-DD`. */
  readonly dayKey: string;
  /** Engagement on `dayKey` so far. */
  readonly dayEngagedMs: number;
}

export function initialEngagement(dayKey: string): EngagementState {
  return { engagedMs: 0, activeDay: 1, dayKey, dayEngagedMs: 0 };
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The local calendar day of a wall-clock time, given the zone's `getTimezoneOffset()` minutes. */
export function dayKeyOf(wallMs: number, timezoneOffsetMinutes: number): string {
  return new Date(wallMs - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * The clock after one sample.
 * - `elapsedMs`: monotonic time since the previous sample.
 * - `engaged`: whether the user was engaged during that interval: the previous sample found them
 *   active, and nothing suspended or locked the system since.
 * - `dayKey`: today, by the wall clock.
 */
export function advance(
  state: EngagementState,
  sample: { readonly elapsedMs: number; readonly engaged: boolean; readonly dayKey: string },
): EngagementState {
  let next = state;
  if (sample.dayKey !== state.dayKey) {
    // A new calendar day: the one that ended counts if it reached the threshold. A clock set back
    // to an earlier day is a new day too; the index never goes back.
    next = {
      engagedMs: state.engagedMs,
      activeDay:
        state.dayEngagedMs >= ACTIVE_DAY_THRESHOLD_MS ? state.activeDay + 1 : state.activeDay,
      dayKey: sample.dayKey,
      dayEngagedMs: 0,
    };
  }
  if (!sample.engaged || !(sample.elapsedMs > 0)) {
    return next;
  }
  const step = Math.min(sample.elapsedMs, MAX_SAMPLE_STEP_MS);
  return {
    ...next,
    engagedMs: next.engagedMs + step,
    dayEngagedMs: next.dayEngagedMs + step,
  };
}

/** A stored engagement document, checked like any input; null if it isn't one. */
export function parseEngagement(raw: unknown): EngagementState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const { engagedMs, activeDay, dayKey, dayEngagedMs } = raw as Record<string, unknown>;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (
    !finite(engagedMs) ||
    !finite(dayEngagedMs) ||
    typeof activeDay !== 'number' ||
    !Number.isInteger(activeDay) ||
    activeDay < 1 ||
    typeof dayKey !== 'string' ||
    !DAY_KEY.test(dayKey)
  ) {
    return null;
  }
  return { engagedMs, activeDay, dayKey, dayEngagedMs: Math.min(dayEngagedMs, engagedMs) };
}
