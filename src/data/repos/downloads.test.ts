import { describe, expect, it } from 'vitest';

import type { DownloadRow } from '../../shared/contracts/data-rpc';
import { downloadHandlers } from './downloads';
import { callerFor, sqliteErrorCode, testId, useTestDatabase } from './test-database';

const T0 = 1_700_000_000_000;

/** A finished, ordinary download; `n` sets its id and file name. */
function download(n: number, overrides: Partial<DownloadRow> = {}): DownloadRow {
  return {
    id: testId(200 + n),
    fileName: `file-${String(n)}.pdf`,
    path: `C:\\Users\\me\\Downloads\\file-${String(n)}.pdf`,
    url: `https://example.com/file-${String(n)}.pdf`,
    site: 'https://example.com',
    state: 'completed',
    dangerous: false,
    confirmed: true,
    receivedBytes: 2048,
    totalBytes: 2048,
    startedAt: T0 + n,
    endedAt: T0 + n + 500,
    ...overrides,
  };
}

describe('downloads', () => {
  const database = useTestDatabase();
  const setup = () => {
    const db = database();
    return { db, call: callerFor(downloadHandlers(db)) };
  };
  const listed = (call: ReturnType<typeof setup>['call']) =>
    call('downloads.list', { limit: 1000 }).downloads;

  describe('downloads.list', () => {
    it('is empty before any download', () => {
      expect(setup().call('downloads.list', { limit: 10 })).toEqual({ downloads: [] });
    });

    it('lists the newest first, breaking a tie by id', () => {
      const { call } = setup();
      call('downloads.upsert', download(1, { startedAt: T0 + 10 }));
      call('downloads.upsert', download(2, { startedAt: T0 + 30 }));
      call('downloads.upsert', download(3, { startedAt: T0 + 20 }));
      call('downloads.upsert', download(4, { startedAt: T0 + 20 }));

      expect(listed(call).map((row) => row.id)).toEqual([
        testId(202),
        testId(204),
        testId(203),
        testId(201),
      ]);
    });

    it('returns no more than the limit, keeping the newest', () => {
      const { call } = setup();
      for (let n = 1; n <= 5; n += 1) {
        call('downloads.upsert', download(n));
      }

      const { downloads } = call('downloads.list', { limit: 2 });

      expect(downloads.map((row) => row.fileName)).toEqual(['file-5.pdf', 'file-4.pdf']);
    });
  });

  describe('downloads.upsert', () => {
    it('round-trips a completed download', () => {
      const { call } = setup();
      const row = download(1, { fileName: 'résumé 😀.pdf', site: '' });

      expect(call('downloads.upsert', row)).toEqual({});

      expect(listed(call)).toEqual([row]);
    });

    it('round-trips a download in progress, which has no end time', () => {
      const { db, call } = setup();
      const row = download(1, {
        state: 'progressing',
        receivedBytes: 100,
        totalBytes: 0,
        endedAt: null,
      });

      call('downloads.upsert', row);

      expect(listed(call)).toEqual([row]);
      expect(db.prepare('SELECT ended_at FROM downloads').pluck().get()).toBeNull();
    });

    it('round-trips a dangerous file waiting for Keep, and one the user kept', () => {
      const { db, call } = setup();
      const waiting = download(1, {
        state: 'paused',
        dangerous: true,
        confirmed: false,
        endedAt: null,
      });
      const kept = download(2, { dangerous: true, confirmed: true });

      call('downloads.upsert', waiting);
      call('downloads.upsert', kept);

      expect(listed(call)).toEqual([kept, waiting]);
      expect(
        db.prepare('SELECT dangerous, confirmed FROM downloads ORDER BY started_at').all(),
      ).toEqual([
        { dangerous: 1, confirmed: 0 },
        { dangerous: 1, confirmed: 1 },
      ]);
    });

    it.each(['completed', 'cancelled', 'interrupted'] as const)(
      'round-trips a %s download',
      (state) => {
        const { call } = setup();
        const row = download(1, { state });

        call('downloads.upsert', row);

        expect(listed(call)).toEqual([row]);
      },
    );

    it('updates a download as it progresses to its end, without adding a row', () => {
      const { db, call } = setup();
      const started = download(1, {
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: 4096,
        endedAt: null,
      });
      call('downloads.upsert', started);

      const finished = {
        ...started,
        fileName: 'renamed.pdf',
        path: 'C:\\Users\\me\\Downloads\\renamed.pdf',
        url: 'https://example.com/final.pdf',
        state: 'completed',
        receivedBytes: 4096,
        endedAt: T0 + 9000,
      } satisfies DownloadRow;
      call('downloads.upsert', finished);

      expect(listed(call)).toEqual([finished]);
      expect(db.prepare('SELECT count(*) FROM downloads').pluck().get()).toBe(1);
    });

    it('keeps a download that is later paused and resumed', () => {
      const { call } = setup();
      call('downloads.upsert', download(1, { state: 'progressing', endedAt: null }));
      call('downloads.upsert', download(1, { state: 'paused', endedAt: null }));

      expect(listed(call).map((row) => row.state)).toEqual(['paused']);
    });

    it('keeps byte counts and times up to the largest safe integer exact', () => {
      const { call } = setup();
      const row = download(1, {
        receivedBytes: Number.MAX_SAFE_INTEGER,
        totalBytes: Number.MAX_SAFE_INTEGER,
        endedAt: Number.MAX_SAFE_INTEGER,
      });

      call('downloads.upsert', row);

      expect(listed(call)).toEqual([row]);
    });

    it.each([
      ['a file that is neither dangerous nor confirmed', { dangerous: false, confirmed: false }],
      ['a progressing download with an end time', { state: 'progressing', endedAt: T0 + 600 }],
      ['a paused download with an end time', { state: 'paused', endedAt: T0 + 600 }],
      ['a completed download without an end time', { state: 'completed', endedAt: null }],
      ['a cancelled download without an end time', { state: 'cancelled', endedAt: null }],
      ['an interrupted download without an end time', { state: 'interrupted', endedAt: null }],
      ['a download that ended before it started', { endedAt: T0 }],
    ] as const)('refuses %s with a CHECK error', (_name, overrides) => {
      const { db, call } = setup();

      expect(sqliteErrorCode(() => call('downloads.upsert', download(1, overrides)))).toBe(
        'SQLITE_CONSTRAINT_CHECK',
      );
      expect(db.prepare('SELECT count(*) FROM downloads').pluck().get()).toBe(0);
    });

    it('leaves the stored row as it was when an update is refused', () => {
      const { call } = setup();
      call('downloads.upsert', download(1));

      const code = sqliteErrorCode(() =>
        call('downloads.upsert', download(1, { fileName: 'changed.pdf', state: 'progressing' })),
      );

      expect(code).toBe('SQLITE_CONSTRAINT_CHECK');
      expect(listed(call)).toEqual([download(1)]);
    });
  });

  describe('downloads.delete', () => {
    it('removes one download and counts it', () => {
      const { call } = setup();
      call('downloads.upsert', download(1));
      call('downloads.upsert', download(2));

      expect(call('downloads.delete', { id: testId(201) })).toEqual({ count: 1 });

      expect(listed(call).map((row) => row.id)).toEqual([testId(202)]);
    });

    it('counts zero for a download that is not there', () => {
      const { call } = setup();
      call('downloads.upsert', download(1));

      expect(call('downloads.delete', { id: testId(299) })).toEqual({ count: 0 });
      expect(listed(call)).toHaveLength(1);
    });
  });

  describe('downloads.clear', () => {
    it('removes every download and counts them', () => {
      const { call } = setup();
      for (let n = 1; n <= 3; n += 1) {
        call('downloads.upsert', download(n));
      }

      expect(call('downloads.clear', {})).toEqual({ count: 3 });

      expect(listed(call)).toEqual([]);
    });

    it('counts zero when the history is already empty', () => {
      expect(setup().call('downloads.clear', {})).toEqual({ count: 0 });
    });
  });
});
