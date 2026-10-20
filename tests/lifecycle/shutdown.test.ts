// ADR-0008 4a: closing the window with live tabs quits the app cleanly and promptly. Playwright
// can't tell: with its inspector attached, teardown on a loaded machine took up to ~100 s, so the
// E2E harness kills a slow app and only warns (tests/e2e/launch.ts, rule 6).
import { describe, expect, it } from 'vitest';

import { runScenario } from './harness';

describe('closing the window', () => {
  it('quits the app within a few seconds, with live tabs open', async () => {
    const { result, exitMs, profileFiles, events } = await runScenario<{ liveTabs: number }>(
      'close-with-live-tabs',
    );

    expect(result.liveTabs).toBe(2);
    // runScenario has already checked for exit code 0: no uncaught exception on the way out.
    // M1.1 measured about 25 ms for app.quit() without Playwright; this leaves room for CI.
    expect(exitMs).toBeLessThan(10_000);
    // Phase 2: quitting waited for the data worker to close the database (ADR-0004). By
    // will-quit the client must be closed; without the wait it would still be ready.
    expect(events).toEqual([{ event: 'will-quit', dataState: 'closed' }]);
    // And the file is whole: SQLite folds the WAL back in and deletes it, with its -shm, when the
    // last connection closes. (better-sqlite3 also closes on thread teardown, so this alone
    // wouldn't prove the wait.)
    expect(profileFiles).toContain('veltriva.db');
    expect(profileFiles).not.toContain('veltriva.db-wal');
    expect(profileFiles).not.toContain('veltriva.db-shm');
  });
});
