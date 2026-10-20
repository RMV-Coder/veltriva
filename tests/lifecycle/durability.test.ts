// M2.1b durability, across real launches of the app on one profile (ADR-0008 4a: no Playwright,
// whose inspector distorts shutdown). Assessment §5.5, §5.6, §5.9 and ADR-0004 item 5.
import { closeSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeProfile, removeProfile, runScenario } from './harness';

interface StartupReport {
  readonly ready: {
    readonly runId: number;
    readonly previousExit: string;
    readonly checked: string;
    readonly recovery: { readonly kind: string; readonly backupAt?: number } | null;
  } | null;
  readonly notices: readonly { readonly kind: string; readonly corruptFile: string }[];
}

let profile: string;

beforeEach(() => {
  profile = makeProfile();
});

afterEach(() => {
  removeProfile(profile);
});

describe('the database across launches', () => {
  it('records a clean exit, so the next launch checks nothing', async () => {
    await runScenario('report-data-startup', { userDataDir: profile });
    const { result } = await runScenario<StartupReport>('report-data-startup', {
      userDataDir: profile,
    });
    expect(result.ready).toMatchObject({ previousExit: 'clean', checked: 'none', recovery: null });
    expect(result.notices).toEqual([]);
  });

  it('ends the quit at its 3 s cap while the worker is stuck in a statement, and the next launch checks the file', async () => {
    const { exitMs, events } = await runScenario('quit-with-busy-database', {
      userDataDir: profile,
      exitCode: 1, // process.kill(process.pid): Windows ends the process with code 1.
    });
    // The statement runs for about 20 s; the quit must not wait for it.
    expect(exitMs).toBeGreaterThanOrEqual(2500);
    expect(exitMs).toBeLessThan(10_000);
    // A hard exit never reaches will-quit.
    expect(events).toEqual([]);

    const { result } = await runScenario<StartupReport>('report-data-startup', {
      userDataDir: profile,
    });
    expect(result.ready).toMatchObject({ previousExit: 'crash', checked: 'quick', recovery: null });
  });

  it('restores a damaged database from the daily backup, keeps the damaged file, and says so', async () => {
    const { result: backedUp } = await runScenario<{ upkeep: { backup: string } }>(
      'write-and-back-up',
      { userDataDir: profile },
    );
    expect(backedUp.upkeep.backup).toBe('done');
    expect(
      readdirSync(join(profile, 'backups')).filter((name) => name.startsWith('veltriva-daily-')),
    ).toHaveLength(1);

    // The header goes: SQLite no longer sees a database there.
    const fd = openSync(join(profile, 'veltriva.db'), 'r+');
    writeSync(fd, Buffer.alloc(100, 0x5a), 0, 100, 0);
    closeSync(fd);

    const { result } = await runScenario<StartupReport>('report-data-startup', {
      userDataDir: profile,
    });
    expect(result.ready?.recovery).toMatchObject({ kind: 'restored' });
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ kind: 'database-restored' });
    const corrupt = result.notices[0]?.corruptFile ?? '';
    expect(corrupt).toMatch(/^veltriva\.db\.corrupt-/);
    expect(readdirSync(profile)).toContain(corrupt);
  });
});
