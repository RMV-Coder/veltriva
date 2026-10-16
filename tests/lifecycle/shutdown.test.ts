// ADR-0008 4a: closing the window with live tabs quits the app cleanly and promptly. Playwright
// can't tell: with its inspector attached, teardown on a loaded machine took up to ~100 s, so the
// E2E harness kills a slow app and only warns (tests/e2e/launch.ts, rule 6).
import { describe, expect, it } from 'vitest';

import { runScenario } from './harness';

describe('closing the window', () => {
  it('quits the app within a few seconds, with live tabs open', async () => {
    const { result, exitMs } = await runScenario<{ liveTabs: number }>('close-with-live-tabs');

    expect(result.liveTabs).toBe(2);
    // runScenario has already checked for exit code 0: no uncaught exception on the way out.
    // M1.1 measured about 25 ms for app.quit() without Playwright; this leaves room for CI.
    expect(exitMs).toBeLessThan(10_000);
  });
});
