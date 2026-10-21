import { describe, expect, it, vi } from 'vitest';

import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import { createRepositoryHandlers } from './index';
import { WORKSPACE_ID, addWorkspace, testId, useTestDatabase } from './test-database';

describe('createRepositoryHandlers', () => {
  const database = useTestDatabase();

  it('has a handler for every method except the server-owned db.* and maintenance.* ones', () => {
    const handlers = createRepositoryHandlers(database());

    const expected = Object.keys(DATA_METHODS)
      .filter((method) => !method.startsWith('db.') && !method.startsWith('maintenance.'))
      .sort();

    expect(Object.keys(handlers).sort()).toEqual(expected);
  });

  it('prepares its statements once, when it is created, and never per call', () => {
    const db = database();
    addWorkspace(db);
    const prepare = vi.spyOn(db, 'prepare');
    const handlers = createRepositoryHandlers(db);
    const preparedAtStart = prepare.mock.calls.length;
    const tab = {
      id: testId(100),
      workspaceId: WORKSPACE_ID,
      placement: 'strip',
      position: 0,
      pinned: false,
      userProtected: false,
      pageId: null,
      url: 'https://example.com/',
      title: 'Example',
      faviconId: null,
      restoreState: null,
      openerTabId: null,
      createdAt: 1,
      lastUsedAt: 1,
      lastUsedEngaged: 1,
      lastUsedActiveDay: 1,
      placementChangedAt: 1,
      archivedAt: null,
      archiveReason: null,
      closedAt: null,
    } as const;
    const permission = {
      origin: 'https://a.example',
      permission: 'camera',
      decision: 'allow',
      updatedAt: 1,
    } as const;
    const download = {
      id: testId(300),
      fileName: 'a.pdf',
      path: 'C:\\a.pdf',
      url: 'https://a.example/a.pdf',
      site: '',
      state: 'completed',
      dangerous: false,
      confirmed: true,
      receivedBytes: 1,
      totalBytes: 1,
      startedAt: 1,
      endedAt: 2,
    } as const;

    for (let round = 0; round < 2; round += 1) {
      handlers['workspaces.ensureDefault']({ candidateId: testId(1), name: 'Main', now: 1 });
      handlers['tabs.upsertMany']({ tabs: [tab] });
      handlers['tabs.list']({ workspaceId: WORKSPACE_ID, placement: 'strip', limit: 10 });
      handlers['tabs.deleteMany']({ ids: [tab.id] });
      handlers['appState.set']({ key: 'session', value: { round } });
      handlers['appState.get']({ key: 'session' });
      handlers['appState.delete']({ key: 'session' });
      const { id } = handlers['appRuns.start']({ startedAt: 1, appVersion: '0.1.0' });
      handlers['appRuns.heartbeat']({ id, at: 2 });
      handlers['appRuns.end']({ id, at: 3, exitKind: 'clean' });
      handlers['appRuns.recent']({ limit: 5 });
      handlers['settings.set']({ value: { round } });
      handlers['settings.get']({});
      handlers['permissions.set'](permission);
      handlers['permissions.list']({ limit: 5 });
      handlers['permissions.delete']({ origin: permission.origin });
      handlers['permissions.delete']({ origin: permission.origin, permission: 'camera' });
      handlers['downloads.upsert'](download);
      handlers['downloads.list']({ limit: 5 });
      handlers['downloads.delete']({ id: download.id });
      handlers['downloads.clear']({});
      // Twice over, so a visit both creates the page (round 0) and updates it (round 1).
      const { pageId } = handlers['history.recordVisit']({
        page: {
          urlKey: 'https://a.example/',
          url: 'https://a.example/',
          host: 'a.example',
          site: 'a.example',
          title: '',
        },
        transition: 'link',
        visitedAt: 1 + round,
        tabId: null,
      });
      if (pageId === null) {
        throw new Error('the site is not excluded, so the visit is recorded');
      }
      handlers['history.updatePage']({ pageId, title: 'A' });
      handlers['history.pages']({ limit: 5 });
      handlers['history.visits']({ pageId, limit: 5 });
    }

    expect(preparedAtStart).toBeGreaterThan(0);
    expect(prepare).toHaveBeenCalledTimes(preparedAtStart);
  });
});
