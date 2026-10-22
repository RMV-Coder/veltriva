import { describe, expect, it } from 'vitest';

import { PROTECTION_REASONS } from '../../core/lifecycle/protections';
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
  unloadPressure: null,
  movedBy: null,
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
      activityVersion: 3,
      automation: {
        paused: false,
        preview: true,
        previewUntilDay: 3,
        activeDay: 2,
        pressure: 'none',
      },
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

describe('projectTab: the lifecycle why (M3.4)', () => {
  const unloaded = (overrides: Partial<TabState> = {}): TabState => ({
    ...base,
    runtime: 'unloaded',
    ...overrides,
  });

  describe('unloadPressure', () => {
    it.each(['moderate', 'critical'] as const)(
      'says how low memory was for a tab pressure unloaded (%s)',
      (pressure) => {
        const tab = unloaded({ unloadedBy: 'pressure', unloadPressure: pressure });

        expect(projectTab(tab)).toMatchObject({ unloadedBy: 'pressure', unloadPressure: pressure });
      },
    );

    it.each(['automation', 'user'] as const)(
      'is null for a tab %s unloaded, even if a stale pressure is left on the state',
      (unloadedBy) => {
        const tab = unloaded({ unloadedBy, unloadPressure: 'critical' });

        expect(projectTab(tab)).toMatchObject({ unloadedBy, unloadPressure: null });
      },
    );

    it('is null for a tab pressure unloaded that has no pressure on record', () => {
      expect(projectTab(unloaded({ unloadedBy: 'pressure', unloadPressure: null }))).toMatchObject({
        unloadedBy: 'pressure',
        unloadPressure: null,
      });
    });

    it.each(['live', 'creating', 'frozen', 'discarding', 'crashed'] as const)(
      'is null, with unloadedBy, once the tab is %s again, whatever the state still holds',
      (runtime) => {
        const tab: TabState = {
          ...base,
          runtime,
          unloadedBy: 'pressure',
          unloadPressure: 'moderate',
        };

        expect(projectTab(tab)).toMatchObject({ unloadedBy: null, unloadPressure: null });
      },
    );
  });

  describe('movedBy', () => {
    it.each(['automation', 'user'] as const)('names who moved a Sleeping tab (%s)', (movedBy) => {
      expect(projectTab({ ...base, placement: 'shelf', movedBy }).movedBy).toBe(movedBy);
    });

    it('is null for a Sleeping tab whose mover is unknown', () => {
      expect(projectTab({ ...base, placement: 'shelf', movedBy: null }).movedBy).toBeNull();
    });

    it.each(['automation', 'user'] as const)(
      'is null in the strip, whatever the state still holds (%s)',
      (movedBy) => {
        expect(projectTab({ ...base, placement: 'strip', movedBy }).movedBy).toBeNull();
      },
    );
  });

  describe('keptAwake and previewMove', () => {
    it('have no reasons and no preview when nothing was added', () => {
      expect(projectTab(base)).toMatchObject({ keptAwake: [], previewMove: null });
      expect(projectTab(base, {})).toMatchObject({ keptAwake: [], previewMove: null });
    });

    it('carry the reasons in the order given', () => {
      expect(
        projectTab(base, { keptAwake: ['user-protected', 'audio', 'recent-interaction'] })
          .keptAwake,
      ).toEqual(['user-protected', 'audio', 'recent-interaction']);
    });

    it('carry a copy of the reasons: changing the source later changes nothing', () => {
      const reasons: ('audio' | 'video')[] = ['audio'];
      const snapshot = projectTab(base, { keptAwake: reasons });

      reasons.push('video');

      expect(snapshot.keptAwake).toEqual(['audio']);
      expect(snapshot.keptAwake).not.toBe(reasons);
    });

    it.each(['shelve', 'archive'] as const)('carry the move preview would make (%s)', (move) => {
      expect(projectTab(base, { previewMove: move }).previewMove).toBe(move);
    });

    it('carry no move for null', () => {
      expect(projectTab(base, { previewMove: null }).previewMove).toBeNull();
    });

    it('go beside a toolbar question and blocked popups without disturbing them', () => {
      const snapshot = projectTab(base, {
        keptAwake: ['video'],
        previewMove: 'shelve',
        blockedPopups: { count: 2, latestUrl: 'https://example.com/pop' },
      });

      expect(snapshot).toMatchObject({
        keptAwake: ['video'],
        previewMove: 'shelve',
        prompt: null,
        blockedPopups: { count: 2, latest: 'https://example.com/pop' },
      });
    });

    it('are projected for every reason the table has, as the contract accepts them', () => {
      const withReasons = projectTab(base, { keptAwake: [...PROTECTION_REASONS] });

      expect(withReasons.keptAwake).toEqual([...PROTECTION_REASONS]);
      expect(
        commandSchemas['workspace.getSnapshot'].output.safeParse({
          ...emptySnapshot(),
          tabs: [withReasons],
        }).success,
      ).toBe(true);
    });
  });

  it('gives a snapshot of any tab the contract accepts', () => {
    const tabs = [
      projectTab(base),
      projectTab(unloaded({ unloadedBy: 'pressure', unloadPressure: 'critical' })),
      projectTab({ ...base, placement: 'shelf', movedBy: 'user' }, { previewMove: 'archive' }),
      projectTab(base, { keptAwake: ['fullscreen', 'notifications'] }),
    ];

    expect(
      commandSchemas['workspace.getSnapshot'].output.safeParse({ ...emptySnapshot(), tabs })
        .success,
    ).toBe(true);
  });
});

/** A snapshot with nothing in it, for the contract to look at. */
function emptySnapshot(): WorkspaceSnapshot {
  return {
    version: 1,
    selectedTabId: null,
    tabs: [],
    fullscreen: null,
    downloads: [],
    notices: [],
    sleeping: [],
    archived: [],
    counts: { sleeping: 0, archived: 0, archivedToday: 0 },
    undo: null,
    activityVersion: 0,
    automation: {
      paused: false,
      preview: false,
      previewUntilDay: 0,
      activeDay: 0,
      pressure: 'none',
    },
  };
}

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
        activityVersion: 0,
        automation: {
          paused: false,
          preview: false,
          previewUntilDay: 0,
          activeDay: 0,
          pressure: 'none',
        },
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

describe('WorkspaceProjector: what automation shows (M3.4)', () => {
  const OTHER = '01a13cdb-cc00-7000-8000-000000000002';
  const SLEEPER = '01a13cdb-cc00-7000-8000-000000000003';
  const sleeper: TabState = {
    ...base,
    id: SLEEPER,
    placement: 'shelf',
    runtime: 'unloaded',
    movedBy: 'automation',
  };
  const accepted = (snapshot: WorkspaceSnapshot): boolean =>
    commandSchemas['workspace.getSnapshot'].output.safeParse(snapshot).success;

  it('reports nothing going on when no automation is wired in', () => {
    const projector = createWorkspaceProjector({
      tabs: () => [base],
      selectedTabId: () => ID,
      publish: () => undefined,
    });
    const snapshot = projector.snapshot();

    expect(snapshot.automation).toEqual({
      paused: false,
      preview: false,
      previewUntilDay: 0,
      activeDay: 0,
      pressure: 'none',
    });
    expect(accepted(snapshot)).toBe(true);
  });

  it('reports what automation says, read afresh for every snapshot', () => {
    let automation: WorkspaceSnapshot['automation'] = {
      paused: false,
      preview: true,
      previewUntilDay: 3,
      activeDay: 1,
      pressure: 'none',
    };
    const projector = createWorkspaceProjector({
      tabs: () => [base],
      selectedTabId: () => ID,
      automation: () => automation,
      publish: () => undefined,
    });

    expect(projector.snapshot().automation).toEqual(automation);

    automation = {
      paused: true,
      preview: false,
      previewUntilDay: 3,
      activeDay: 4,
      pressure: 'critical',
    };
    const second = projector.snapshot();

    expect(second.automation).toEqual(automation);
    expect(accepted(second)).toBe(true);
  });

  it('asks the extras of a Sleeping tab as it does of a tab in the strip', () => {
    const asked: string[] = [];
    const projector = createWorkspaceProjector({
      tabs: () => [base],
      sleeping: () => [sleeper],
      selectedTabId: () => ID,
      extrasFor: (tabId) => {
        asked.push(tabId);
        return tabId === SLEEPER
          ? { keptAwake: ['notifications'], previewMove: 'archive' }
          : { keptAwake: ['audio'] };
      },
      publish: () => undefined,
    });
    const snapshot = projector.snapshot();

    expect(asked.sort()).toEqual([ID, SLEEPER].sort());
    expect(snapshot.tabs[0]).toMatchObject({ keptAwake: ['audio'], previewMove: null });
    expect(snapshot.sleeping[0]).toMatchObject({
      id: SLEEPER,
      keptAwake: ['notifications'],
      previewMove: 'archive',
      movedBy: 'automation',
    });
    expect(accepted(snapshot)).toBe(true);
  });

  it('gives a Sleeping tab no extras, nothing kept awake, when none are wired in', () => {
    const projector = createWorkspaceProjector({
      tabs: () => [base],
      sleeping: () => [sleeper],
      selectedTabId: () => ID,
      publish: () => undefined,
    });

    expect(projector.snapshot().sleeping[0]).toMatchObject({
      keptAwake: [],
      previewMove: null,
      movedBy: 'automation',
    });
  });

  it('projects the strip and Sleeping from the same asked extras, tab by tab', () => {
    const extras = new Map([
      [ID, { keptAwake: ['user-protected', 'video'] as const }],
      [OTHER, { previewMove: 'shelve' as const }],
    ]);
    const projector = createWorkspaceProjector({
      tabs: () => [base, { ...base, id: OTHER }],
      selectedTabId: () => ID,
      extrasFor: (tabId) => extras.get(tabId) ?? {},
      publish: () => undefined,
    });
    const snapshot = projector.snapshot();

    expect(snapshot.tabs.map((tab) => [tab.id, tab.keptAwake, tab.previewMove])).toEqual([
      [ID, ['user-protected', 'video'], null],
      [OTHER, [], 'shelve'],
    ]);
    expect(accepted(snapshot)).toBe(true);
  });
});
