import { describe, expect, it } from 'vitest';

import { commandSchemas } from '../../shared/contracts/schemas';
import type { WorkspaceSnapshot } from '../../shared/contracts/schemas';
import { AppNotices } from '../notices/app-notices';
import type { AppNotice } from '../notices/app-notices';
import type { TabState } from './tab-manager';
import {
  createWorkspaceProjector,
  noticeFileName,
  projectNotice,
  projectTab,
} from './workspace-projector';

const ID = '01a13cdb-cc00-7000-8000-000000000001';

const base: TabState = {
  id: ID,
  pinned: false,
  placement: 'strip',
  userProtected: false,
  unloadedBy: null,
  ephemeral: false,
  runtime: 'live',
  page: { kind: 'web' },
  url: 'https://user:pw@example.com/a',
  credentialsRemoved: false,
  title: 'Example',
  favicon: null,
  loading: false,
  canGoBack: true,
  canGoForward: false,
  zoomPercent: 100,
  find: null,
};

describe('projectTab', () => {
  it('warns when credentials were removed from a typed address before it loaded', () => {
    const typed: TabState = { ...base, url: 'https://evil.example/', credentialsRemoved: true };
    expect(projectTab(typed).address).toEqual({
      text: 'https://evil.example/',
      security: 'secure',
      hadCredentials: true,
    });
    expect(projectTab({ ...typed, credentialsRemoved: false }).address.hadCredentials).toBe(false);
  });

  it('shows the address rebuilt from the URL, never page text', () => {
    expect(projectTab(base).address).toEqual({
      text: 'https://example.com/a',
      security: 'secure',
      hadCredentials: true,
    });
  });

  it('gives a new-tab page an empty address', () => {
    expect(
      projectTab({ ...base, url: '', page: { kind: 'internal', name: 'new-tab' } }),
    ).toMatchObject({
      address: { text: '', security: 'neutral', hadCredentials: false },
      page: { kind: 'internal', name: 'new-tab' },
    });
  });

  it('passes error details through for error pages', () => {
    expect(
      projectTab({
        ...base,
        page: {
          kind: 'internal',
          name: 'network-error',
          error: { code: -105, name: 'ERR_NAME_NOT_RESOLVED' },
        },
      }).page,
    ).toEqual({
      kind: 'internal',
      name: 'network-error',
      error: { code: -105, name: 'ERR_NAME_NOT_RESOLVED' },
    });
  });

  it('produces snapshots that satisfy the contract', () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      selectedTabId: ID,
      tabs: [
        projectTab({ ...base, zoomPercent: 110, find: { text: 'a', activeMatch: 1, matches: 3 } }),
      ],
      fullscreen: { tabId: ID, origin: 'example.com', notice: true },
      downloads: [],
      sleeping: [projectTab({ ...base, placement: 'shelf', runtime: 'unloaded' })],
      archived: [],
      counts: { sleeping: 1, archived: 0, archivedToday: 0 },
      undo: { batchId: 'batch-1', automated: true, shelved: 1, archived: 0 },
      notices: [
        {
          id: 'notice-1',
          kind: 'database-restored',
          backupAt: Date.UTC(2026, 9, 21, 8, 30),
          corruptFile: 'veltriva.db.corrupt-2026-10-21T08-30-00Z',
        },
        { id: 'notice-2', kind: 'database-reset', corruptFile: 'veltriva.db.corrupt-x' },
      ],
    };
    expect(commandSchemas['workspace.getSnapshot'].output.safeParse(snapshot).success).toBe(true);
  });
});

const CORRUPT = 'veltriva.db.corrupt-2026-10-21T08-30-00Z';
const BACKUP_AT = Date.UTC(2026, 9, 21, 8, 30);

describe('noticeFileName', () => {
  it('keeps a real name as it is', () => {
    expect(noticeFileName(CORRUPT)).toBe(CORRUPT);
  });

  it('shows only the name when a path comes in, whichever separator it uses', () => {
    expect(noticeFileName(`C:\\Users\\someone\\AppData\\Roaming\\Veltriva\\${CORRUPT}`)).toBe(
      CORRUPT,
    );
    expect(noticeFileName(`/home/someone/${CORRUPT}`)).toBe(CORRUPT);
    expect(noticeFileName('../../etc/passwd')).toBe('passwd');
  });

  it('replaces controls, bidi overrides, invisible marks and the characters Windows forbids', () => {
    // A right-to-left override, a null, a bell, a zero-width space, a line separator, a colon,
    // a star, a question mark, quotes, angle brackets and a bar.
    const hostile = 'evil\u202Egnp.exe\u0000\u0007\u200B\u2028:*?"<>|x';
    const cleaned = noticeFileName(hostile);
    // The override, then four controls and marks, then the seven forbidden characters.
    expect(cleaned).toBe(`evil_gnp.exe${'_'.repeat(11)}x`);
    for (const forbidden of [
      '\u202E',
      '\u0000',
      '\u0007',
      '\u200B',
      '\u2028',
      ':',
      '*',
      '?',
      '"',
    ]) {
      expect(cleaned.includes(forbidden), JSON.stringify(forbidden)).toBe(false);
    }
  });

  it('is never empty', () => {
    expect(noticeFileName('')).toBe('(unnamed)');
    expect(noticeFileName('C:\\folder\\')).toBe('(unnamed)');
    expect(noticeFileName('/')).toBe('(unnamed)');
  });

  it('is cut to the 260 characters the contract allows, never inside a surrogate pair', () => {
    expect(noticeFileName('a'.repeat(1000))).toHaveLength(260);
    // 259 letters, then a character outside the BMP (two code units): it would end at 261.
    const cut = noticeFileName('a'.repeat(259) + '\u{1F4BE}');
    expect(cut).toBe('a'.repeat(259));
    expect(noticeFileName('a'.repeat(258) + '\u{1F4BE}')).toHaveLength(260);
  });

  it('always satisfies the contract, whatever comes in', () => {
    const accepts = (name: string): boolean =>
      commandSchemas['workspace.getSnapshot'].output.safeParse({
        version: 1,
        selectedTabId: null,
        tabs: [],
        fullscreen: null,
        downloads: [],
        notices: [{ id: 'notice-1', kind: 'database-reset', corruptFile: noticeFileName(name) }],
        sleeping: [],
        archived: [],
        counts: { sleeping: 0, archived: 0, archivedToday: 0 },
        undo: null,
      }).success;
    for (const name of [
      '',
      '/',
      '\u0000',
      '\u202E',
      'a/b\\c',
      '.'.repeat(500),
      '\uD800',
      'x'.repeat(300),
      '\u{1F4BE}'.repeat(200),
    ]) {
      expect(accepts(name), JSON.stringify(name)).toBe(true);
    }
  });
});

describe('projectNotice', () => {
  it('copies a restore with its backup time', () => {
    const notice: AppNotice = {
      id: 'notice-4',
      kind: 'database-restored',
      backupAt: BACKUP_AT,
      corruptFile: CORRUPT,
    };
    expect(projectNotice(notice)).toEqual({
      id: 'notice-4',
      kind: 'database-restored',
      backupAt: BACKUP_AT,
      corruptFile: CORRUPT,
    });
  });

  it('copies a reset, which has no backup time', () => {
    const notice: AppNotice = { id: 'notice-5', kind: 'database-reset', corruptFile: CORRUPT };
    expect(projectNotice(notice)).toStrictEqual({
      id: 'notice-5',
      kind: 'database-reset',
      corruptFile: CORRUPT,
    });
  });

  it('cleans the file name, and keeps a time the contract can hold', () => {
    const hostile = projectNotice({
      id: 'notice-6',
      kind: 'database-restored',
      backupAt: Number.NaN,
      corruptFile: 'a\u202Eb/c\u0000d',
    });
    expect(hostile).toEqual({
      id: 'notice-6',
      kind: 'database-restored',
      backupAt: 0,
      corruptFile: 'c_d',
    });
    const far = projectNotice({
      id: 'notice-7',
      kind: 'database-restored',
      backupAt: 1e300,
      corruptFile: CORRUPT,
    });
    expect(far).toMatchObject({ backupAt: Number.MAX_SAFE_INTEGER });
  });
});

describe('the notices in the workspace snapshot', () => {
  function setup() {
    const timers: (() => void)[] = [];
    const published: WorkspaceSnapshot[] = [];
    const notices = new AppNotices();
    const projector = createWorkspaceProjector({
      tabs: () => [base],
      selectedTabId: () => ID,
      notices,
      publish: (snapshot) => published.push(snapshot),
      schedule: (callback) => timers.push(callback),
      cancel: () => {
        timers.length = 0;
      },
    });
    const flush = (): void => {
      for (const timer of timers.splice(0)) {
        timer();
      }
    };
    return { projector, notices, published, timers, flush };
  }

  it('has none until main raises one', () => {
    expect(setup().projector.snapshot().notices).toEqual([]);
  });

  it('lists them oldest first, as the contract accepts them', () => {
    const { projector, notices } = setup();
    const first = notices.show({
      kind: 'database-restored',
      backupAt: BACKUP_AT,
      corruptFile: CORRUPT,
    });
    const second = notices.show({ kind: 'database-reset', corruptFile: 'veltriva.db.corrupt-b' });
    const snapshot = projector.snapshot();
    expect(snapshot.notices.map((notice) => notice.id)).toEqual([first, second]);
    expect(snapshot.notices.map((notice) => notice.kind)).toEqual([
      'database-restored',
      'database-reset',
    ]);
    expect(commandSchemas['workspace.getSnapshot'].output.safeParse(snapshot).success).toBe(true);
  });

  it('keeps the three newest, which is all the contract allows', () => {
    const { projector, notices } = setup();
    const ids = [1, 2, 3, 4].map(() =>
      notices.show({ kind: 'database-reset', corruptFile: CORRUPT }),
    );
    const snapshot = projector.snapshot();
    expect(snapshot.notices.map((notice) => notice.id)).toEqual(ids.slice(1));
    expect(commandSchemas['workspace.getSnapshot'].output.safeParse(snapshot).success).toBe(true);
  });

  it('schedules a snapshot when a notice is raised and when it is dismissed', () => {
    const { notices, published, timers, flush } = setup();
    const id = notices.show({ kind: 'database-reset', corruptFile: CORRUPT });
    expect(timers).toHaveLength(1);
    flush();
    expect(published.at(-1)?.notices.map((notice) => notice.id)).toEqual([id]);

    expect(notices.dismiss(id)).toBe(true);
    expect(timers).toHaveLength(1);
    flush();
    expect(published.at(-1)?.notices).toEqual([]);
    expect(published).toHaveLength(2);
  });

  it('coalesces several notices into the same single snapshot', () => {
    const { notices, published, timers, flush } = setup();
    notices.show({ kind: 'database-reset', corruptFile: CORRUPT });
    notices.show({ kind: 'database-reset', corruptFile: CORRUPT });
    expect(timers).toHaveLength(1);
    flush();
    expect(published).toHaveLength(1);
    expect(published[0]?.notices).toHaveLength(2);
  });

  it('shows a hostile name cleaned, and the whole snapshot still satisfies the contract', () => {
    const { projector, notices } = setup();
    notices.show({
      kind: 'database-reset',
      corruptFile: 'C:\\x\\evil\u202Egnp.exe\u0000\u0007',
    });
    const snapshot = projector.snapshot();
    expect(snapshot.notices[0]).toMatchObject({ corruptFile: 'evil_gnp.exe__' });
    expect(commandSchemas['workspace.getSnapshot'].output.safeParse(snapshot).success).toBe(true);
  });

  it('stops listening to notices once disposed', () => {
    const { projector, notices, timers } = setup();
    projector.dispose();
    notices.show({ kind: 'database-reset', corruptFile: CORRUPT });
    expect(timers).toHaveLength(0);
  });
});

describe('WorkspaceProjector', () => {
  function setup() {
    const timers: (() => void)[] = [];
    const published: WorkspaceSnapshot[] = [];
    let tabs: TabState[] = [base];
    const projector = createWorkspaceProjector({
      tabs: () => tabs,
      selectedTabId: () => tabs[0]?.id ?? null,
      publish: (snapshot) => published.push(snapshot),
      schedule: (callback) => timers.push(callback),
      cancel: () => {
        timers.length = 0;
      },
    });
    const flush = (): void => {
      for (const timer of timers.splice(0)) {
        timer();
      }
    };
    return {
      projector,
      published,
      flush,
      timers,
      setTabs: (next: TabState[]) => {
        tabs = next;
      },
    };
  }

  it('coalesces a burst of changes into one snapshot', () => {
    const { projector, published, flush, timers } = setup();
    for (let i = 0; i < 50; i += 1) {
      projector.markDirty();
    }
    expect(timers).toHaveLength(1);
    flush();
    expect(published).toHaveLength(1);
  });

  it('publishes the latest state with increasing versions', () => {
    const { projector, published, flush, setTabs } = setup();
    projector.markDirty();
    flush();
    setTabs([{ ...base, title: 'Changed' }]);
    projector.markDirty();
    flush();
    expect(published.map((snapshot) => snapshot.version)).toEqual([1, 2]);
    expect(published[1]?.tabs[0]?.title).toBe('Changed');
    expect(projector.snapshot().version).toBe(3);
  });

  it('drops a pending snapshot when disposed', () => {
    const { projector, published, flush } = setup();
    projector.markDirty();
    projector.dispose();
    flush();
    expect(published).toHaveLength(0);
  });

  it('schedules nothing once disposed, though the tabs keep changing as they close', () => {
    const { projector, published, flush, timers } = setup();
    projector.dispose();
    projector.markDirty();
    expect(timers).toHaveLength(0);
    flush();
    expect(published).toHaveLength(0);
  });
});
