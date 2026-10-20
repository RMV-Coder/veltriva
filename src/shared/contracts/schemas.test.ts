import { describe, expect, it } from 'vitest';

import { COMMAND_NAMES } from './ipc';
import { commandSchemas } from './schemas';

const snapshot = commandSchemas['workspace.getSnapshot'].output;
const dismiss = commandSchemas['notices.dismiss'];

function withNotices(notices: unknown): unknown {
  return { version: 1, selectedTabId: null, tabs: [], fullscreen: null, downloads: [], notices };
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
