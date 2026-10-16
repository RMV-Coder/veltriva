// ADR-0008 4a: a tab that isn't selected is detached from the window, so Chromium reports it
// hidden and throttles its timers, while the selected tab stays visible. Playwright's focus
// emulation masks both, so this runs without it (./harness.ts).
import { describe, expect, it } from 'vitest';

import { runScenario } from './harness';

interface TabReading {
  /** Ticks of a 100 ms interval during the measuring window. */
  readonly ticks: number;
  readonly visibility: string;
}

interface BackgroundTabResult {
  readonly windowMs: number;
  readonly selected: TabReading;
  readonly hidden: TabReading;
}

describe('a tab that is not selected', () => {
  it('reports hidden and is throttled, while the selected tab stays visible', async () => {
    const { result } = await runScenario<BackgroundTabResult>('background-tab-hidden');
    const { windowMs, selected, hidden } = result;

    expect(selected.visibility).toBe('visible');
    expect(hidden.visibility).toBe('hidden');
    // About 30 ticks in 3 s when visible, about 3 when throttled to once a second (spike S1).
    // The bounds leave room for a loaded CI runner.
    expect(selected.ticks).toBeGreaterThanOrEqual(windowMs / 100 / 2);
    expect(hidden.ticks).toBeLessThanOrEqual(windowMs / 1000 + 2);
  });
});
