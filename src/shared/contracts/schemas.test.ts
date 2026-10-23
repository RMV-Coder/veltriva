import { describe, expect, it } from 'vitest';

import { uuidv7 } from '../../core/id/uuidv7';
import { LIFECYCLE_RULES, PRESET_VALUES } from '../../core/lifecycle/policy';
import { PROTECTION_REASONS } from '../../core/lifecycle/protections';
import { SEARCH_ENGINES } from '../../core/url/search-engines';
import { COMMAND_NAMES } from './ipc';
import { commandSchemas, MAX_LISTED_ARCHIVED } from './schemas';
import {
  DEFAULT_PRESSURE_PERCENT,
  DEFAULT_SETTINGS,
  OVERRIDE_LIMITS,
  settingsChangeSchema,
} from './settings';

const snapshot = commandSchemas['workspace.getSnapshot'].output;
const dismiss = commandSchemas['notices.dismiss'];

/** What automation reports when it runs unpaused and unobserved (M3.4). */
const AUTOMATION = {
  paused: false,
  preview: false,
  previewUntilDay: 0,
  activeDay: 0,
  pressure: 'none',
} as const;

/**
 * What every snapshot has besides its tabs, downloads and notices (M3.3: Sleeping, the Archive;
 * M3.4: what automation is doing).
 */
const PLACEMENT_FIELDS = {
  sleeping: [],
  archived: [],
  counts: { sleeping: 0, archived: 0, archivedToday: 0 },
  undo: null,
  activityVersion: 0,
  automation: AUTOMATION,
} as const;

/** The object without one of its keys. */
function withoutKey(object: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}

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
    for (const field of [
      'sleeping',
      'archived',
      'counts',
      'undo',
      'activityVersion',
      'automation',
    ]) {
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

describe('the why, preview and automation in the snapshot (M3.4)', () => {
  const TAB_ID = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(4));
  const tab = (overrides: Record<string, unknown> = {}) => ({
    id: TAB_ID,
    pinned: false,
    title: 'A page',
    address: { text: 'example.com/a', security: 'secure', hadCredentials: false },
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    runtime: 'live',
    unloadedBy: null,
    unloadPressure: null,
    userProtected: false,
    keptAwake: [],
    previewMove: null,
    movedBy: null,
    page: { kind: 'web' },
    zoomPercent: 100,
    find: null,
    prompt: null,
    blockedPopups: null,
    ...overrides,
  });
  const withFields = (fields: Record<string, unknown>) => ({
    version: 1,
    selectedTabId: null,
    tabs: [],
    fullscreen: null,
    downloads: [],
    notices: [],
    ...PLACEMENT_FIELDS,
    ...fields,
  });
  const accepts = (fields: Record<string, unknown>): boolean =>
    snapshot.safeParse(withFields(fields)).success;
  const tabAccepts = (overrides: Record<string, unknown>): boolean =>
    accepts({ tabs: [tab(overrides)] });

  it('accepts a tab with the fixture fields, to make the refusals below mean something', () => {
    expect(tabAccepts({})).toBe(true);
  });

  describe.each(['tabs', 'sleeping'] as const)('a tab in %s', (list) => {
    const acceptsHere = (overrides: Record<string, unknown>): boolean =>
      accepts({ [list]: [tab(overrides)] });

    it.each(['unloadPressure', 'keptAwake', 'previewMove', 'movedBy'])('must carry %s', (field) => {
      expect(accepts({ [list]: [withoutKey(tab(), field)] })).toBe(false);
    });

    it('refuses a key it does not know', () => {
      expect(acceptsHere({ keptAwakeSince: 1 })).toBe(false);
    });

    it.each(['moderate', 'critical', null])('accepts %s as unloadPressure', (unloadPressure) => {
      expect(acceptsHere({ unloadPressure })).toBe(true);
    });

    it.each(['none', 'high', 'Moderate', '', 1, true, undefined])(
      'refuses %j as unloadPressure',
      (unloadPressure) => {
        expect(acceptsHere({ unloadPressure })).toBe(false);
      },
    );

    it.each(['shelve', 'archive', null])('accepts %s as previewMove', (previewMove) => {
      expect(acceptsHere({ previewMove })).toBe(true);
    });

    it.each(['discard', 'freeze', 'restore', '', 0, false, undefined])(
      'refuses %j as previewMove',
      (previewMove) => {
        expect(acceptsHere({ previewMove })).toBe(false);
      },
    );

    it.each(['automation', 'user', null])('accepts %s as movedBy', (movedBy) => {
      expect(acceptsHere({ movedBy })).toBe(true);
    });

    it.each(['pressure', 'system', '', 0, false, undefined])('refuses %j as movedBy', (movedBy) => {
      expect(acceptsHere({ movedBy })).toBe(false);
    });
  });

  describe('keptAwake', () => {
    it('lists every reason of the table, which is what the sidebar can say', () => {
      expect(tabAccepts({ keptAwake: [...PROTECTION_REASONS] })).toBe(true);
    });

    it.each([...PROTECTION_REASONS])('accepts %s alone', (reason) => {
      expect(tabAccepts({ keptAwake: [reason] })).toBe(true);
    });

    it('accepts none, and a few', () => {
      expect(tabAccepts({ keptAwake: [] })).toBe(true);
      expect(tabAccepts({ keptAwake: ['audio', 'recent-interaction'] })).toBe(true);
    });

    it('holds no more than there are reasons', () => {
      const one = PROTECTION_REASONS[0];

      expect(
        tabAccepts({ keptAwake: Array.from({ length: PROTECTION_REASONS.length }, () => one) }),
      ).toBe(true);
      expect(
        tabAccepts({ keptAwake: Array.from({ length: PROTECTION_REASONS.length + 1 }, () => one) }),
      ).toBe(false);
    });

    it.each([
      ['a reason that does not exist', ['sleepy']],
      ['text written by a page', ['<b>audio</b>']],
      ['the wrong case', ['Audio']],
      ['a number', [3]],
      ['null', [null]],
      ['an object', [{ reason: 'audio' }]],
    ])('refuses %s among the reasons', (_what, bad) => {
      expect(tabAccepts({ keptAwake: ['audio', ...bad] })).toBe(false);
    });

    it.each([
      ['null', null],
      ['a string', 'audio'],
      ['an object', { audio: true }],
      ['undefined', undefined],
    ])('refuses %s instead of a list', (_what, keptAwake) => {
      expect(tabAccepts({ keptAwake })).toBe(false);
    });
  });

  describe('automation', () => {
    it('accepts the quiet state, paused, previewing, and a state under pressure', () => {
      expect(accepts({ automation: AUTOMATION })).toBe(true);
      expect(accepts({ automation: { ...AUTOMATION, paused: true } })).toBe(true);
      expect(
        accepts({
          automation: { ...AUTOMATION, preview: true, previewUntilDay: 3, activeDay: 2 },
        }),
      ).toBe(true);
      expect(accepts({ automation: { ...AUTOMATION, pressure: 'moderate' } })).toBe(true);
      expect(accepts({ automation: { ...AUTOMATION, pressure: 'critical' } })).toBe(true);
    });

    it('is required, whole: a snapshot without it is not a snapshot', () => {
      expect(snapshot.safeParse(withoutKey(withFields({}), 'automation')).success).toBe(false);
    });

    it.each(['paused', 'preview', 'previewUntilDay', 'activeDay', 'pressure'])(
      'is not complete without %s',
      (field) => {
        expect(accepts({ automation: withoutKey({ ...AUTOMATION }, field) })).toBe(false);
      },
    );

    it('refuses a key it does not know, and a value that is not an object', () => {
      expect(accepts({ automation: { ...AUTOMATION, extra: true } })).toBe(false);
      for (const automation of [null, [], 'running', true, 0]) {
        expect(accepts({ automation }), JSON.stringify(automation)).toBe(false);
      }
    });

    it.each(['paused', 'preview'])('takes %s only as a boolean', (field) => {
      for (const value of [0, 1, 'true', 'false', null]) {
        expect(accepts({ automation: { ...AUTOMATION, [field]: value } }), String(value)).toBe(
          false,
        );
      }
    });

    it.each(['previewUntilDay', 'activeDay'])(
      'takes %s as a whole, non-negative number',
      (field) => {
        for (const value of [0, 1, 3, 40_000]) {
          expect(accepts({ automation: { ...AUTOMATION, [field]: value } }), String(value)).toBe(
            true,
          );
        }
        for (const value of [-1, 1.5, Number.NaN, Infinity, '3', null]) {
          expect(accepts({ automation: { ...AUTOMATION, [field]: value } }), String(value)).toBe(
            false,
          );
        }
      },
    );

    it('takes the pressure as none, moderate or critical', () => {
      for (const pressure of ['low', 'high', 'normal', '', null, 0]) {
        expect(accepts({ automation: { ...AUTOMATION, pressure } }), String(pressure)).toBe(false);
      }
    });
  });
});

describe('the commands of M3.4', () => {
  const TAB_ID = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(5));
  const NEW_COMMANDS = [
    'lifecycle.setPaused',
    'lifecycle.endPreview',
    'tabs.setSiteProtected',
    'lifecycle.diagnostics',
  ] as const;

  it.each(NEW_COMMANDS)('%s is a command, with a schema', (name) => {
    expect(COMMAND_NAMES).toContain(name);
    expect(commandSchemas[name].input).toBeDefined();
    expect(commandSchemas[name].output).toBeDefined();
  });

  it('has a schema for every command and a command for every schema', () => {
    expect(Object.keys(commandSchemas).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  describe('lifecycle.setPaused', () => {
    const { input, output } = commandSchemas['lifecycle.setPaused'];

    it('takes the new state, as a boolean, and answers with nothing', () => {
      expect(input.safeParse({ paused: true }).success).toBe(true);
      expect(input.safeParse({ paused: false }).success).toBe(true);
      expect(output.safeParse({}).success).toBe(true);
      expect(output.safeParse({ paused: true }).success).toBe(false);
    });

    it('refuses everything else', () => {
      for (const bad of [
        undefined,
        null,
        [],
        true,
        {},
        { paused: 'true' },
        { paused: 1 },
        { paused: null },
        { pause: true },
        { paused: true, extra: 1 },
      ]) {
        expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });
  });

  describe('lifecycle.endPreview', () => {
    const { input, output } = commandSchemas['lifecycle.endPreview'];

    it('takes nothing and answers with nothing', () => {
      expect(input.safeParse({}).success).toBe(true);
      expect(output.safeParse({}).success).toBe(true);
    });

    it('refuses any key, and anything that is not an object', () => {
      for (const bad of [undefined, null, [], 'now', { now: true }, { extra: 1 }]) {
        expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
      expect(output.safeParse({ ended: true }).success).toBe(false);
    });
  });

  describe('tabs.setSiteProtected', () => {
    const { input, output } = commandSchemas['tabs.setSiteProtected'];

    it('takes a tab id and the new state', () => {
      expect(input.safeParse({ tabId: TAB_ID, protected: true }).success).toBe(true);
      expect(input.safeParse({ tabId: TAB_ID, protected: false }).success).toBe(true);
    });

    it('refuses a missing field, another type, an id that is not a UUIDv7 and a key more', () => {
      for (const bad of [
        undefined,
        null,
        [],
        {},
        { tabId: TAB_ID },
        { protected: true },
        { tabId: TAB_ID, protected: 'yes' },
        { tabId: TAB_ID, protected: 1 },
        { tabId: 'tab-1', protected: true },
        { tabId: '', protected: true },
        { tabId: 7, protected: true },
        { tabId: TAB_ID, protected: true, site: 'example.com' },
        { tabId: TAB_ID, protected: true, extra: 1 },
      ]) {
        expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });

    it('answers with the site it changed, at most 253 characters, and nothing else', () => {
      expect(output.safeParse({ site: 'example.com' }).success).toBe(true);
      expect(output.safeParse({ site: 'a'.repeat(253) }).success).toBe(true);
      expect(output.safeParse({ site: 'a'.repeat(254) }).success).toBe(false);
      expect(output.safeParse({}).success).toBe(false);
      expect(output.safeParse({ site: 'example.com', protected: true }).success).toBe(false);
      expect(output.safeParse({ site: 7 }).success).toBe(false);
      expect(output.safeParse({ site: null }).success).toBe(false);
    });
  });

  describe('lifecycle.diagnostics', () => {
    const { input, output } = commandSchemas['lifecycle.diagnostics'];
    const event = (overrides: Record<string, unknown> = {}) => ({
      at: 1_700_000_000_000,
      how: 'restore',
      action: 'shelve',
      rule: 'shelve-beyond-cap',
      afterEngagedMs: 120_000,
      ...overrides,
    });
    const diagnostics = (overrides: Record<string, unknown> = {}) => ({
      regret: {
        since: 1_700_000_000_000,
        moves: 12,
        moveRegrets: 1,
        unloads: 30,
        unloadRegrets: 2,
        events: [event()],
      },
      engagement: { activeDay: 4, engagedMs: 5_400_000.5 },
      settings: {
        preset: 'balanced',
        paused: false,
        preview: true,
        protectedSites: ['example.com'],
      },
      pressure: 'none',
      memory: { totalMb: 16_384, availableMb: 8_000.25 },
      // M5.3
      tabs: [
        {
          tabId: TAB_ID,
          title: 'Example',
          placement: 'strip',
          runtime: 'live',
          privateKb: 120_000,
          sharedWith: 0,
        },
      ],
      processes: { browserKb: 90_000, gpuKb: 60_000, otherKb: 30_000 },
      automation: {
        lastDay: { discard: 1, freeze: 0, shelve: 2, archive: 0, undo: 1 },
        kept: { discard: 9, freeze: 0, shelve: 4, archive: 3, undo: 1 },
      },
      pressureHistory: [{ at: 1_700_000_000_000, level: 'moderate' }],
      database: {
        sizeBytes: 1_000_000,
        walBytes: 0,
        lastBackupAt: null,
        lastCheckAt: 1_700_000_000_000,
        lastCheckOk: true,
      },
      logging: { enabled: false, file: 'C:\\profile\\logs\\veltriva.log' },
      ...overrides,
    });
    const accepts = (value: unknown): boolean => output.safeParse(value).success;
    /** The diagnostics with `change` applied to the regret part. */
    const withRegret = (change: Record<string, unknown>) =>
      diagnostics({ regret: { ...diagnostics().regret, ...change } });

    it('takes nothing', () => {
      expect(input.safeParse({}).success).toBe(true);
      for (const bad of [undefined, null, [], { tab: 1 }]) {
        expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });

    it('answers with the regret metric, the engagement, the settings, the pressure and the memory', () => {
      expect(accepts(diagnostics())).toBe(true);
    });

    it('answers for a browser that has not moved anything yet', () => {
      expect(
        accepts(withRegret({ moves: 0, moveRegrets: 0, unloads: 0, unloadRegrets: 0, events: [] })),
      ).toBe(true);
    });

    it.each(['regret', 'engagement', 'settings', 'pressure', 'memory'])(
      'is not complete without %s',
      (key) => {
        expect(accepts(withoutKey(diagnostics(), key))).toBe(false);
      },
    );

    it('takes a tab without a renderer, no database, and an empty history (M5.3)', () => {
      expect(
        accepts(
          diagnostics({
            tabs: [
              {
                tabId: TAB_ID,
                title: '',
                placement: 'shelf',
                runtime: 'unloaded',
                privateKb: null,
                sharedWith: 0,
              },
            ],
            pressureHistory: [],
            database: null,
          }),
        ),
      ).toBe(true);
    });

    it('refuses an unknown runtime, a fractional memory, or a history of more than 50 (M5.3)', () => {
      const tab = diagnostics().tabs[0];
      expect(accepts(diagnostics({ tabs: [{ ...tab, runtime: 'sleeping' }] }))).toBe(false);
      expect(accepts(diagnostics({ tabs: [{ ...tab, privateKb: 1.5 }] }))).toBe(false);
      expect(
        accepts(
          diagnostics({
            pressureHistory: Array.from({ length: 51 }, () => ({ at: 1, level: 'none' })),
          }),
        ),
      ).toBe(false);
    });

    it('refuses a key it does not know, at every level', () => {
      expect(accepts({ ...diagnostics(), extra: 1 })).toBe(false);
      expect(accepts(withRegret({ extra: 1 }))).toBe(false);
      expect(accepts(withRegret({ events: [event({ extra: 1 })] }))).toBe(false);
      expect(accepts(diagnostics({ engagement: { activeDay: 1, engagedMs: 1, extra: 1 } }))).toBe(
        false,
      );
      expect(
        accepts(
          diagnostics({
            settings: { ...diagnostics().settings, extra: 1 },
          }),
        ),
      ).toBe(false);
      expect(accepts(diagnostics({ memory: { totalMb: 1, availableMb: 1, extra: 1 } }))).toBe(
        false,
      );
    });

    describe('regret', () => {
      it.each(['since', 'moves', 'moveRegrets', 'unloads', 'unloadRegrets', 'events'])(
        'is not complete without %s',
        (key) => {
          expect(accepts(diagnostics({ regret: withoutKey(diagnostics().regret, key) }))).toBe(
            false,
          );
        },
      );

      it.each(['since', 'moves', 'moveRegrets', 'unloads', 'unloadRegrets'])(
        'counts %s in whole, non-negative numbers',
        (key) => {
          expect(accepts(withRegret({ [key]: 0 }))).toBe(true);
          for (const value of [-1, 1.5, Number.NaN, Infinity, '3', null]) {
            expect(accepts(withRegret({ [key]: value })), String(value)).toBe(false);
          }
        },
      );

      it('lists at most 200 events', () => {
        expect(accepts(withRegret({ events: Array.from({ length: 200 }, () => event()) }))).toBe(
          true,
        );
        expect(accepts(withRegret({ events: Array.from({ length: 201 }, () => event()) }))).toBe(
          false,
        );
      });

      it.each(['restore', 'undo', 'reload'])('accepts %s as how a move was undone', (how) => {
        expect(accepts(withRegret({ events: [event({ how })] }))).toBe(true);
      });

      it.each(['click', 'close', '', null, 0])('refuses %j as how', (how) => {
        expect(accepts(withRegret({ events: [event({ how })] }))).toBe(false);
      });

      it.each(['shelve', 'archive', 'discard'])('accepts %s as the action regretted', (action) => {
        expect(accepts(withRegret({ events: [event({ action })] }))).toBe(true);
      });

      it.each(['freeze', 'restore', '', null])('refuses %j as the action', (action) => {
        expect(accepts(withRegret({ events: [event({ action })] }))).toBe(false);
      });

      it.each([...LIFECYCLE_RULES])('accepts the rule %s', (rule) => {
        expect(accepts(withRegret({ events: [event({ rule })] }))).toBe(true);
      });

      it.each(['shelve', 'discard', 'manual', '', null])('refuses %j as the rule', (rule) => {
        expect(accepts(withRegret({ events: [event({ rule })] }))).toBe(false);
      });

      it.each(['at', 'afterEngagedMs'])('takes %s as a whole, non-negative number', (key) => {
        expect(accepts(withRegret({ events: [event({ [key]: 0 })] }))).toBe(true);
        for (const value of [-1, 0.5, Number.NaN, Infinity, '1', null]) {
          expect(accepts(withRegret({ events: [event({ [key]: value })] })), String(value)).toBe(
            false,
          );
        }
      });

      it('is not complete for an event missing a field', () => {
        for (const key of ['at', 'how', 'action', 'rule', 'afterEngagedMs']) {
          expect(accepts(withRegret({ events: [withoutKey(event(), key)] })), key).toBe(false);
        }
      });
    });

    describe('engagement', () => {
      it('counts the active day in whole numbers and the engaged time in any non-negative number', () => {
        expect(accepts(diagnostics({ engagement: { activeDay: 0, engagedMs: 0 } }))).toBe(true);
        expect(accepts(diagnostics({ engagement: { activeDay: 1, engagedMs: 1.5 } }))).toBe(true);
        expect(accepts(diagnostics({ engagement: { activeDay: 1.5, engagedMs: 1 } }))).toBe(false);
        expect(accepts(diagnostics({ engagement: { activeDay: -1, engagedMs: 1 } }))).toBe(false);
        expect(accepts(diagnostics({ engagement: { activeDay: 1, engagedMs: -1 } }))).toBe(false);
        expect(accepts(diagnostics({ engagement: { activeDay: 1, engagedMs: Infinity } }))).toBe(
          false,
        );
        expect(accepts(diagnostics({ engagement: { activeDay: 1, engagedMs: Number.NaN } }))).toBe(
          false,
        );
      });

      it('is not complete without either field', () => {
        expect(accepts(diagnostics({ engagement: { activeDay: 1 } }))).toBe(false);
        expect(accepts(diagnostics({ engagement: { engagedMs: 1 } }))).toBe(false);
      });
    });

    describe('settings', () => {
      const settings = (overrides: Record<string, unknown>) =>
        diagnostics({ settings: { ...diagnostics().settings, ...overrides } });

      it('names the preset in at most 32 characters', () => {
        expect(accepts(settings({ preset: 'a'.repeat(32) }))).toBe(true);
        expect(accepts(settings({ preset: 'a'.repeat(33) }))).toBe(false);
        expect(accepts(settings({ preset: 7 }))).toBe(false);
      });

      it('takes paused and preview as booleans', () => {
        for (const key of ['paused', 'preview']) {
          expect(accepts(settings({ [key]: true }))).toBe(true);
          expect(accepts(settings({ [key]: 'on' })), key).toBe(false);
          expect(accepts(settings({ [key]: null })), key).toBe(false);
        }
      });

      it('lists at most 1,000 protected sites, each of at most 253 characters', () => {
        expect(accepts(settings({ protectedSites: [] }))).toBe(true);
        expect(
          accepts(
            settings({
              protectedSites: Array.from({ length: 1000 }, (_, n) => `s${String(n)}.example`),
            }),
          ),
        ).toBe(true);
        expect(
          accepts(
            settings({
              protectedSites: Array.from({ length: 1001 }, (_, n) => `s${String(n)}.example`),
            }),
          ),
        ).toBe(false);
        expect(accepts(settings({ protectedSites: ['a'.repeat(253)] }))).toBe(true);
        expect(accepts(settings({ protectedSites: ['a'.repeat(254)] }))).toBe(false);
        expect(accepts(settings({ protectedSites: [7] }))).toBe(false);
      });
    });

    describe('pressure and memory', () => {
      it.each(['none', 'moderate', 'critical'])('accepts the pressure %s', (pressure) => {
        expect(accepts(diagnostics({ pressure }))).toBe(true);
      });

      it.each(['low', 'high', '', null, 0])('refuses %j as the pressure', (pressure) => {
        expect(accepts(diagnostics({ pressure }))).toBe(false);
      });

      it('takes the memory in any non-negative number, and refuses a negative or infinite one', () => {
        expect(accepts(diagnostics({ memory: { totalMb: 0, availableMb: 0 } }))).toBe(true);
        expect(accepts(diagnostics({ memory: { totalMb: -1, availableMb: 0 } }))).toBe(false);
        expect(accepts(diagnostics({ memory: { totalMb: 1, availableMb: -0.5 } }))).toBe(false);
        expect(accepts(diagnostics({ memory: { totalMb: Infinity, availableMb: 0 } }))).toBe(false);
        expect(accepts(diagnostics({ memory: { totalMb: 1 } }))).toBe(false);
      });
    });
  });
});

describe('the commands of M5.1: settings', () => {
  const NEW_COMMANDS = [
    'settings.get',
    'settings.update',
    'settings.setSiteRule',
    'settings.open',
  ] as const;

  /** A view as main sends it: the defaults, the real presets, limits and engines. */
  const VIEW = {
    settings: DEFAULT_SETTINGS,
    previewActive: true,
    siteRules: [{ site: 'example.com', protect: true, excludeMemory: false }],
    presets: PRESET_VALUES,
    limits: OVERRIDE_LIMITS,
    pressureDefaults: DEFAULT_PRESSURE_PERCENT,
    searchEngines: [...SEARCH_ENGINES],
  };

  it.each(NEW_COMMANDS)('%s is a command, with a schema', (name) => {
    expect(COMMAND_NAMES).toContain(name);
    expect(commandSchemas[name].input).toBeDefined();
    expect(commandSchemas[name].output).toBeDefined();
  });

  it('settings.update takes exactly the strict change schema: main rejects what it rejects', () => {
    expect(commandSchemas['settings.update'].input).toBe(settingsChangeSchema);
  });

  describe('the settings view', () => {
    const { output } = commandSchemas['settings.get'];

    it('is what main sends', () => {
      expect(output.parse(VIEW)).toEqual(VIEW);
      expect(commandSchemas['settings.update'].output.safeParse(VIEW).success).toBe(true);
      expect(commandSchemas['settings.setSiteRule'].output.safeParse(VIEW).success).toBe(true);
    });

    it.each([
      ['an invalid document', { ...VIEW, settings: { ...DEFAULT_SETTINGS, startup: 'blank' } }],
      [
        'thresholds out of order',
        {
          ...VIEW,
          settings: {
            ...DEFAULT_SETTINGS,
            lifecycle: {
              ...DEFAULT_SETTINGS.lifecycle,
              overrides: { moderatePressurePercent: 4, criticalPressurePercent: 4 },
            },
          },
        },
      ],
      [
        'a document with the old site list',
        {
          ...VIEW,
          settings: {
            ...DEFAULT_SETTINGS,
            lifecycle: { ...DEFAULT_SETTINGS.lifecycle, protectedSites: [] },
          },
        },
      ],
      [
        'a rule without a site',
        { ...VIEW, siteRules: [{ site: '', protect: true, excludeMemory: false }] },
      ],
      ['a missing preset', { ...VIEW, presets: { balanced: PRESET_VALUES.balanced } }],
      ['a missing limit', { ...VIEW, limits: { stripCap: { min: 1, max: 500 } } }],
      ['an unknown field', { ...VIEW, extra: 1 }],
    ])('refuses %s, so a bad answer never reaches the page', (_what, view) => {
      expect(output.safeParse(view).success).toBe(false);
    });
  });

  describe('settings.setSiteRule', () => {
    const { input } = commandSchemas['settings.setSiteRule'];

    it('takes what the user typed and one rule or both; main reads the site from it', () => {
      for (const good of [
        { site: 'example.com', protect: true },
        { site: 'https://mail.example.com/inbox', excludeMemory: true },
        { site: 'example.com', protect: false, excludeMemory: false },
        { site: 'Example.COM' },
      ]) {
        expect(input.safeParse(good).success, JSON.stringify(good)).toBe(true);
      }
    });

    it('refuses an empty or oversized text, a rule of the wrong type, and anything else', () => {
      for (const bad of [
        {},
        { site: '' },
        { site: 'x'.repeat(2049) },
        { site: 'example.com', protect: 'yes' },
        { site: 'example.com', exclude: true },
        { site: 7 },
        null,
      ]) {
        expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });
  });

  it('settings.get and settings.open take nothing', () => {
    expect(commandSchemas['settings.get'].input.safeParse({}).success).toBe(true);
    expect(commandSchemas['settings.open'].input.safeParse({}).success).toBe(true);
    expect(commandSchemas['settings.open'].input.safeParse({ page: 'settings' }).success).toBe(
      false,
    );
    expect(commandSchemas['settings.open'].output.safeParse({}).success).toBe(true);
  });
});

describe('the commands of M5.2: clearing data and stored answers', () => {
  const TAB_ID = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(9));
  const NEW_COMMANDS = [
    'privacy.clear',
    'privacy.forgetSite',
    'memory.remove',
    'permissions.list',
    'permissions.change',
  ] as const;

  it.each(NEW_COMMANDS)('%s is a command, with a schema', (name) => {
    expect(COMMAND_NAMES).toContain(name);
    expect(commandSchemas[name].input).toBeDefined();
  });

  it('privacy.clear takes a range and four choices, and nothing else', () => {
    const { input } = commandSchemas['privacy.clear'];
    const good = { range: 'hour', memory: true, tabs: false, siteData: false, cache: false };
    expect(input.safeParse(good).success).toBe(true);
    for (const range of ['hour', 'day', 'week', 'all']) {
      expect(input.safeParse({ ...good, range }).success).toBe(true);
    }
    for (const bad of [
      { ...good, range: 'month' },
      { ...good, range: 0 },
      { ...good, since: 0 },
      { ...good, memory: 'yes' },
      { range: 'hour' },
      null,
    ]) {
      expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('memory.remove takes a page and, optionally, the tab showing it', () => {
    const { input } = commandSchemas['memory.remove'];
    expect(input.safeParse({ pageId: 4 }).success).toBe(true);
    expect(input.safeParse({ pageId: 4, tabId: TAB_ID }).success).toBe(true);
    for (const bad of [{}, { pageId: 0 }, { pageId: 1.5 }, { pageId: 4, tabId: 'tab' }]) {
      expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('permissions.change is one of three changes, each strict', () => {
    const { input } = commandSchemas['permissions.change'];
    for (const good of [
      { kind: 'decision', origin: 'https://a.example', permission: 'camera', decision: 'block' },
      {
        kind: 'decision',
        origin: 'https://a.example',
        permission: 'notifications',
        decision: null,
      },
      { kind: 'protocol', origin: 'https://a.example', scheme: 'zoommtg' },
      { kind: 'clientHints', origin: 'https://a.example' },
    ]) {
      expect(input.safeParse(good).success, JSON.stringify(good)).toBe(true);
    }
    for (const bad of [
      { kind: 'decision', origin: 'https://a.example', permission: 'usb', decision: 'allow' },
      { kind: 'decision', origin: 'https://a.example', permission: 'camera', decision: 'ask' },
      { kind: 'protocol', origin: 'https://a.example' },
      { kind: 'everything' },
      { kind: 'clientHints', origin: '' },
    ]) {
      expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the permissions list is what main sends, and refuses an unknown permission', () => {
    const { output } = commandSchemas['permissions.list'];
    const view = {
      decisions: [{ origin: 'https://a.example', permission: 'camera', decision: 'allow' }],
      protocols: [{ origin: 'https://a.example', scheme: 'mailto' }],
      clientHints: [{ origin: 'https://b.example', hints: ['sec-ch-ua-arch'] }],
    };
    expect(output.parse(view)).toEqual(view);
    expect(
      output.safeParse({
        ...view,
        decisions: [{ origin: 'https://a.example', permission: 'usb', decision: 'allow' }],
      }).success,
    ).toBe(false);
  });
});
