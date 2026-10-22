import { describe, expect, it } from 'vitest';

import { uuidv7 } from '../../core/id/uuidv7';
import { COMMAND_NAMES } from './ipc';
import { commandSchemas, MAX_LISTED_ARCHIVED } from './schemas';

const snapshot = commandSchemas['workspace.getSnapshot'].output;
const dismiss = commandSchemas['notices.dismiss'];

/** What every snapshot has besides its tabs, downloads and notices (M3.3: Sleeping, the Archive). */
const PLACEMENT_FIELDS = {
  sleeping: [],
  archived: [],
  counts: { sleeping: 0, archived: 0, archivedToday: 0 },
  undo: null,
  activityVersion: 0,
} as const;

function withNotices(notices: unknown): unknown {
  return {
    version: 1,
    selectedTabId: null,
    tabs: [],
    fullscreen: null,
    downloads: [],
    notices,
    ...PLACEMENT_FIELDS,
  };
}

const restored = {
  id: 'notice-1',
  kind: 'database-restored',
  backupAt: Date.UTC(2026, 9, 21, 8, 30),
  corruptFile: 'veltriva.db.corrupt-2026-10-21T08-30-00Z',
};
const reset = { id: 'notice-2', kind: 'database-reset', corruptFile: 'veltriva.db.corrupt-x' };

describe('notices in the workspace snapshot', () => {
  it('accepts both kinds, and none', () => {
    expect(snapshot.safeParse(withNotices([])).success).toBe(true);
    expect(snapshot.safeParse(withNotices([restored, reset])).success).toBe(true);
  });

  it('requires the field: a snapshot without it is not a snapshot', () => {
    expect(
      snapshot.safeParse({
        version: 1,
        selectedTabId: null,
        tabs: [],
        fullscreen: null,
        downloads: [],
        ...PLACEMENT_FIELDS,
      }).success,
    ).toBe(false);
  });

  it('allows three notices and no more', () => {
    const three = [1, 2, 3].map((n) => ({ ...reset, id: `notice-${String(n)}` }));
    expect(snapshot.safeParse(withNotices(three)).success).toBe(true);
    expect(snapshot.safeParse(withNotices([...three, { ...reset, id: 'notice-4' }])).success).toBe(
      false,
    );
  });

  it('accepts only ids of the form notice-N', () => {
    for (const id of ['notice-1', 'notice-0', 'notice-123456789012345']) {
      expect(snapshot.safeParse(withNotices([{ ...reset, id }])).success, id).toBe(true);
    }
    for (const id of [
      '',
      'notice-',
      'notice-x',
      'notice-1234567890123456',
      'notice--1',
      'notice-1 ',
      ' notice-1',
      'notice-1\n',
      'Notice-1',
      'prompt-1',
      'download-1',
    ]) {
      expect(snapshot.safeParse(withNotices([{ ...reset, id }])).success, JSON.stringify(id)).toBe(
        false,
      );
    }
  });

  it('accepts only a kind it knows, and keys that belong to it', () => {
    expect(snapshot.safeParse(withNotices([{ ...reset, kind: 'something-else' }])).success).toBe(
      false,
    );
    // A reset has no backup time, and unknown keys are refused, never stripped.
    expect(snapshot.safeParse(withNotices([{ ...reset, backupAt: 1 }])).success).toBe(false);
    expect(snapshot.safeParse(withNotices([{ ...restored, extra: true }])).success).toBe(false);
    const withoutTime = Object.fromEntries(
      Object.entries(restored).filter(([key]) => key !== 'backupAt'),
    );
    expect(snapshot.safeParse(withNotices([withoutTime])).success).toBe(false);
  });

  it('accepts a backup time only as a whole, non-negative, safe number of milliseconds', () => {
    for (const backupAt of [0, 1, Date.UTC(2026, 9, 21), Number.MAX_SAFE_INTEGER]) {
      expect(
        snapshot.safeParse(withNotices([{ ...restored, backupAt }])).success,
        String(backupAt),
      ).toBe(true);
    }
    for (const backupAt of [
      -1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 2,
      '1',
      null,
    ]) {
      expect(
        snapshot.safeParse(withNotices([{ ...restored, backupAt }])).success,
        String(backupAt),
      ).toBe(false);
    }
  });

  it('accepts only a file name: bounded, with no path, forbidden character or control', () => {
    for (const corruptFile of ['a', 'veltriva.db.corrupt-2026-10-21T08-30-00Z', 'x'.repeat(260)]) {
      expect(snapshot.safeParse(withNotices([{ ...reset, corruptFile }])).success).toBe(true);
    }
    for (const corruptFile of [
      '',
      'x'.repeat(261),
      'dir/file',
      'dir\\file',
      '../file',
      'C:file',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      'a\u0000b',
      'a\nb',
      'a\u007Fb',
      'a\u0085b',
      42,
      null,
    ]) {
      expect(
        snapshot.safeParse(withNotices([{ ...reset, corruptFile }])).success,
        JSON.stringify(corruptFile),
      ).toBe(false);
    }
  });
});

describe('notices.dismiss', () => {
  it('is a command, with a schema', () => {
    expect(COMMAND_NAMES).toContain('notices.dismiss');
  });

  it('takes a notice id and nothing else, and answers with nothing', () => {
    expect(dismiss.input.safeParse({ noticeId: 'notice-12' }).success).toBe(true);
    expect(dismiss.output.safeParse({}).success).toBe(true);
    expect(dismiss.output.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('refuses everything else', () => {
    for (const input of [
      undefined,
      null,
      [],
      'notice-1',
      42,
      {},
      { noticeId: '' },
      { noticeId: 'notice-' },
      { noticeId: 'notice-1234567890123456' },
      { noticeId: 'notice-1/../x' },
      { noticeId: 'download-1' },
      { noticeId: 7 },
      { noticeId: 'notice-1', keepFocus: true },
      { noticeId: 'notice-1', extra: 1 },
    ]) {
      expect(dismiss.input.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe('download ids', () => {
  const DOWNLOAD_ID = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(9));
  const DOWNLOAD_COMMANDS = [
    'downloads.pause',
    'downloads.resume',
    'downloads.cancel',
    'downloads.open',
    'downloads.showInFolder',
    'downloads.keep',
    'downloads.discard',
    'downloads.clear',
  ] as const;
  const download = (id: unknown) => ({
    id,
    fileName: 'report.pdf',
    state: 'completed',
    receivedBytes: 10,
    totalBytes: 10,
    dangerous: false,
    confirmed: true,
    canResume: false,
    site: 'example.com',
  });
  const withDownloads = (downloads: unknown) => ({
    version: 1,
    selectedTabId: null,
    tabs: [],
    fullscreen: null,
    downloads,
    notices: [],
    ...PLACEMENT_FIELDS,
  });
  const snapshotAccepts = (id: unknown): boolean =>
    snapshot.safeParse(withDownloads([download(id)])).success;

  const BAD_IDS = [
    ['the old download-N handle', 'download-1'],
    ['the old handle with many digits', 'download-123456789012'],
    ['a notice id', 'notice-1'],
    ['a tab-style handle', 'tab-1'],
    ['an empty string', ''],
    ['a path', String.raw`C:\Users\me\Downloads\a.pdf`],
    ['a UUIDv7 in capitals', DOWNLOAD_ID.toUpperCase()],
    ['a UUIDv4', '123e4567-e89b-42d3-a456-426614174000'],
    ['a UUID of another version', '123e4567-e89b-12d3-a456-426614174000'],
    ['a UUIDv7 with an invalid variant', '0199f000-0000-7000-c000-000000000001'],
    ['a UUID with a character that is not hex', '0199f000-0000-7000-8000-00000000000g'],
    ['a UUID without its dashes', '0199f00000007000800000000000001'.padEnd(32, '0')],
    ['a UUID with a space after it', `${DOWNLOAD_ID} `],
    ['a UUID with a newline after it', `${DOWNLOAD_ID}\n`],
    ['two UUIDs', `${DOWNLOAD_ID}${DOWNLOAD_ID}`],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
  ] as const;

  it('is a UUIDv7 in the workspace snapshot', () => {
    expect(snapshotAccepts(DOWNLOAD_ID)).toBe(true);
  });

  it('is any UUIDv7: its time and random bits are the row key', () => {
    for (const [time, fill] of [
      [0, 0],
      [1_700_000_000_000, 255],
      [2 ** 48 - 1, 128],
    ] as const) {
      expect(snapshotAccepts(uuidv7(time, new Uint8Array(10).fill(fill))), String(time)).toBe(true);
    }
  });

  it.each(BAD_IDS)('is not %s, in the snapshot', (_what, id) => {
    expect(snapshotAccepts(id)).toBe(false);
  });

  it('refuses a snapshot with one good download and one with an old id', () => {
    expect(
      snapshot.safeParse(withDownloads([download(DOWNLOAD_ID), download('download-2')])).success,
    ).toBe(false);
  });

  it('keeps accepting a list of downloads each with its own UUIDv7', () => {
    const many = Array.from({ length: 5 }, (_, n) =>
      download(uuidv7(1_700_000_000_000 + n, new Uint8Array(10).fill(n))),
    );

    expect(snapshot.safeParse(withDownloads(many)).success).toBe(true);
  });

  it('still allows at most 100 downloads in the snapshot', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, n) =>
        download(uuidv7(1_700_000_000_000 + n, new Uint8Array(10).fill(n % 256))),
      );

    expect(snapshot.safeParse(withDownloads(many(100))).success).toBe(true);
    expect(snapshot.safeParse(withDownloads(many(101))).success).toBe(false);
  });

  describe.each(DOWNLOAD_COMMANDS)('%s', (command) => {
    const { input, output } = commandSchemas[command];

    it('is a command, with a schema', () => {
      expect(COMMAND_NAMES).toContain(command);
    });

    it('takes a download id that is a UUIDv7, and answers with nothing', () => {
      expect(input.safeParse({ downloadId: DOWNLOAD_ID }).success).toBe(true);
      expect(output.safeParse({}).success).toBe(true);
      expect(output.safeParse({ extra: 1 }).success).toBe(false);
    });

    it.each(BAD_IDS)('refuses %s as the download id', (_what, downloadId) => {
      expect(input.safeParse({ downloadId }).success).toBe(false);
    });

    it('refuses a missing id, a key more, and input that is not an object', () => {
      for (const bad of [
        undefined,
        null,
        [],
        DOWNLOAD_ID,
        {},
        { id: DOWNLOAD_ID },
        { downloadId: DOWNLOAD_ID, path: String.raw`C:\a.pdf` },
        { downloadId: DOWNLOAD_ID, extra: true },
      ]) {
        expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });
  });

  it('is not a notice id, and a notice id is not a download id', () => {
    expect(dismiss.input.safeParse({ noticeId: DOWNLOAD_ID }).success).toBe(false);
    expect(
      commandSchemas['downloads.clear'].input.safeParse({ downloadId: 'notice-1' }).success,
    ).toBe(false);
  });
});

describe('Sleeping, the Archive and Undo in the snapshot (M3.3)', () => {
  const TAB_ID = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(3));
  const archivedTab = (overrides: Record<string, unknown> = {}) => ({
    id: TAB_ID,
    title: 'A page',
    address: { text: 'example.com/a', security: 'secure', hadCredentials: false },
    favicon: null,
    archivedAt: Date.UTC(2026, 9, 22, 9),
    reason: 'auto',
    ...overrides,
  });
  const withPlacement = (fields: Record<string, unknown>) => ({
    version: 1,
    selectedTabId: null,
    tabs: [],
    fullscreen: null,
    downloads: [],
    notices: [],
    ...PLACEMENT_FIELDS,
    ...fields,
  });

  it('accepts archived tabs and an Undo offer', () => {
    expect(
      snapshot.safeParse(
        withPlacement({
          archived: [archivedTab(), archivedTab({ reason: 'manual' })],
          counts: { sleeping: 4, archived: 250, archivedToday: 2 },
          undo: { batchId: 'batch-12', automated: true, shelved: 3, archived: 1 },
        }),
      ).success,
    ).toBe(true);
    expect(
      snapshot.safeParse(
        withPlacement({ undo: { batchId: 'manual-1', automated: false, shelved: 1, archived: 0 } }),
      ).success,
    ).toBe(true);
  });

  it('requires the new fields', () => {
    for (const field of ['sleeping', 'archived', 'counts', 'undo']) {
      const value = Object.fromEntries(
        Object.entries(withPlacement({})).filter(([key]) => key !== field),
      );
      expect(snapshot.safeParse(value).success, field).toBe(false);
    }
  });

  it('refuses an archived tab without a reason it knows, or with a page favicon URL', () => {
    expect(
      snapshot.safeParse(withPlacement({ archived: [archivedTab({ reason: 'x' })] })).success,
    ).toBe(false);
    expect(
      snapshot.safeParse(
        withPlacement({ archived: [archivedTab({ favicon: 'https://example.com/favicon.ico' })] }),
      ).success,
    ).toBe(false);
  });

  it('lists at most MAX_LISTED_ARCHIVED archived tabs', () => {
    const many = (count: number) => Array.from({ length: count }, () => archivedTab());
    expect(snapshot.safeParse(withPlacement({ archived: many(MAX_LISTED_ARCHIVED) })).success).toBe(
      true,
    );
    expect(
      snapshot.safeParse(withPlacement({ archived: many(MAX_LISTED_ARCHIVED + 1) })).success,
    ).toBe(false);
  });

  it('accepts only batch ids of the form batch-N or manual-N', () => {
    const undo = commandSchemas['lifecycle.undo'].input;
    for (const batchId of ['batch-1', 'manual-7', 'batch-123456789012345']) {
      expect(undo.safeParse({ batchId }).success, batchId).toBe(true);
    }
    for (const batchId of [
      '',
      'batch-',
      'auto-1',
      'batch-x',
      'batch-1 ',
      'batch-1234567890123456',
    ]) {
      expect(undo.safeParse({ batchId }).success, batchId).toBe(false);
    }
  });

  it('takes a tab id for the placement commands, and nothing more', () => {
    for (const name of ['tabs.shelve', 'tabs.archive'] as const) {
      expect(commandSchemas[name].input.safeParse({ tabId: TAB_ID }).success).toBe(true);
      expect(commandSchemas[name].input.safeParse({ tabId: TAB_ID, extra: 1 }).success).toBe(false);
    }
    const protect = commandSchemas['tabs.setProtected'].input;
    expect(protect.safeParse({ tabId: TAB_ID, protected: true }).success).toBe(true);
    expect(protect.safeParse({ tabId: TAB_ID }).success).toBe(false);
  });
});
