// Test builds only (ADR-0008 §4, assessment §4.8): the accelerated lifecycle clock. E2E specs
// fast-forward wall-clock time, engaged time and active days in milliseconds, and set the memory
// pressure, through the test hooks. src/main/index.ts reads these behind
// `import.meta.env.MODE === 'test'`, which production builds fold to false and drop, and
// scripts/check-production-build.mjs refuses a build that still contains them.
import type { MemoryPressure } from '../../core/lifecycle/policy';

export interface TestClockAdjustment {
  /** Added to the wall clock the lifecycle sees (hidden times, last use, interaction). */
  readonly wallMs: number;
  /** Added to engaged time. */
  readonly engagedMs: number;
  /** Added to the active-day index. */
  readonly activeDays: number;
}

let adjustment: TestClockAdjustment = { wallMs: 0, engagedMs: 0, activeDays: 0 };
let pressure: MemoryPressure | null = null;

export function testClockAdjustment(): TestClockAdjustment {
  return adjustment;
}

export function advanceTestClock(by: Partial<TestClockAdjustment>): TestClockAdjustment {
  adjustment = {
    wallMs: adjustment.wallMs + Math.max(0, by.wallMs ?? 0),
    engagedMs: adjustment.engagedMs + Math.max(0, by.engagedMs ?? 0),
    activeDays: adjustment.activeDays + Math.max(0, Math.trunc(by.activeDays ?? 0)),
  };
  return adjustment;
}

/** The pressure a spec set, or null to use the real monitor's. */
export function testMemoryPressure(): MemoryPressure | null {
  return pressure;
}

export function setTestMemoryPressure(level: MemoryPressure | null): void {
  pressure = level;
}
