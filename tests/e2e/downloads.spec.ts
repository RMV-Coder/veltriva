// Downloads, M1.4b (ADR-0002 item 10; src/core/downloads, src/main/downloads, the panel in
// src/renderer/features/downloads). Electron would show a save dialog for every download; the
// download manager instead always saves, without asking, into the Downloads folder under a name it
// chooses, and the toolbar's button and panel show what is going on.
//
// SAFETY: a test build saves into `test-downloads` in the test's own profile (the
// `testDownloadsFolder` hook), never into the user's Downloads, and Open and Show in folder are
// recorded (`recordedFileActions`) and never performed. Nothing here opens a file.
//
// The files come from the fixture server's `/dl/…` routes (tests/fixtures/download-routes.ts):
// every one has known bytes, and `/dl/gated` stays in progress until the spec releases it, which
// is how pause, resume, cancel and "the tab closed mid-download" are tested without racing a clock.
//
// Downloads are started the ways a user starts them: a click on a link (`clickElement`, a
// `sendInputEvent` mouse click main sees), an Alt+click, and the context menu's items through the
// test hooks. A script that sets `location.href` starts one too, which is how a page does it.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication, Page } from '@playwright/test';

import { ACTIVATION_WINDOW_MS } from '../../src/core/input/user-activation';
import { fixtureBytes, fixtureText } from '../fixtures/download-routes';
import { buildPng } from '../fixtures/images';
import type { FixtureServer } from '../fixtures/server';
import {
  bytesOf,
  downloadList,
  downloadRow,
  downloadRows,
  downloadsButton,
  downloadsPanel,
  expectFiles,
  expectRowButtons,
  filesIn,
  isInside,
  markOfTheWeb,
  openDownloadsPanel,
  rowButton,
  waitForBytes,
  waitForDownload,
} from './downloads-ui';
import type { DownloadEntry } from './downloads-ui';
import { expect } from './expect';
import { test } from './fixtures';
import {
  clickElement,
  elementCenter,
  evaluateInTab,
  holdClickInPage,
  invokeContextMenuItem,
  popupWindows,
  recordedFileActions,
  selectedTabId,
  setSearchTemplate,
  tabState,
  tabStates,
  testDownloadsFolder,
} from './hooks';
import { workspaceSnapshot } from './prompt-ui';
import type { PageGlobal } from './page-globals';
import { closeWithButton, expectConsistent, loadTab, tabElements, waitForLoaded } from './shell-ui';
import type { LoadedTab } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

interface FileOptions {
  readonly name: string;
  readonly size?: number;
  readonly type?: string;
  /** `plain` sends `filename="…"` by hand; the default sends the extended form, which carries any character. */
  readonly style?: 'plain';
}

/** `/dl/file`: an attachment with that name, `size` bytes (1 KB by default) of `fixtureBytes`. */
function fileUrl(server: FixtureServer, options: FileOptions): string {
  const query = new URLSearchParams({ name: options.name });
  if (options.size !== undefined) {
    query.set('size', String(options.size));
  }
  if (options.type !== undefined) {
    query.set('type', options.type);
  }
  if (options.style !== undefined) {
    query.set('style', options.style);
  }
  return server.url(`/dl/file?${query.toString()}`);
}

/** `/dl/gated`: in progress until `server.releaseGate(key)`. 64 KB arrive at once. */
function gatedUrl(
  server: FixtureServer,
  options: { readonly name: string; readonly size: number; readonly key: string },
): string {
  const query = new URLSearchParams({
    name: options.name,
    size: String(options.size),
    key: options.key,
  });
  return server.url(`/dl/gated?${query.toString()}`);
}

/** What a gated download has received before it is released (the route's default first chunk). */
const FIRST_CHUNK = 64 * 1024;

/** Starts a download the way a page can, from script with no click; the tab stays where it is. */
async function startDownload(app: ElectronApplication, tab: LoadedTab, url: string): Promise<void> {
  await evaluateInTab(app, tab.webContentsId, `downloadsFixture.goTo(${JSON.stringify(url)})`);
}

/** A tab on the downloads page and the folder this test's downloads go to. */
async function setUp(
  app: ElectronApplication,
  shell: Page,
  server: FixtureServer,
): Promise<{ readonly tab: LoadedTab; readonly folder: string; readonly pageUrl: string }> {
  const pageUrl = server.url('/downloads.html');
  const tab = await loadTab(app, shell, pageUrl);
  return { tab, folder: await testDownloadsFolder(app), pageUrl };
}

/** The host:port the fixture server's downloads name as their site. */
function siteOf(server: FixtureServer): string {
  return new URL(server.origin).host;
}

/** The shell's own API, which is all a compromised page of the shell could use. */
type DownloadCommand = 'open' | 'showInFolder' | 'clear';

/** Sends a download command straight to main, as the shell would. Returns whether main accepted it. */
function sendCommand(shell: Page, command: DownloadCommand, downloadId: string): Promise<boolean> {
  return shell.evaluate(
    async ({ name, id }) => {
      const result = await (globalThis as PageGlobal).veltriva.downloads[name]({
        downloadId: id,
      });
      return result.ok;
    },
    { name: command, id: downloadId },
  );
}

test.describe('downloads', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test.describe('a link', () => {
    test('downloads into the test profile under its own name, and the row says Done with the size', async ({
      electronApp,
      fixtureServer,
      shell,
      userDataDir,
    }) => {
      const { tab, folder, pageUrl } = await setUp(electronApp, shell, fixtureServer);
      // Never the user's Downloads: the folder is inside this test's own profile.
      expect(isInside(userDataDir, folder), `${folder} should be inside ${userDataDir}`).toBe(true);
      await expect(downloadsButton(shell), 'no download yet, so no button').toHaveCount(0);

      await clickElement(electronApp, tab.webContentsId, '#link-report');

      const done = await waitForDownload(shell, 'report.pdf', 'completed');
      expect(done).toMatchObject({
        fileName: 'report.pdf',
        state: 'completed',
        receivedBytes: 2048,
        totalBytes: 2048,
        dangerous: false,
        confirmed: true,
        canResume: false,
        site: siteOf(fixtureServer),
      });
      await expectFiles(folder, ['report.pdf']);
      expect(bytesOf(folder, 'report.pdf').equals(fixtureBytes(2048))).toBe(true);
      // The link did not take the tab anywhere: the response turned the navigation into a download.
      expect((await tabState(electronApp, tab.tabId))?.url).toBe(pageUrl);

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, done.id);
      await expect(row).toHaveAttribute('data-download-state', 'completed');
      await expect(row.locator('[data-download-name]')).toHaveText('report.pdf');
      await expect(row.locator('[data-download-status]')).toHaveText('Done, 2 KB');
      await expect(row.locator('[data-download-site]')).toHaveText(siteOf(fixtureServer));
      await expect(row.locator('[data-download-warning]')).toHaveCount(0);
      await expectRowButtons(row, ['Open', 'Show in folder', 'Remove']);
    });

    test('carries the Mark-of-the-Web: Zone.Identifier says ZoneId=3', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);

      await clickElement(electronApp, tab.webContentsId, '#link-report');
      await waitForDownload(shell, 'report.pdf', 'completed');

      const zone = markOfTheWeb(join(folder, 'report.pdf'));
      expect(zone, 'the file should have an NTFS Zone.Identifier stream').not.toBeNull();
      expect(zone).toContain('[ZoneTransfer]');
      expect(zone).toContain('ZoneId=3');
      // What the stream says about where the file came from, for the milestone report.
      test.info().annotations.push({ type: 'mark-of-the-web', description: zone ?? '(none)' });
    });

    test('the response, not the click, decides: an attachment downloads and plain text opens in the tab', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const inline = fixtureServer.url('/dl/inline/notes.txt?size=1500');

      // A plain click on the text file is a navigation: the tab shows it and nothing is saved.
      await clickElement(electronApp, tab.webContentsId, '#link-inline');
      await expect
        .poll(async () => (await tabState(electronApp, tab.tabId))?.url, {
          message: 'a plain click on text should open it in the tab',
        })
        .toBe(inline);
      await waitForLoaded(electronApp, tab.tabId);
      expect(await downloadList(shell)).toEqual([]);
      expect(filesIn(folder)).toEqual([]);
      await expect(downloadsButton(shell)).toHaveCount(0);
    });
  });

  test.describe('names', () => {
    test('a second file with the same name is "name (1).ext", then "(2)", and none overwrites another', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);

      const expected: [string, number][] = [
        ['report.pdf', 1000],
        ['report (1).pdf', 2000],
        ['report (2).pdf', 3000],
      ];
      for (const [, size] of expected) {
        await startDownload(electronApp, tab, fileUrl(fixtureServer, { name: 'report.pdf', size }));
        await expect
          .poll(
            async () => (await downloadList(shell)).filter((d) => d.state === 'completed').length,
          )
          .toBe(expected.findIndex(([, wanted]) => wanted === size) + 1);
      }

      await expectFiles(
        folder,
        expected.map(([name]) => name),
      );
      for (const [name, size] of expected) {
        expect(
          bytesOf(folder, name).equals(fixtureBytes(size)),
          `${name} keeps its own bytes`,
        ).toBe(true);
      }
      // Newest first in the list.
      expect((await downloadList(shell)).map((entry) => entry.fileName)).toEqual([
        'report (2).pdf',
        'report (1).pdf',
        'report.pdf',
      ]);
    });

    test('two downloads of one name that are both still running take different names', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const keys = [randomUUID(), randomUUID()] as const;
      const sizes = [200_000, 300_000] as const;

      for (const index of [0, 1] as const) {
        await startDownload(
          electronApp,
          tab,
          gatedUrl(fixtureServer, { name: 'twin.bin', size: sizes[index], key: keys[index] }),
        );
        await waitForDownload(shell, index === 0 ? 'twin.bin' : 'twin (1).bin', 'progressing');
      }

      for (const key of keys) {
        fixtureServer.releaseGate(key);
      }
      await waitForDownload(shell, 'twin.bin', 'completed');
      await waitForDownload(shell, 'twin (1).bin', 'completed');
      await expectFiles(folder, ['twin (1).bin', 'twin.bin']);
      expect(bytesOf(folder, 'twin.bin').equals(fixtureBytes(sizes[0]))).toBe(true);
      expect(bytesOf(folder, 'twin (1).bin').equals(fixtureBytes(sizes[1]))).toBe(true);
    });

    /**
     * Names a hostile server could send. Each must be saved as one safe file inside the folder.
     * `plain` is a server writing `filename="…"` by hand; the others use the extended form
     * (`filename*=UTF-8''…`), which can carry any character at all.
     */
    const HOSTILE_NAMES: readonly {
      readonly label: string;
      readonly name: string;
      readonly style?: 'plain';
    }[] = [
      { label: 'forward slashes and ..', name: '../../outside/evil.txt', style: 'plain' },
      { label: 'forward slashes and .. (extended)', name: '../../outside/evil.txt' },
      { label: 'backslashes and ..', name: '..\\..\\outside\\evil.txt', style: 'plain' },
      { label: 'backslashes and .. (extended)', name: '..\\..\\outside\\evil.txt' },
      { label: 'an absolute path', name: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
      { label: 'a drive-relative path', name: 'D:evil.txt' },
      { label: 'only dots', name: '....' },
      { label: 'a right-to-left override', name: 'photo\u202Egnp.txt' },
      { label: 'a device name', name: 'CON', style: 'plain' },
      { label: 'a device name with an extension', name: 'nul.txt' },
      { label: 'a numbered device name', name: 'com1.log' },
      { label: 'trailing dots and spaces', name: 'trailing. . .', style: 'plain' },
      { label: 'characters Windows forbids', name: 'a<b>c:d"e|f?g*h.txt' },
      { label: 'an alternate data stream', name: 'file.txt:hidden.txt', style: 'plain' },
      { label: 'control characters', name: 'ctrl\u0001\u0007\tname.txt' },
      { label: 'a very long name', name: `${'x'.repeat(400)}.txt` },
    ];

    test('a hostile Content-Disposition name is saved sanitized, as one file inside the folder', async ({
      electronApp,
      fixtureServer,
      shell,
      userDataDir,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const parent = dirname(folder);
      const decoys = ['evil.txt', 'hosts', 'outside', 'D:evil.txt'];

      for (const [index, hostile] of HOSTILE_NAMES.entries()) {
        const before = filesIn(folder);
        const known = new Set((await downloadList(shell)).map((entry) => entry.id));
        await startDownload(
          electronApp,
          tab,
          fileUrl(fixtureServer, {
            name: hostile.name,
            size: 600 + index,
            ...(hostile.style === undefined ? {} : { style: hostile.style }),
          }),
        );

        let saved: DownloadEntry | undefined;
        await expect
          .poll(
            async () => {
              saved = (await downloadList(shell)).find(
                (entry) => !known.has(entry.id) && entry.state === 'completed',
              );
              return saved !== undefined;
            },
            { message: `${hostile.label}: the download should finish`, timeout: 30_000 },
          )
          .toBe(true);
        const name = saved?.fileName ?? '';

        // One new file, named as the list says (plus the suffix a dangerous type carries).
        const onDisk = (saved?.dangerous ?? false) ? `${name}.unconfirmed` : name;
        const added = filesIn(folder).filter((file) => !before.includes(file));
        expect(added, `${hostile.label}: exactly one new file`).toEqual([onDisk]);
        expect(isInside(folder, join(folder, onDisk)), `${hostile.label}: inside the folder`).toBe(
          true,
        );
        expect(dirname(join(folder, onDisk)), hostile.label).toBe(folder);

        // A single, plain file name.
        expect(name, `${hostile.label}: not empty`).not.toBe('');
        expect(name, `${hostile.label}: no path separators or forbidden characters`).not.toMatch(
          /[\\/:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u,
        );
        expect(name, `${hostile.label}: no trailing dot or space`).not.toMatch(/[. ]$/);
        expect(name, `${hostile.label}: not a dotfile or ..`).not.toMatch(/^\./);
        expect(
          name.split('.')[0]?.trim() ?? '',
          `${hostile.label}: not a Windows device name`,
        ).not.toMatch(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i);
        expect(name.length, `${hostile.label}: a bounded length`).toBeLessThanOrEqual(200);
        expect(
          bytesOf(folder, onDisk).equals(fixtureBytes(600 + index)),
          `${hostile.label}: the bytes are the file's`,
        ).toBe(true);
      }

      // Nothing was written next to the folder, or in the folders above it.
      for (const directory of [parent, dirname(parent), userDataDir]) {
        const names = filesIn(directory);
        for (const decoy of decoys) {
          expect(names, `${decoy} must not appear in ${directory}`).not.toContain(decoy);
        }
      }
    });

    test('a right-to-left override cannot make an .exe pass for a document: the name loses it, and the file is held as dangerous', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);

      // Displayed with the override, "invoice\u202Etxt.exe" reads as "invoiceexe.txt": a document.
      await startDownload(
        electronApp,
        tab,
        fileUrl(fixtureServer, { name: 'invoice\u202Etxt.exe', size: 800 }),
      );

      // Chromium replaces the override itself before main sees the name (the manager's own removal
      // of invisible characters is the second line); what matters is the outcome.
      let saved: DownloadEntry | undefined;
      await expect
        .poll(
          async () => {
            saved = (await downloadList(shell)).find(
              (entry) => entry.fileName.startsWith('invoice') && entry.state === 'completed',
            );
            return saved !== undefined;
          },
          { message: 'the invoice should be saved', timeout: 30_000 },
        )
        .toBe(true);
      const name = saved?.fileName ?? '';
      expect(name).toMatch(/\.exe$/);
      expect(name, 'no override, no invisible character').not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect(saved).toMatchObject({ dangerous: true, confirmed: false });
      await expectFiles(folder, [`${name}.unconfirmed`]);

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, saved?.id ?? '');
      await expect(row.locator('[data-download-name]')).toHaveText(name);
      await expect(row.locator('[data-download-warning]')).toBeVisible();
    });
  });

  test.describe('dangerous types', () => {
    test('a .exe is saved as setup.exe.unconfirmed, its row warns, and neither Open nor Remove is offered', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);

      await startDownload(
        electronApp,
        tab,
        fileUrl(fixtureServer, { name: 'setup.exe', size: 4096, type: 'application/x-msdownload' }),
      );

      const saved = await waitForDownload(shell, 'setup.exe', 'completed');
      expect(saved).toMatchObject({ dangerous: true, confirmed: false });
      // On disk it has a name Windows will not run, and not the one the page chose.
      await expectFiles(folder, ['setup.exe.unconfirmed']);
      expect(bytesOf(folder, 'setup.exe.unconfirmed').equals(fixtureBytes(4096))).toBe(true);

      // The button notices a file waiting for a decision.
      await expect(downloadsButton(shell)).toHaveAttribute('data-downloads-waiting', '1');
      await expect(downloadsButton(shell)).toHaveAccessibleName(
        'Downloads, 1 file waiting for your decision',
      );

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, saved.id);
      await expect(row).toHaveAttribute('data-download-dangerous', 'true');
      await expect(row).toHaveAttribute('data-download-confirmed', 'false');
      await expect(row.locator('[data-download-warning]')).toHaveText(
        'This type of file can harm your computer',
      );
      await expectRowButtons(row, ['Discard', 'Keep']);
      await expect(rowButton(row, 'Open')).toHaveCount(0);
      await expect(rowButton(row, 'Remove')).toHaveCount(0);
      await expect(rowButton(row, 'Show in folder')).toHaveCount(0);
    });

    test('main refuses Open and Remove for a dangerous file even when the shell asks', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      await startDownload(electronApp, tab, fileUrl(fixtureServer, { name: 'setup.exe' }));
      const saved = await waitForDownload(shell, 'setup.exe', 'completed');

      // The buttons are not drawn, so a spec sends the commands itself: the shell is a UI, and
      // main enforces the rule.
      expect(await sendCommand(shell, 'open', saved.id)).toBe(true);
      expect(await sendCommand(shell, 'clear', saved.id)).toBe(true);
      expect(await sendCommand(shell, 'showInFolder', saved.id)).toBe(true);
      await delay(500);

      // Nothing was opened or shown: a file that was not kept is neither (found by this spec).
      expect(await recordedFileActions(electronApp)).toEqual([]);
      expect(
        (await downloadList(shell)).map((entry) => entry.id),
        'the row stays',
      ).toEqual([saved.id]);
      await expectFiles(folder, ['setup.exe.unconfirmed']);
    });

    test('Keep renames it to setup.exe, keeps the Mark-of-the-Web, and then Open records an open of that path', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      await startDownload(
        electronApp,
        tab,
        fileUrl(fixtureServer, { name: 'setup.exe', size: 4096 }),
      );
      const saved = await waitForDownload(shell, 'setup.exe', 'completed');
      const zoneBefore = markOfTheWeb(join(folder, 'setup.exe.unconfirmed'));

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, saved.id);
      await rowButton(row, 'Keep').click();

      await expectFiles(folder, ['setup.exe']);
      expect(bytesOf(folder, 'setup.exe').equals(fixtureBytes(4096))).toBe(true);
      await expect(row).toHaveAttribute('data-download-confirmed', 'true');
      await expect(row.locator('[data-download-warning]')).toHaveCount(0);
      await expectRowButtons(row, ['Open', 'Show in folder', 'Remove']);
      await expect(downloadsButton(shell)).toHaveAttribute('data-downloads-waiting', '0');
      // The stream travels with the file when it is renamed.
      expect(zoneBefore, 'the held file has a Mark-of-the-Web').toContain('ZoneId=3');
      expect(markOfTheWeb(join(folder, 'setup.exe'))).toBe(zoneBefore);

      // Nothing was opened by keeping it.
      expect(await recordedFileActions(electronApp)).toEqual([]);
      await rowButton(row, 'Open').click();
      await expect
        .poll(() => recordedFileActions(electronApp))
        .toEqual([{ action: 'open', path: join(folder, 'setup.exe') }]);
    });

    test('Keep gives way to a file that is already there: setup (1).exe', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      await startDownload(
        electronApp,
        tab,
        fileUrl(fixtureServer, { name: 'setup.exe', size: 500 }),
      );
      const first = await waitForDownload(shell, 'setup.exe', 'completed');
      // A second one while the first is held under its .unconfirmed name is already "setup (1).exe".
      await startDownload(
        electronApp,
        tab,
        fileUrl(fixtureServer, { name: 'setup.exe', size: 700 }),
      );
      const second = await waitForDownload(shell, 'setup (1).exe', 'completed');
      await expectFiles(folder, ['setup (1).exe.unconfirmed', 'setup.exe.unconfirmed']);

      await openDownloadsPanel(shell);
      await rowButton(downloadRow(shell, first.id), 'Keep').click();
      await rowButton(downloadRow(shell, second.id), 'Keep').click();

      await expectFiles(folder, ['setup (1).exe', 'setup.exe']);
      expect(bytesOf(folder, 'setup.exe').equals(fixtureBytes(500))).toBe(true);
      expect(bytesOf(folder, 'setup (1).exe').equals(fixtureBytes(700))).toBe(true);
    });

    test('Discard deletes the file and removes the row', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      await startDownload(
        electronApp,
        tab,
        fileUrl(fixtureServer, { name: 'tool.msi', size: 3000 }),
      );
      const saved = await waitForDownload(shell, 'tool.msi', 'completed');
      await expectFiles(folder, ['tool.msi.unconfirmed']);

      await openDownloadsPanel(shell);
      await rowButton(downloadRow(shell, saved.id), 'Discard').click();

      await expectFiles(folder, []);
      await expect(downloadRow(shell, saved.id)).toHaveCount(0);
      expect(await downloadList(shell)).toEqual([]);
      // With nothing left to show, the button and the panel go too.
      await expect(downloadsButton(shell)).toHaveCount(0);
      await expect(downloadsPanel(shell)).toHaveCount(0);
      expect(await recordedFileActions(electronApp)).toEqual([]);
    });

    test('Discard also stops a dangerous download that is still running, and leaves nothing behind', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const key = randomUUID();
      await startDownload(
        electronApp,
        tab,
        gatedUrl(fixtureServer, { name: 'installer.msi', size: 500_000, key }),
      );
      const running = await waitForDownload(shell, 'installer.msi', 'progressing');
      await waitForBytes(shell, running.id, 1);

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, running.id);
      // The warning is there from the start, and Discard is among the choices.
      await expect(row.locator('[data-download-warning]')).toBeVisible();
      await expectRowButtons(row, ['Pause', 'Cancel', 'Discard']);
      await rowButton(row, 'Discard').click();

      await expect(row).toHaveCount(0);
      expect(await downloadList(shell)).toEqual([]);
      await expectFiles(folder, []);
      fixtureServer.releaseGate(key);
      await delay(500);
      await expectFiles(folder, []);
    });

    test('the types on the list are held, and others are not', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const held = [
        'a.exe',
        'b.msi',
        'c.bat',
        'd.cmd',
        'e.ps1',
        'f.vbs',
        'g.js',
        'h.reg',
        'i.jar',
        'j.iso',
        'k.scr',
        'l.hta',
        'UPPER.EXE',
      ];
      const kept = ['m.txt', 'n.pdf', 'o.zip', 'p.exe.txt', 'q.png'];

      for (const [index, name] of [...held, ...kept].entries()) {
        await startDownload(electronApp, tab, fileUrl(fixtureServer, { name, size: 100 + index }));
        await waitForDownload(shell, name, 'completed');
      }

      const list = await downloadList(shell);
      for (const name of held) {
        expect(
          list.find((entry) => entry.fileName === name),
          name,
        ).toMatchObject({
          dangerous: true,
          confirmed: false,
        });
      }
      for (const name of kept) {
        expect(
          list.find((entry) => entry.fileName === name),
          name,
        ).toMatchObject({
          dangerous: false,
          confirmed: true,
        });
      }
      await expectFiles(folder, [...held.map((name) => `${name}.unconfirmed`), ...kept]);
    });
  });

  test.describe('Open and Show in folder', () => {
    test("record an action for a finished file, with main's path, and only when asked", async ({
      electronApp,
      fixtureServer,
      shell,
      userDataDir,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      await clickElement(electronApp, tab.webContentsId, '#link-report');
      const saved = await waitForDownload(shell, 'report.pdf', 'completed');

      // Finishing a download opens nothing.
      await delay(500);
      expect(await recordedFileActions(electronApp)).toEqual([]);

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, saved.id);
      await rowButton(row, 'Open').click();
      await rowButton(row, 'Show in folder').click();

      const path = join(folder, 'report.pdf');
      await expect
        .poll(() => recordedFileActions(electronApp))
        .toEqual([
          { action: 'open', path },
          { action: 'show', path },
        ]);

      // The shell never learned where the file is: ids only.
      const everything = JSON.stringify(await workspaceSnapshot(shell));
      expect(everything).not.toContain(folder);
      expect(everything).not.toContain(userDataDir);
      expect(everything).not.toContain('test-downloads');
    });

    test('are neither offered nor honored while a download runs or after it was cancelled', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const key = randomUUID();
      await startDownload(
        electronApp,
        tab,
        gatedUrl(fixtureServer, { name: 'big.bin', size: 400_000, key }),
      );
      const running = await waitForDownload(shell, 'big.bin', 'progressing');
      await waitForBytes(shell, running.id, 1);

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, running.id);
      await expectRowButtons(row, ['Pause', 'Cancel']);
      expect(await sendCommand(shell, 'open', running.id)).toBe(true);
      expect(await sendCommand(shell, 'showInFolder', running.id)).toBe(true);

      await rowButton(row, 'Cancel').click();
      await waitForDownload(shell, 'big.bin', 'cancelled');
      await expectRowButtons(row, ['Remove']);
      expect(await sendCommand(shell, 'open', running.id)).toBe(true);
      expect(await sendCommand(shell, 'showInFolder', running.id)).toBe(true);

      await delay(500);
      expect(await recordedFileActions(electronApp)).toEqual([]);
      await expectFiles(folder, []);
    });

    test("take main's ids only: a path in place of an id is rejected", async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      await setUp(electronApp, shell, fixtureServer);
      for (const command of ['open', 'showInFolder'] as const) {
        for (const id of ['C:\\Windows\\System32\\notepad.exe', '..\\..\\x', 'download-0x1', '']) {
          expect(await sendCommand(shell, command, id), `${command} ${id}`).toBe(false);
        }
        // A well-formed id main has no record of is "not found", not an open.
        expect(await sendCommand(shell, command, 'download-999'), `${command} download-999`).toBe(
          false,
        );
      }
      expect(await recordedFileActions(electronApp)).toEqual([]);
    });
  });

  test.describe('pause, resume and cancel', () => {
    const SIZE = 1_048_576;

    test('Pause holds a running download, and Resume lets it finish with every byte', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const key = randomUUID();
      await startDownload(
        electronApp,
        tab,
        gatedUrl(fixtureServer, { name: 'slow.bin', size: SIZE, key }),
      );
      const running = await waitForDownload(shell, 'slow.bin', 'progressing');
      const started = await waitForBytes(shell, running.id, FIRST_CHUNK);
      expect(started.totalBytes).toBe(SIZE);

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, running.id);
      await expect(row.locator('[data-download-progress]')).toBeVisible();
      await expectRowButtons(row, ['Pause', 'Cancel']);

      await rowButton(row, 'Pause').click();
      await expect(row).toHaveAttribute('data-download-state', 'paused');
      await expect(row.locator('[data-download-status]')).toContainText('Paused');
      await expectRowButtons(row, ['Resume', 'Cancel']);

      // The server now has the rest ready; a paused download does not take it.
      fixtureServer.releaseGate(key);
      await delay(1_500);
      const held = (await downloadList(shell)).find((entry) => entry.id === running.id);
      expect(held?.state).toBe('paused');
      expect(
        held?.receivedBytes ?? SIZE,
        'a paused download stays short of the whole file',
      ).toBeLessThan(SIZE);

      await rowButton(row, 'Resume').click();
      const done = await waitForDownload(shell, 'slow.bin', 'completed');
      expect(done).toMatchObject({ receivedBytes: SIZE, totalBytes: SIZE });
      await expect(row.locator('[data-download-status]')).toHaveText('Done, 1 MB');
      await expectFiles(folder, ['slow.bin']);
      expect(bytesOf(folder, 'slow.bin').equals(fixtureBytes(SIZE))).toBe(true);
    });

    test('Cancel stops it and leaves no file, and Remove clears the row', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const key = randomUUID();
      await startDownload(
        electronApp,
        tab,
        gatedUrl(fixtureServer, { name: 'slow.bin', size: SIZE, key }),
      );
      const running = await waitForDownload(shell, 'slow.bin', 'progressing');
      await waitForBytes(shell, running.id, FIRST_CHUNK);

      await openDownloadsPanel(shell);
      const row = downloadRow(shell, running.id);
      await rowButton(row, 'Cancel').click();

      await expect(row).toHaveAttribute('data-download-state', 'cancelled');
      await expect(row.locator('[data-download-status]')).toHaveText('Cancelled');
      await expectRowButtons(row, ['Remove']);
      // Not even a partial file stays (Chromium deletes its .crdownload).
      await expectFiles(folder, []);
      fixtureServer.releaseGate(key);
      await delay(500);
      await expectFiles(folder, []);

      await rowButton(row, 'Remove').click();
      await expect(row).toHaveCount(0);
      expect(await downloadList(shell)).toEqual([]);
      await expect(downloadsButton(shell)).toHaveCount(0);
    });

    test('Remove clears a finished row and keeps the file', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      await clickElement(electronApp, tab.webContentsId, '#link-report');
      const saved = await waitForDownload(shell, 'report.pdf', 'completed');

      await openDownloadsPanel(shell);
      await rowButton(downloadRow(shell, saved.id), 'Remove').click();

      await expect(downloadRows(shell)).toHaveCount(0);
      expect(await downloadList(shell)).toEqual([]);
      await expectFiles(folder, ['report.pdf']);
    });
  });

  test('a download outlives its tab: closing the tab mid-download lets it finish', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
    // A second tab, so closing the first leaves the window as it was.
    const other = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=outlive'));
    const key = randomUUID();
    const size = 500_000;
    // The first tab starts the download, then is no longer the selected one.
    await startDownload(
      electronApp,
      tab,
      gatedUrl(fixtureServer, { name: 'outlive.bin', size, key }),
    );
    const running = await waitForDownload(shell, 'outlive.bin', 'progressing');
    await waitForBytes(shell, running.id, 1);

    const tabsBefore = (await tabStates(electronApp)).map((state) => state.id);
    await closeWithButton(shell, tab.tabId);
    await expect
      .poll(async () => (await tabStates(electronApp)).map((state) => state.id))
      .toEqual(tabsBefore.filter((id) => id !== tab.tabId));
    expect(await selectedTabId(electronApp)).toBe(other.tabId);

    // Still in progress, and still listed: the tab was never what the download belonged to.
    expect((await downloadList(shell)).find((entry) => entry.id === running.id)?.state).toBe(
      'progressing',
    );
    fixtureServer.releaseGate(key);
    const done = await waitForDownload(shell, 'outlive.bin', 'completed');
    expect(done).toMatchObject({ receivedBytes: size, site: siteOf(fixtureServer) });
    await expectFiles(folder, ['outlive.bin']);
    expect(bytesOf(folder, 'outlive.bin').equals(fixtureBytes(size))).toBe(true);
  });

  test.describe('other ways to start one', () => {
    test('"Save link to Downloads" saves the link under its own name', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder, pageUrl } = await setUp(electronApp, shell, fixtureServer);
      // Text a plain click would open in the tab.
      const linkURL = fixtureServer.url('/dl/inline/notes.txt?size=1500');

      await invokeContextMenuItem(electronApp, tab.tabId, { linkURL }, 'save-link');

      const saved = await waitForDownload(shell, 'notes.txt', 'completed');
      expect(saved).toMatchObject({ receivedBytes: 1500, dangerous: false });
      await expectFiles(folder, ['notes.txt']);
      expect(bytesOf(folder, 'notes.txt').equals(fixtureText(1500))).toBe(true);
      expect((await tabState(electronApp, tab.tabId))?.url).toBe(pageUrl);
    });

    test('"Save image to Downloads" saves the image, and a data: image too', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
      const png = buildPng();

      await invokeContextMenuItem(
        electronApp,
        tab.tabId,
        { mediaType: 'image', srcURL: fixtureServer.url('/favicon.png'), hasImageContents: true },
        'save-image',
      );
      const saved = await waitForDownload(shell, 'favicon.png', 'completed');
      expect(saved.receivedBytes).toBe(png.length);
      expect(bytesOf(folder, 'favicon.png').equals(png)).toBe(true);

      // An inline image has no URL a tab may open, but it can still be saved.
      const before = new Set((await downloadList(shell)).map((entry) => entry.id));
      await invokeContextMenuItem(
        electronApp,
        tab.tabId,
        {
          mediaType: 'image',
          srcURL: `data:image/png;base64,${png.toString('base64')}`,
          hasImageContents: true,
        },
        'save-image',
      );
      let inline: DownloadEntry | undefined;
      await expect
        .poll(
          async () => {
            inline = (await downloadList(shell)).find(
              (entry) => !before.has(entry.id) && entry.state === 'completed',
            );
            return inline !== undefined;
          },
          { message: 'the data: image should be saved' },
        )
        .toBe(true);
      expect(inline?.receivedBytes).toBe(png.length);
      expect(inline?.fileName).toMatch(/\.png$/);
      expect(bytesOf(folder, inline?.fileName ?? '').equals(png)).toBe(true);
    });

    test('the save items refuse URLs a page must not make the browser fetch', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder } = await setUp(electronApp, shell, fixtureServer);

      // The menu's params come from the page, so main checks them again before it downloads.
      for (const url of [
        'file:///C:/Windows/win.ini',
        'javascript:alert(1)',
        'veltriva://settings',
        'app://shell/index.html',
        'data:text/html,<script>alert(1)</script>',
        'ftp://files.example.invalid/x',
      ]) {
        await invokeContextMenuItem(electronApp, tab.tabId, { linkURL: url }, 'save-link');
        await invokeContextMenuItem(
          electronApp,
          tab.tabId,
          { mediaType: 'image', srcURL: url },
          'save-image',
        );
      }

      await delay(1_000);
      expect(await downloadList(shell)).toEqual([]);
      expect(filesIn(folder)).toEqual([]);
      await expect(downloadsButton(shell)).toHaveCount(0);
    });

    test('Alt+click on a link downloads it, without taking the tab away', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab, folder, pageUrl } = await setUp(electronApp, shell, fixtureServer);
      const tabsBefore = (await tabStates(electronApp)).map((state) => state.id);

      await clickElement(electronApp, tab.webContentsId, '#link-inline', { modifiers: ['alt'] });

      const saved = await waitForDownload(shell, 'notes.txt', 'completed');
      expect(saved.receivedBytes).toBe(1500);
      await expectFiles(folder, ['notes.txt']);
      expect(bytesOf(folder, 'notes.txt').equals(fixtureText(1500))).toBe(true);
      expect((await tabState(electronApp, tab.tabId))?.url).toBe(pageUrl);
      expect(
        (await tabStates(electronApp)).map((state) => state.id),
        'no tab was opened',
      ).toEqual(tabsBefore);
      expect(await popupWindows(electronApp), 'no window was opened').toEqual([]);
    });

    test('an Alt+click download is Blink’s own, from real input only: held long, it still downloads', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      // Measured on Electron 44.7.2: Blink starts an Alt+click download itself and it reaches
      // `will-download` directly, not the window-open handler, so main's 5 s gesture window plays
      // no part. That is safe: a page can't fake an Alt+click (Blink ignores Alt on a synthetic
      // click and just follows the link), so only a real click downloads. ADR-0002 item 10.
      const { tab, folder, pageUrl } = await setUp(electronApp, shell, fixtureServer);
      const { x, y } = await elementCenter(electronApp, tab.webContentsId, '#link-inline');
      await holdClickInPage(electronApp, tab.webContentsId, x, y, {
        modifiers: ['alt'],
        holdMs: ACTIVATION_WINDOW_MS + 700,
      });
      await waitForDownload(shell, 'notes.txt', 'completed');
      await expectFiles(folder, ['notes.txt']);
      // A download, never a navigation.
      expect((await tabState(electronApp, tab.tabId))?.url).toBe(pageUrl);
    });

    test('a download started from a popup window lands in the same list', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const folder = await testDownloadsFolder(electronApp);
      const opener = await loadTab(electronApp, shell, fixtureServer.url('/popup-opener.html'));
      await clickElement(electronApp, opener.webContentsId, '#open-popup');
      let popupId = -1;
      await expect
        .poll(
          async () => {
            const popups = await popupWindows(electronApp);
            popupId =
              popups.find((popup) => popup.url.includes('/popup-child.html'))?.webContentsId ?? -1;
            return popupId;
          },
          { message: 'the popup window should open on the child page', timeout: 30_000 },
        )
        .toBeGreaterThan(-1);

      await evaluateInTab(
        electronApp,
        popupId,
        `window.location.href = ${JSON.stringify(
          fileUrl(fixtureServer, { name: 'from-popup.bin', size: 900 }),
        )}`,
      );

      const saved = await waitForDownload(shell, 'from-popup.bin', 'completed');
      expect(saved).toMatchObject({ receivedBytes: 900, site: siteOf(fixtureServer) });
      await expectFiles(folder, ['from-popup.bin']);
      // The popup is still the popup: the download did not navigate it.
      expect((await popupWindows(electronApp)).length).toBe(1);
      await openDownloadsPanel(shell);
      await expect(downloadRows(shell)).toHaveCount(1);
    });
  });

  test.describe('the button and the panel', () => {
    test('the button appears with the first download; the panel opens, lists newest first, and closes', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab } = await setUp(electronApp, shell, fixtureServer);
      await expect(downloadsButton(shell)).toHaveCount(0);
      await expect(downloadsPanel(shell)).toHaveCount(0);

      await startDownload(
        electronApp,
        tab,
        fileUrl(fixtureServer, { name: 'first.bin', size: 300 }),
      );
      await waitForDownload(shell, 'first.bin', 'completed');
      const button = downloadsButton(shell);
      await expect(button).toBeVisible();
      await expect(button).toHaveAccessibleName('Downloads');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(downloadsPanel(shell), 'closed until the user opens it').toHaveCount(0);

      await startDownload(
        electronApp,
        tab,
        fileUrl(fixtureServer, { name: 'second.bin', size: 400 }),
      );
      await waitForDownload(shell, 'second.bin', 'completed');

      await button.click();
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(button).toHaveAttribute('aria-controls', 'downloads-panel');
      const panel = downloadsPanel(shell);
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAccessibleName('Downloads');
      await expect(panel.locator('[data-download-name]')).toHaveText(['second.bin', 'first.bin']);
      // The panel is chrome: the page is placed below it, not under it.
      await expectConsistent(electronApp, shell, 'the page should sit below the open panel');

      await button.click();
      await expect(panel).toHaveCount(0);
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expectConsistent(electronApp, shell, 'the page should take the room back');
    });

    test('"Close downloads" closes the panel, and Escape does too and gives the focus back to the button', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab } = await setUp(electronApp, shell, fixtureServer);
      await startDownload(electronApp, tab, fileUrl(fixtureServer, { name: 'one.bin', size: 300 }));
      const saved = await waitForDownload(shell, 'one.bin', 'completed');

      const panel = await openDownloadsPanel(shell);
      await panel.getByRole('button', { name: 'Close downloads', exact: true }).click();
      await expect(panel).toHaveCount(0);

      await openDownloadsPanel(shell);
      // Escape works from inside the panel.
      await downloadRow(shell, saved.id).focus();
      await shell.keyboard.press('Escape');
      await expect(downloadsPanel(shell)).toHaveCount(0);
      await expect(downloadsButton(shell)).toBeFocused();
      await expect(downloadsButton(shell)).toHaveAttribute('aria-expanded', 'false');
    });

    test('the button shows a running download, and goes when the last row is removed', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { tab } = await setUp(electronApp, shell, fixtureServer);
      const key = randomUUID();
      await startDownload(
        electronApp,
        tab,
        gatedUrl(fixtureServer, { name: 'running.bin', size: 400_000, key }),
      );
      const running = await waitForDownload(shell, 'running.bin', 'progressing');
      await waitForBytes(shell, running.id, 1);

      const button = downloadsButton(shell);
      await expect(button).toHaveAttribute('data-downloads-active', '1');
      await expect(button).toHaveAccessibleName('Downloads, 1 in progress');

      fixtureServer.releaseGate(key);
      await waitForDownload(shell, 'running.bin', 'completed');
      await expect(button).toHaveAttribute('data-downloads-active', '0');
      await expect(button).toHaveAccessibleName('Downloads');

      await openDownloadsPanel(shell);
      await rowButton(downloadRow(shell, running.id), 'Remove').click();
      await expect(button).toHaveCount(0);
      await expect(downloadsPanel(shell)).toHaveCount(0);
    });
  });

  test('a name is free again once its file is gone', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // The manager asks the disk as well as its own list, so a deleted file's name can be used again.
    const { tab, folder } = await setUp(electronApp, shell, fixtureServer);
    await startDownload(electronApp, tab, fileUrl(fixtureServer, { name: 'again.bin', size: 300 }));
    await waitForDownload(shell, 'again.bin', 'completed');
    rmSync(join(folder, 'again.bin'));

    await startDownload(electronApp, tab, fileUrl(fixtureServer, { name: 'again.bin', size: 301 }));
    await expect
      .poll(
        async () =>
          (await downloadList(shell)).filter((entry) => entry.state === 'completed').length,
      )
      .toBe(2);

    expect((await downloadList(shell)).map((entry) => entry.fileName)).toEqual([
      'again.bin',
      'again.bin',
    ]);
    await expectFiles(folder, ['again.bin']);
    expect(bytesOf(folder, 'again.bin').equals(fixtureBytes(301))).toBe(true);
  });
});
