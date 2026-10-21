// Download history, M2.2b (ADR-0004 amendment (c), src/main/downloads): every download's row is
// written as it starts, changes state, is kept and ends (progress at most every 2 s), and the next
// start lists the stored rows again, finished: one that was still running when the app died comes
// back interrupted, and one that waited for Keep still waits if its `.unconfirmed` file is there.
//
// Every test starts the app more than once on one profile (`launcher`, ./session-ui.ts). A test
// build saves into `test-downloads` in the profile and records Open and Show in folder
// (`recordedFileActions`), so nothing is ever opened and the user's Downloads is never touched.
// The files come from the fixture server's `/dl/…` routes: `/dl/file` finishes at once, and
// `/dl/gated` stays in progress until the spec releases it, which is how "killed mid-transfer"
// is tested without racing a clock.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import type { DownloadRow } from '../../src/shared/contracts/data-rpc';
import { fixtureBytes } from '../fixtures/download-routes';
import type { FixtureServer } from '../fixtures/server';
import {
  bytesOf,
  downloadList,
  downloadRow,
  downloadRows,
  downloadsButton,
  expectFiles,
  expectRowButtons,
  openDownloadsPanel,
  rowButton,
  waitForBytes,
  waitForDownload,
} from './downloads-ui';
import type { DownloadEntry } from './downloads-ui';
import { evaluateInTab, recordedFileActions, testDownloadsFolder } from './hooks';
import { expect, test } from './memory-ui';
import { readProfileDb } from './profile-db';
import { dataValue } from './session-ui';
import { loadTab, waitForLoaded } from './shell-ui';
import type { LoadedTab } from './shell-ui';

// Each test starts the app two or three times, and the machine may be busy.
test.describe.configure({ timeout: 180_000 });

const SITE = '127.0.0.1';

function fileUrl(server: FixtureServer, name: string, size: number): string {
  return server.url(`/dl/file?${new URLSearchParams({ name, size: String(size) }).toString()}`);
}

function gatedUrl(server: FixtureServer, name: string, size: number, key: string): string {
  return server.url(
    `/dl/gated?${new URLSearchParams({ name, size: String(size), key }).toString()}`,
  );
}

/** Starts a download the way a page can, from script with no click; the tab stays where it is. */
function startDownload(app: ElectronApplication, tab: LoadedTab, url: string): Promise<unknown> {
  return evaluateInTab(app, tab.webContentsId, `downloadsFixture.goTo(${JSON.stringify(url)})`);
}

async function setUp(app: ElectronApplication, shell: Page, server: FixtureServer) {
  const tab = await loadTab(app, shell, server.url('/downloads.html'));
  return { tab, folder: await testDownloadsFolder(app) };
}

/** The `downloads` rows as the database holds them, newest first. */
async function storedDownloads(app: ElectronApplication): Promise<DownloadRow[]> {
  return (await dataValue<{ downloads: DownloadRow[] }>(app, 'downloads.list', { limit: 1000 }))
    .downloads;
}

/** `[fileName, state]` of every stored row, newest first. */
async function storedStates(app: ElectronApplication): Promise<[string, string][]> {
  return (await storedDownloads(app)).map((row) => [row.fileName, row.state]);
}

/** `[fileName, state]` of every row the panel lists, newest first. */
async function listedStates(shell: Page): Promise<[string, string][]> {
  return (await downloadList(shell)).map((entry) => [entry.fileName, entry.state]);
}

test.describe('the download history', () => {
  test('finished, cancelled and kept downloads are listed again after a restart, and Remove drops the row for good', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const key = randomUUID();
    const first = await launcher.launch();
    const { tab, folder } = await setUp(first.app, first.shell, fixtureServer);

    await startDownload(first.app, tab, fileUrl(fixtureServer, 'keep.txt', 2048));
    await waitForDownload(first.shell, 'keep.txt', 'completed');
    await startDownload(first.app, tab, fileUrl(fixtureServer, 'drop.txt', 1024));
    await waitForDownload(first.shell, 'drop.txt', 'completed');
    // One that is cancelled while it runs.
    await startDownload(first.app, tab, gatedUrl(fixtureServer, 'cancelled.bin', 400_000, key));
    const running = await waitForDownload(first.shell, 'cancelled.bin', 'progressing');
    await waitForBytes(first.shell, running.id, 1);
    await openDownloadsPanel(first.shell);
    await rowButton(downloadRow(first.shell, running.id), 'Cancel').click();
    await waitForDownload(first.shell, 'cancelled.bin', 'cancelled');
    // A dangerous one, still waiting for Keep, and one that was kept.
    await startDownload(first.app, tab, fileUrl(fixtureServer, 'waiting.exe', 700));
    const waiting = await waitForDownload(first.shell, 'waiting.exe', 'completed');
    await startDownload(first.app, tab, fileUrl(fixtureServer, 'kept.exe', 900));
    const kept = await waitForDownload(first.shell, 'kept.exe', 'completed');
    await rowButton(downloadRow(first.shell, kept.id), 'Keep').click();
    await expect(downloadRow(first.shell, kept.id)).toHaveAttribute(
      'data-download-confirmed',
      'true',
    );

    // The rows: one per download, the id main made (a UUIDv7), nothing about the page itself.
    await expect
      .poll(() => storedStates(first.app), { message: 'every download should have its row' })
      .toEqual([
        ['kept.exe', 'completed'],
        ['waiting.exe', 'completed'],
        ['cancelled.bin', 'cancelled'],
        ['drop.txt', 'completed'],
        ['keep.txt', 'completed'],
      ]);
    const rows = await storedDownloads(first.app);
    for (const row of rows) {
      expect(row.id, row.fileName).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(row.site, row.fileName).toBe(SITE);
      expect(row.endedAt, row.fileName).not.toBeNull();
      expect(row.endedAt ?? 0, row.fileName).toBeGreaterThanOrEqual(row.startedAt);
    }
    const byName = Object.fromEntries(rows.map((row) => [row.fileName, row]));
    expect(byName['keep.txt']).toMatchObject({
      path: join(folder, 'keep.txt'),
      url: fileUrl(fixtureServer, 'keep.txt', 2048),
      receivedBytes: 2048,
      totalBytes: 2048,
      dangerous: false,
      confirmed: true,
    });
    expect(byName['waiting.exe']).toMatchObject({
      path: join(folder, 'waiting.exe.unconfirmed'),
      dangerous: true,
      confirmed: false,
    });
    expect(byName['kept.exe']).toMatchObject({
      path: join(folder, 'kept.exe'),
      dangerous: true,
      confirmed: true,
    });
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    // The panel lists what was kept, in the same order, before anything downloads.
    await openDownloadsPanel(shell);
    await expect
      .poll(() => listedStates(shell))
      .toEqual([
        ['kept.exe', 'completed'],
        ['waiting.exe', 'completed'],
        ['cancelled.bin', 'cancelled'],
        ['drop.txt', 'completed'],
        ['keep.txt', 'completed'],
      ]);
    const listed = Object.fromEntries(
      (await downloadList(shell)).map((entry) => [entry.fileName, entry]),
    ) as Record<string, DownloadEntry>;
    // Same ids, so a download is the same download.
    expect(listed['keep.txt']?.id).toBe(byName['keep.txt']?.id);
    expect(listed['keep.txt']).toMatchObject({
      receivedBytes: 2048,
      totalBytes: 2048,
      dangerous: false,
      confirmed: true,
      canResume: false,
    });
    const keepRow = downloadRow(shell, listed['keep.txt']?.id ?? '');
    await expect(keepRow.locator('[data-download-status]')).toHaveText('Done, 2 KB');
    // The row keeps the registrable site only: no port, which is all there is to show.
    await expect(keepRow.locator('[data-download-site]')).toHaveText(SITE);
    await expectRowButtons(keepRow, ['Open', 'Show in folder', 'Remove']);
    await expectRowButtons(downloadRow(shell, listed['cancelled.bin']?.id ?? ''), ['Remove']);

    // A kept file is still openable: Open acts on the stored path (recorded, never performed).
    await rowButton(keepRow, 'Open').click();
    await expect
      .poll(() => recordedFileActions(app))
      .toEqual([{ action: 'open', path: join(folder, 'keep.txt') }]);

    // A file that waited for Keep still waits, and Keep still works on the file it left.
    const waitingRow = downloadRow(shell, waiting.id);
    await expect(waitingRow).toHaveAttribute('data-download-dangerous', 'true');
    await expect(waitingRow).toHaveAttribute('data-download-confirmed', 'false');
    await expectRowButtons(waitingRow, ['Discard', 'Keep']);
    await expect(downloadsButton(shell)).toHaveAttribute('data-downloads-waiting', '1');
    await rowButton(waitingRow, 'Keep').click();
    await expectFiles(
      folder,
      ['cancelled.bin.crdownload', 'drop.txt', 'keep.txt', 'kept.exe', 'waiting.exe'].filter(
        (name) => !name.endsWith('.crdownload'),
      ),
    );
    expect(bytesOf(folder, 'waiting.exe').equals(fixtureBytes(700))).toBe(true);
    await expect
      .poll(async () => (await storedDownloads(app)).find((row) => row.fileName === 'waiting.exe'))
      .toMatchObject({ confirmed: true, path: join(folder, 'waiting.exe') });

    // Remove drops the row, and only the row: the file stays.
    const dropId = listed['drop.txt']?.id ?? '';
    await rowButton(downloadRow(shell, dropId), 'Remove').click();
    await expect(downloadRow(shell, dropId)).toHaveCount(0);
    await expect
      .poll(async () => (await storedDownloads(app)).map((row) => row.fileName).sort())
      .toEqual(['cancelled.bin', 'keep.txt', 'kept.exe', 'waiting.exe']);
    expect((await expectFilesNow(folder)).includes('drop.txt')).toBe(true);
    await launcher.quit({ app, shell });

    // As the file holds it, and as the next start lists it.
    expect(
      readProfileDb(userDataDir, 'SELECT file_name FROM downloads ORDER BY started_at').map(
        (row) => row.file_name,
      ),
    ).toEqual(['keep.txt', 'cancelled.bin', 'waiting.exe', 'kept.exe']);
    const last = await launcher.launch();
    await openDownloadsPanel(last.shell);
    await expect.poll(() => downloadRows(last.shell).count()).toBe(4);
    await expect(last.shell.locator('[data-download-row] [data-download-name]')).toHaveText([
      'kept.exe',
      'waiting.exe',
      'cancelled.bin',
      'keep.txt',
    ]);
  });

  test('a download killed mid-transfer comes back interrupted, running or paused, and can be removed', async ({
    launcher,
    fixtureServer,
  }) => {
    const runningKey = randomUUID();
    const pausedKey = randomUUID();
    const first = await launcher.launch();
    const { tab } = await setUp(first.app, first.shell, fixtureServer);
    try {
      await startDownload(first.app, tab, fileUrl(fixtureServer, 'done.txt', 512));
      await waitForDownload(first.shell, 'done.txt', 'completed');
      await startDownload(
        first.app,
        tab,
        gatedUrl(fixtureServer, 'running.bin', 400_000, runningKey),
      );
      const running = await waitForDownload(first.shell, 'running.bin', 'progressing');
      await waitForBytes(first.shell, running.id, 1);
      await startDownload(
        first.app,
        tab,
        gatedUrl(fixtureServer, 'paused.bin', 400_000, pausedKey),
      );
      const paused = await waitForDownload(first.shell, 'paused.bin', 'progressing');
      await waitForBytes(first.shell, paused.id, 1);
      await openDownloadsPanel(first.shell);
      await rowButton(downloadRow(first.shell, paused.id), 'Pause').click();
      await waitForDownload(first.shell, 'paused.bin', 'paused');

      // What is on disk when the process dies: the rows of the moment they were written.
      await expect
        .poll(() => storedStates(first.app), { message: 'the rows should say what is running' })
        .toEqual([
          ['paused.bin', 'paused'],
          ['running.bin', 'progressing'],
          ['done.txt', 'completed'],
        ]);
      for (const row of await storedDownloads(first.app)) {
        // `ended_at` is null exactly while a download runs (a CHECK of the table).
        expect(row.endedAt === null, row.fileName).toBe(row.state !== 'completed');
      }
      await launcher.kill(first);
    } finally {
      fixtureServer.releaseGate(runningKey);
      fixtureServer.releaseGate(pausedKey);
    }

    const { app, shell } = await launcher.launchAfterKill();
    await openDownloadsPanel(shell);
    await expect
      .poll(() => listedStates(shell))
      .toEqual([
        ['paused.bin', 'interrupted'],
        ['running.bin', 'interrupted'],
        ['done.txt', 'completed'],
      ]);
    const entries = await downloadList(shell);
    for (const entry of entries.filter((candidate) => candidate.state === 'interrupted')) {
      // Nothing is left to resume: the download that ran it died with the last run.
      expect(entry.canResume, entry.fileName).toBe(false);
      await expectRowButtons(downloadRow(shell, entry.id), ['Remove']);
      await expect(downloadRow(shell, entry.id).locator('[data-download-status]')).not.toHaveText(
        /^Done/u,
      );
    }
    // The row is written back as it now is, finished.
    await expect
      .poll(() => storedStates(app))
      .toEqual([
        ['paused.bin', 'interrupted'],
        ['running.bin', 'interrupted'],
        ['done.txt', 'completed'],
      ]);
    for (const row of await storedDownloads(app)) {
      expect(row.endedAt, row.fileName).not.toBeNull();
    }

    // Removing them takes their rows with them.
    for (const entry of entries.filter((candidate) => candidate.state === 'interrupted')) {
      await rowButton(downloadRow(shell, entry.id), 'Remove').click();
      await expect(downloadRow(shell, entry.id)).toHaveCount(0);
    }
    await expect.poll(() => storedStates(app)).toEqual([['done.txt', 'completed']]);
  });

  test('a download is listed in the very run that made it, and a second start sees the same ids', async ({
    launcher,
    fixtureServer,
  }) => {
    const first = await launcher.launch();
    const { tab } = await setUp(first.app, first.shell, fixtureServer);
    await startDownload(first.app, tab, fileUrl(fixtureServer, 'twice.txt', 256));
    const made = await waitForDownload(first.shell, 'twice.txt', 'completed');
    await launcher.quit(first);

    const second = await launcher.launch();
    await expect.poll(() => listedStates(second.shell)).toEqual([['twice.txt', 'completed']]);
    expect((await downloadList(second.shell))[0]?.id).toBe(made.id);
    // Another run, and another download: it goes on top, and the old one stays below it.
    const again = await setUp(second.app, second.shell, fixtureServer);
    await waitForLoaded(second.app, again.tab.tabId);
    await startDownload(second.app, again.tab, fileUrl(fixtureServer, 'newer.txt', 128));
    await waitForDownload(second.shell, 'newer.txt', 'completed');
    await expect
      .poll(() => listedStates(second.shell))
      .toEqual([
        ['newer.txt', 'completed'],
        ['twice.txt', 'completed'],
      ]);
  });
});

async function expectFilesNow(folder: string): Promise<string[]> {
  const { filesIn } = await import('./downloads-ui');
  return filesIn(folder);
}
