// The backup folder's naming and housekeeping (assessment §5.6): what a name says, what counts as
// a backup, and which ones survive pruning. Real files in a temp folder; the files are empty
// because nothing here reads a backup's contents.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  backupStamp,
  dailyBackupName,
  KEPT_BACKUPS,
  listBackups,
  pruneBackups,
  upgradeBackupName,
} from './backups';

const T0 = Date.UTC(2026, 9, 21, 8, 30, 15);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The daily backup taken `n` days after T0. */
const daily = (n: number): string => dailyBackupName(T0 + n * DAY);
/** A pre-upgrade backup (to version `n + 1`) taken `n` days after T0. */
const upgrade = (n: number): string => upgradeBackupName(n, n + 1, T0 + n * DAY);

let dir: string;

/** Creates empty files, and the folder if it isn't there. */
function touch(...names: string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, name), '');
  }
}

function files(): string[] {
  return readdirSync(dir).sort();
}

function listed(): string[] {
  return listBackups(dir).map((backup) => backup.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veltriva-backups-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('backup names', () => {
  it('stamps a time as UTC, to the second, with dashes where a Windows name can not have colons', () => {
    expect(backupStamp(T0)).toBe('2026-10-21T08-30-15Z');
    expect(backupStamp(Date.UTC(1970, 0, 1))).toBe('1970-01-01T00-00-00Z');
    expect(backupStamp(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31T23-59-59Z');
  });

  it('drops the milliseconds rather than rounding them', () => {
    expect(backupStamp(T0 + 999)).toBe('2026-10-21T08-30-15Z');
    expect(backupStamp(T0 + 1000)).toBe('2026-10-21T08-30-16Z');
  });

  it('names a pre-upgrade backup after the versions it sits between', () => {
    expect(upgradeBackupName(1, 2, T0)).toBe('veltriva-v1-before-v2-2026-10-21T08-30-15Z.db');
    expect(upgradeBackupName(9, 10, T0)).toBe('veltriva-v9-before-v10-2026-10-21T08-30-15Z.db');
  });

  it('names a daily backup after the time it was taken', () => {
    expect(dailyBackupName(T0)).toBe('veltriva-daily-2026-10-21T08-30-15Z.db');
  });

  it('never puts a character in a name that Windows refuses', () => {
    for (const name of [dailyBackupName(T0), upgradeBackupName(1, 2, T0)]) {
      expect(name).not.toMatch(/[\\/:*?"<>|]/);
    }
  });
});

describe('listBackups', () => {
  it('finds both kinds, with the time taken read back from the name', () => {
    touch(upgradeBackupName(1, 2, T0 - DAY), dailyBackupName(T0));
    expect(listBackups(dir)).toEqual([
      { name: dailyBackupName(T0), kind: 'daily', takenAt: T0 },
      { name: upgradeBackupName(1, 2, T0 - DAY), kind: 'upgrade', takenAt: T0 - DAY },
    ]);
  });

  it('reads back the exact time a name was made from, so a restore reports when it was taken', () => {
    const times = [Date.UTC(1999, 11, 31, 23, 59, 59), T0, Date.UTC(2038, 0, 19, 3, 14, 7)];
    touch(...times.map(dailyBackupName));
    expect(listBackups(dir).map((backup) => backup.takenAt)).toEqual(
      times.toSorted((a, b) => b - a),
    );
  });

  it('lists the newest first, whatever the kind or the order the folder returns them in', () => {
    touch(
      dailyBackupName(T0 - 2 * DAY),
      upgradeBackupName(1, 2, T0 - DAY),
      dailyBackupName(T0),
      upgradeBackupName(2, 3, T0 - 3 * DAY),
      dailyBackupName(T0 - HOUR),
    );
    expect(listed()).toEqual([
      dailyBackupName(T0),
      dailyBackupName(T0 - HOUR),
      upgradeBackupName(1, 2, T0 - DAY),
      dailyBackupName(T0 - 2 * DAY),
      upgradeBackupName(2, 3, T0 - 3 * DAY),
    ]);
  });

  it('puts two backups from the same second in a fixed order', () => {
    const sameSecondUpgrade = upgradeBackupName(1, 2, T0);
    const sameSecondDaily = dailyBackupName(T0);
    touch(sameSecondDaily, sameSecondUpgrade);
    const first = listed();
    rmSync(dir, { recursive: true });
    touch(sameSecondUpgrade, sameSecondDaily);
    expect(listed()).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('ignores a half-written copy, a note, and anything else that is not a backup', () => {
    touch(
      dailyBackupName(T0),
      `${dailyBackupName(T0 + DAY)}.partial`,
      'notes.txt',
      'veltriva.db',
      'veltriva-daily-latest.db',
      `copy of ${dailyBackupName(T0 + 2 * DAY)}`,
      `x-${dailyBackupName(T0 + 3 * DAY)}`,
      `${dailyBackupName(T0 + 4 * DAY)}-wal`,
      `${dailyBackupName(T0 + 5 * DAY)}.bak`,
      'veltriva-v1-before-v2.db',
      'veltriva-before-v2-2026-10-21T08-30-15Z.db',
    );
    expect(listed()).toEqual([dailyBackupName(T0)]);
  });

  it('ignores a .db whose stamp is not a time', () => {
    touch(
      dailyBackupName(T0),
      'veltriva-daily-2026-13-45T25-61-61Z.db', // the right shape, but month 13
      'veltriva-daily-2026-10-21T24-00-60Z.db', // the right shape, but second 60
      'veltriva-v1-before-v2-2026-00-10T08-30-15Z.db', // the right shape, but month 0
    );
    expect(listed()).toEqual([dailyBackupName(T0)]);
  });

  it('is empty for a folder with nothing in it', () => {
    expect(listBackups(dir)).toEqual([]);
  });

  it('is empty, without an error, for a folder that does not exist', () => {
    const missing = join(dir, 'no', 'such', 'folder');
    expect(listBackups(missing)).toEqual([]);
    expect(existsSync(missing)).toBe(false);
  });

  it('is empty, without an error, when the folder is really a file', () => {
    touch('backups');
    expect(listBackups(join(dir, 'backups'))).toEqual([]);
  });
});

describe('pruneBackups', () => {
  it('keeps three, which is what the assessment says', () => {
    expect(KEPT_BACKUPS).toBe(3);
  });

  it('keeps the newest three of one kind and deletes the rest', () => {
    touch(daily(0), daily(1), daily(2), daily(3), daily(4));
    pruneBackups(dir, 'daily');
    expect(files()).toEqual([daily(2), daily(3), daily(4)]);
  });

  it('decides by the time in the name, not by the order the files were made in', () => {
    touch(daily(4), daily(0), daily(3), daily(1), daily(2));
    pruneBackups(dir, 'daily');
    expect(files()).toEqual([daily(2), daily(3), daily(4)]);
  });

  it('leaves the other kind alone, however many there are', () => {
    const upgrades = [1, 2, 3, 4, 5].map(upgrade);
    touch(daily(0), daily(1), daily(2), daily(3), ...upgrades);
    pruneBackups(dir, 'daily');
    expect(files()).toEqual([daily(1), daily(2), daily(3), ...upgrades].sort());
  });

  it('prunes pre-upgrade backups on their own, leaving the daily ones', () => {
    touch(daily(0), daily(1), daily(2), daily(3), ...[1, 2, 3, 4, 5].map(upgrade));
    pruneBackups(dir, 'upgrade');
    expect(files()).toEqual(
      [daily(0), daily(1), daily(2), daily(3), upgrade(3), upgrade(4), upgrade(5)].sort(),
    );
  });

  it('leaves files that are not backups, even ones that look nearly like a daily backup', () => {
    const others = [
      'notes.txt',
      `${dailyBackupName(T0 - 10 * DAY)}.partial`,
      'veltriva-daily-2026-13-45T25-61-61Z.db',
      `${dailyBackupName(T0 - 11 * DAY)}-wal`,
    ];
    touch(daily(0), daily(1), daily(2), daily(3), ...others);
    pruneBackups(dir, 'daily');
    expect(files()).toEqual([daily(1), daily(2), daily(3), ...others].sort());
  });

  it('deletes nothing when there are no more than three', () => {
    touch(daily(0), daily(1), daily(2));
    pruneBackups(dir, 'daily');
    pruneBackups(dir, 'upgrade');
    expect(files()).toEqual([daily(0), daily(1), daily(2)]);
  });

  it('can be run again without deleting more', () => {
    touch(...[0, 1, 2, 3, 4, 5].map(daily));
    pruneBackups(dir, 'daily');
    const once = files();
    pruneBackups(dir, 'daily');
    expect(files()).toEqual(once);
    expect(once).toHaveLength(3);
  });

  it('does nothing, and says nothing, for a folder that does not exist', () => {
    const missing = join(dir, 'missing');
    expect(() => {
      pruneBackups(missing, 'daily');
    }).not.toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});
