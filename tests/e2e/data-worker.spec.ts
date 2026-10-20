// M2.1a: the data worker in the real app (ADR-0004). The database opens in the profile folder, on
// a worker thread, and main reaches it only through the validating RPC client. Nothing in the
// shell uses it yet, so these specs talk to it through the test hooks.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ElectronApplication } from '@playwright/test';

import { expect, test } from './fixtures';

type DataResult = { ok: true; value: unknown } | { ok: false; code: string };

function dataCall(app: ElectronApplication, method: string, input: unknown): Promise<DataResult> {
  return app.evaluate(
    (_electron, request) => {
      const hooks = globalThis.__veltrivaTest;
      if (hooks === undefined) {
        throw new Error('not a test build');
      }
      return hooks.dataCall(request.method, request.input);
    },
    { method, input },
  );
}

async function waitForData(app: ElectronApplication): Promise<void> {
  await expect
    .poll(() => app.evaluate(() => globalThis.__veltrivaTest?.dataState()), { timeout: 30_000 })
    .toBe('ready');
}

const NOW = Date.UTC(2026, 9, 21);
const WORKSPACE = '0199f000-0000-7000-8000-000000000001';
const TAB = '0199f000-0000-7000-8000-0000000000a1';

test.describe('the data worker', () => {
  test('opens the database in the profile, on its own thread, with the ADR-0004 pragmas', async ({
    electronApp,
    userDataDir,
  }) => {
    await waitForData(electronApp);
    const info = await dataCall(electronApp, 'db.info', {});
    expect(info).toMatchObject({
      ok: true,
      value: {
        userVersion: 1,
        latestVersion: 1,
        journalMode: 'wal',
        autoVacuum: 2,
        synchronous: 1,
        foreignKeys: 1,
        secureDelete: 1,
        busyTimeout: 5000,
        tempStore: 2,
        cacheSize: -16000,
      },
    });
    // threadId 0 is main's thread.
    expect(info.ok && (info.value as { threadId: number }).threadId).toBeGreaterThan(0);
    expect(existsSync(join(userDataDir, 'veltriva.db'))).toBe(true);
  });

  test("never loads SQLite's native addon into main's own module registry", async ({
    electronApp,
  }) => {
    await waitForData(electronApp);
    // The worker has loaded better-sqlite3 by now (it answered db.info) in its own registry.
    expect(await dataCall(electronApp, 'db.info', {})).toMatchObject({ ok: true });
    expect(
      await electronApp.evaluate(() => globalThis.__veltrivaTest?.mainNativeModules()),
    ).toEqual([]);
  });

  test('writes and reads rows through the worker, and refuses what the contract refuses', async ({
    electronApp,
  }) => {
    await waitForData(electronApp);
    expect(
      await dataCall(electronApp, 'workspaces.ensureDefault', {
        candidateId: WORKSPACE,
        name: 'Default',
        now: NOW,
      }),
    ).toEqual({ ok: true, value: { id: WORKSPACE, created: true } });

    const tab = {
      id: TAB,
      workspaceId: WORKSPACE,
      placement: 'strip',
      position: 0,
      pinned: false,
      userProtected: false,
      pageId: null,
      url: 'http://127.0.0.1/page.html',
      title: 'A page',
      faviconId: null,
      restoreState: {
        v: 1,
        index: 0,
        entries: [{ url: 'http://127.0.0.1/page.html', title: 'A page' }],
      },
      openerTabId: null,
      createdAt: NOW,
      lastUsedAt: NOW,
      lastUsedEngaged: 0,
      lastUsedActiveDay: 0,
      placementChangedAt: NOW,
      archivedAt: null,
      archiveReason: null,
      closedAt: null,
    };
    expect(await dataCall(electronApp, 'tabs.upsertMany', { tabs: [tab] })).toEqual({
      ok: true,
      value: { count: 1 },
    });
    expect(
      await dataCall(electronApp, 'tabs.list', {
        workspaceId: WORKSPACE,
        placement: 'strip',
        limit: 10,
      }),
    ).toEqual({ ok: true, value: { tabs: [tab] } });

    // Refused by the contract in main, before anything reaches the worker.
    expect(
      await dataCall(electronApp, 'tabs.list', { workspaceId: WORKSPACE, placement: 'strip' }),
    ).toEqual({ ok: false, code: 'invalid_input' });
    // Refused by the schema's CHECK in the worker: an archived tab needs archived_at.
    expect(
      await dataCall(electronApp, 'tabs.upsertMany', { tabs: [{ ...tab, placement: 'archive' }] }),
    ).toEqual({ ok: false, code: 'invalid_input' });
    expect(await dataCall(electronApp, 'tabs.drop', {})).toEqual({
      ok: false,
      code: 'unknown_method',
    });
  });
});
