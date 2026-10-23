// What memory pressure did this run (M5.3, the diagnostics page): each change of level, with when,
// the newest MAX_PRESSURE_CHANGES. In memory only: it describes this run of the app.
import type { MemoryPressure } from '../../core/lifecycle/policy';

export const MAX_PRESSURE_CHANGES = 50;

export interface PressureChange {
  readonly at: number;
  readonly level: MemoryPressure;
}

export class PressureHistory {
  readonly #changes: PressureChange[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The monitor's level changed. A repeat of the last level adds nothing. */
  record(level: MemoryPressure): void {
    if (this.#changes.at(-1)?.level === level) {
      return;
    }
    this.#changes.push({ at: this.#now(), level });
    if (this.#changes.length > MAX_PRESSURE_CHANGES) {
      this.#changes.shift();
    }
  }

  /** Newest first. */
  changes(): PressureChange[] {
    return [...this.#changes].reverse();
  }
}
