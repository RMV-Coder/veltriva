// Memory pressure (assessment §4.7): Electron has no pressure event, so this polls
// `process.getSystemMemoryInfo()` and listens for renderers the system killed for memory.
//
// Measured on the reference laptop (i3, 7.9 GB, M3.2; ADR-0003 item 13): on Windows, `free` is the
// available physical memory (it matched `os.freemem()` exactly, and tracked the "Available MBytes"
// counter), and `swapFree` is the commit charge left. Over 10 busy minutes, available memory ran
// from 97 to 955 MB (median 632, 8% of the total) with up to 9,700 hard page faults a second.
// So the levels are fractions of the total, and a level needs two polls in a row to begin and a
// little more room to end, so one spike doesn't swing automation:
//   critical: available under 4% of total (316 MB here), or a renderer died with `oom` or
//             `memory-eviction` in the last 2 minutes;
//   moderate: available under 10% (790 MB here).
// Both thresholds are advanced settings (M5.1, `thresholds`): the settings document keeps them in
// order, critical below moderate.
// The policy (core/lifecycle/policy.ts) decides what each level does: a few discards of tabs
// hidden for a while, never a visible change.
import type { MemoryPressure } from '../../core/lifecycle/policy';
import type { Timers } from '../../core/lifecycle/discard';

export const POLL_INTERVAL_MS = 10_000;
export const CRITICAL_FRACTION = 0.04;
export const MODERATE_FRACTION = 0.1;
/** A level ends only once available memory is this much above its threshold (hysteresis). */
export const RELEASE_MARGIN = 0.02;
/** Polls in a row a level needs before it begins. */
export const ENTER_POLLS = 2;
/** How long a renderer killed for memory keeps the level critical. */
export const OOM_CRITICAL_MS = 2 * 60 * 1000;

/** `process.getSystemMemoryInfo()`: kilobytes. */
export interface MemoryInfo {
  readonly total: number;
  readonly free: number;
}

/** The levels' thresholds: available memory as a fraction of the total. */
export interface PressureThresholds {
  readonly moderate: number;
  readonly critical: number;
}

export const DEFAULT_THRESHOLDS: PressureThresholds = {
  moderate: MODERATE_FRACTION,
  critical: CRITICAL_FRACTION,
};

export interface MemoryPressureOptions {
  readonly read: () => MemoryInfo;
  /** The thresholds now (the settings'); the defaults when left out. Read at every poll. */
  readonly thresholds?: () => PressureThresholds;
  readonly timers: Timers;
  /** A monotonic clock (ms). */
  readonly monotonic: () => number;
  readonly onChange: (level: MemoryPressure) => void;
}

/** The level a reading alone calls for, given the level now (for the release margin). */
export function levelFor(
  info: MemoryInfo,
  current: MemoryPressure,
  thresholds: PressureThresholds = DEFAULT_THRESHOLDS,
): MemoryPressure {
  if (!(info.total > 0) || !(info.free >= 0)) {
    return current;
  }
  const available = info.free / info.total;
  const critical = thresholds.critical + (current === 'critical' ? RELEASE_MARGIN : 0);
  if (available < critical) {
    return 'critical';
  }
  const moderate = thresholds.moderate + (current === 'none' ? 0 : RELEASE_MARGIN);
  return available < moderate ? 'moderate' : 'none';
}

const RANK: Readonly<Record<MemoryPressure, number>> = { none: 0, moderate: 1, critical: 2 };

export class MemoryPressureMonitor {
  readonly #options: MemoryPressureOptions;
  #level: MemoryPressure = 'none';
  /** The level the polls point to, and for how many polls in a row. */
  #candidate: MemoryPressure = 'none';
  #candidatePolls = 0;
  #oomAt: number | null = null;
  #timer: unknown;
  #last: MemoryInfo | null = null;

  constructor(options: MemoryPressureOptions) {
    this.#options = options;
  }

  level(): MemoryPressure {
    return this.#level;
  }

  /** The last reading, for diagnostics. */
  lastReading(): MemoryInfo | null {
    return this.#last;
  }

  start(): void {
    this.poll();
    this.#schedule();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      this.#options.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** A renderer died; `reason` is Electron's (`oom`, `memory-eviction`, `crashed`, …). */
  rendererGone(reason: string): void {
    if (reason === 'oom' || reason === 'memory-eviction') {
      this.#oomAt = this.#options.monotonic();
      this.#set('critical');
    }
  }

  poll(): void {
    let reading: MemoryInfo;
    try {
      reading = this.#options.read();
    } catch {
      return;
    }
    this.#last = reading;
    const now = this.#options.monotonic();
    const killed = this.#oomAt !== null && now - this.#oomAt < OOM_CRITICAL_MS;
    const wanted = killed
      ? 'critical'
      : levelFor(reading, this.#level, this.#options.thresholds?.() ?? DEFAULT_THRESHOLDS);
    if (wanted === this.#level) {
      this.#candidate = wanted;
      this.#candidatePolls = 0;
      return;
    }
    if (wanted !== this.#candidate) {
      this.#candidate = wanted;
      this.#candidatePolls = 0;
    }
    this.#candidatePolls += 1;
    // Rising needs ENTER_POLLS readings in a row; falling, one (the margin already damps it).
    if (RANK[wanted] < RANK[this.#level] || this.#candidatePolls >= ENTER_POLLS) {
      this.#set(wanted);
    }
  }

  #set(level: MemoryPressure): void {
    this.#candidate = level;
    this.#candidatePolls = 0;
    if (level === this.#level) {
      return;
    }
    this.#level = level;
    this.#options.onChange(level);
  }

  #schedule(): void {
    this.#timer = this.#options.timers.setTimeout(() => {
      this.#timer = undefined;
      this.poll();
      this.#schedule();
    }, POLL_INTERVAL_MS);
  }
}
