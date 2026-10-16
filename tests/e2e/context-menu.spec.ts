// Context menus, M1.3b (ADR-0002 item 8): the native menu of a page (links, images, selected text,
// editable fields, misspelled words, a plain spot) and the menu of a tab in the sidebar.
//
// Playwright cannot click a native menu, so the specs ask the test hooks what a right-click with
// given params would show (`contextMenuItems`, `tabMenuItems`) and run an item as if it had been
// picked (`invokeContextMenuItem`, `invokeTabMenuItem`). The params are the ones Chromium hands
// main; the point of most specs is what main does with page-controlled ones: a `javascript:` link
// gets no "Open link in new tab", selected text cannot reorder or hide a label, and the clipboard
// changes only when an item that copies is run.
//
// Specs that touch the system clipboard save its text first and put it back afterwards, even when
// the test fails (see clipboard.spec.ts).
import type { ElectronApplication } from '@playwright/test';

import { expect } from './expect';
import { test } from './fixtures';
import {
  contextMenuItems,
  focusedWebContents,
  invokeContextMenuItem,
  invokeTabMenuItem,
  isDevToolsOpened,
  pageForTab,
  selectedTabId,
  setSearchTemplate,
  shellContentsId,
  tabMenuItems,
  tabState,
  tabStates,
  webContentsRoles,
} from './hooks';
import type { MenuEntry, TabMenuEntry } from './hooks';
import { observeFor } from './launch';
import type { PageGlobal } from './page-globals';
import {
  closeWithButton,
  loadTab,
  mainIds,
  sidebarTabs,
  tabElement,
  tabElements,
  typeAddress,
  waitForPage,
} from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** One line per entry, so a whole menu compares in one readable `toEqual`. */
function lines(entries: readonly (MenuEntry | TabMenuEntry)[]): string[] {
  return entries.map((entry) =>
    entry.type === 'separator'
      ? '---'
      : `${entry.id}: ${entry.label}${entry.enabled ? '' : ' (disabled)'}`,
  );
}

const NO_EDIT_FLAGS = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false,
} as const;

async function readClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

async function writeClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(async ({ clipboard }, value) => {
    if (value === '') {
      clipboard.clear();
    } else {
      await clipboard.writeText(value);
    }
  }, text);
}

/** Runs `body` with the clipboard saved, and puts its text back afterwards whatever happened. */
async function withSavedClipboard(
  app: ElectronApplication,
  body: () => Promise<void>,
): Promise<void> {
  const saved = await readClipboard(app);
  try {
    await body();
  } finally {
    try {
      await writeClipboard(app, saved);
    } catch (error) {
      console.warn('Could not restore the clipboard text:', error);
    }
  }
}

type FieldGlobal = typeof globalThis & {
  getSelection(): { toString(): string; selectAllChildren(node: unknown): void };
  document: PageGlobal['document'] & { getElementById(id: string): unknown };
};

interface FieldElement {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  focus(): void;
  select(): void;
}

test.describe('page context menu', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test.describe('entries', () => {
    test('a plain spot offers Back, Forward, Reload and Inspect, with history deciding the first two', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=menu'));

      expect(lines(await contextMenuItems(electronApp, tab.tabId))).toEqual([
        'back: Back (disabled)',
        'forward: Forward (disabled)',
        'reload: Reload',
        '---',
        'inspect: Inspect',
      ]);

      // Navigate on: Back is enabled, Forward is not.
      await typeAddress(shell, fixtureServer.url('/page-b.html?case=menu'));
      await waitForPage(electronApp, tab.tabId, { title: 'Page B' });
      expect(lines(await contextMenuItems(electronApp, tab.tabId))).toEqual([
        'back: Back',
        'forward: Forward (disabled)',
        'reload: Reload',
        '---',
        'inspect: Inspect',
      ]);

      // And after going back, the other way round.
      await invokeContextMenuItem(electronApp, tab.tabId, {}, 'back');
      await waitForPage(electronApp, tab.tabId, { title: 'Page A' });
      expect(lines(await contextMenuItems(electronApp, tab.tabId))).toEqual([
        'back: Back (disabled)',
        'forward: Forward',
        'reload: Reload',
        '---',
        'inspect: Inspect',
      ]);
    });

    test('a link offers "Open link in new tab" only for a URL a tab may open', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=links'));
      const origin = fixtureServer.origin;

      const openable = [
        'http://127.0.0.1:1/somewhere',
        'https://example.invalid/path?q=1#hash',
        // A blob: URL made by a page of a web origin names that origin.
        `blob:${origin}/6e0c6b2a-8f1f-4a3e-9b52-2a1c1f5b7d11`,
      ];
      for (const linkURL of openable) {
        expect(lines(await contextMenuItems(electronApp, tab.tabId, { linkURL })), linkURL).toEqual(
          [
            'open-link-in-new-tab: Open link in new tab',
            'copy-link: Copy link address',
            '---',
            'inspect: Inspect',
          ],
        );
      }

      // Everything else can be copied but not opened: a click would run a script, show a page
      // under no site's name, or reach into the file system or the browser itself.
      const refused = [
        'javascript:alert(document.domain)',
        'JaVaScRiPt:void(0)',
        'data:text/html,<script>alert(1)</script>',
        'file:///C:/Windows/win.ini',
        'veltriva://settings',
        'app://shell/index.html',
        'blob:null/6e0c6b2a-8f1f-4a3e-9b52-2a1c1f5b7d11',
        'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
        'ftp://files.example.invalid/x',
        'mailto:someone@example.invalid',
        'not a url at all',
      ];
      for (const linkURL of refused) {
        expect(lines(await contextMenuItems(electronApp, tab.tabId, { linkURL })), linkURL).toEqual(
          ['copy-link: Copy link address', '---', 'inspect: Inspect'],
        );
      }
    });

    test('an image offers Open, Copy image and Copy image address as its URL and contents allow', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=images'));
      const srcURL = fixtureServer.url('/favicon.png');
      const image = { mediaType: 'image', srcURL };

      expect(
        lines(await contextMenuItems(electronApp, tab.tabId, { ...image, hasImageContents: true })),
      ).toEqual([
        'open-image-in-new-tab: Open image in new tab',
        'copy-image: Copy image',
        'copy-image-address: Copy image address',
        '---',
        'inspect: Inspect',
      ]);

      // An image that hasn't loaded has no contents to copy.
      expect(
        lines(
          await contextMenuItems(electronApp, tab.tabId, { ...image, hasImageContents: false }),
        ),
      ).toEqual([
        'open-image-in-new-tab: Open image in new tab',
        'copy-image-address: Copy image address',
        '---',
        'inspect: Inspect',
      ]);

      // A data: image can be copied, but a tab may not be sent to it.
      expect(
        lines(
          await contextMenuItems(electronApp, tab.tabId, {
            mediaType: 'image',
            srcURL: 'data:image/png;base64,iVBORw0KGgo=',
            hasImageContents: true,
          }),
        ),
      ).toEqual([
        'copy-image: Copy image',
        'copy-image-address: Copy image address',
        '---',
        'inspect: Inspect',
      ]);

      // Video and audio are not images.
      expect(
        lines(await contextMenuItems(electronApp, tab.tabId, { mediaType: 'video', srcURL })),
      ).toEqual([
        'back: Back (disabled)',
        'forward: Forward (disabled)',
        'reload: Reload',
        '---',
        'inspect: Inspect',
      ]);

      // An image inside a link has both groups, the link's first.
      expect(
        lines(
          await contextMenuItems(electronApp, tab.tabId, {
            ...image,
            hasImageContents: true,
            linkURL: fixtureServer.url('/page-b.html'),
          }),
        ),
      ).toEqual([
        'open-link-in-new-tab: Open link in new tab',
        'copy-link: Copy link address',
        '---',
        'open-image-in-new-tab: Open image in new tab',
        'copy-image: Copy image',
        'copy-image-address: Copy image address',
        '---',
        'inspect: Inspect',
      ]);
    });

    test('selected text offers Copy and a search for it, quoted safely in the label', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-a.html?case=selection'),
      );
      // The engine is named by the search template's host, which tests point at the local server.
      const engine = new URL(fixtureServer.origin).host;
      const labelFor = async (selectionText: string): Promise<string | undefined> => {
        const entries = await contextMenuItems(electronApp, tab.tabId, { selectionText });
        const search = entries.find(
          (entry) => entry.type === 'item' && entry.id === 'search-selection',
        );
        return search?.type === 'item' ? search.label : undefined;
      };

      expect(
        lines(await contextMenuItems(electronApp, tab.tabId, { selectionText: 'hello world' })),
      ).toEqual([
        'copy: Copy',
        `search-selection: Search ${engine} for “hello world”`,
        '---',
        'inspect: Inspect',
      ]);

      // Whitespace around the selection is dropped, and whitespace inside it collapses.
      expect(await labelFor('  two\n\n   words\t here ')).toBe(
        `Search ${engine} for “two words here”`,
      );
      // A long selection is cut at 32 characters, the last being an ellipsis.
      expect(await labelFor('x'.repeat(100))).toBe(`Search ${engine} for “${'x'.repeat(31)}…”`);
      // Control characters and bidi formatting cannot reorder or hide the label's text.
      const hostile = 'safe\u202e evil\u2066 text\u200b\u0007end';
      const label = await labelFor(hostile);
      expect(label).toBe(`Search ${engine} for “safe evil text end”`);
      // No control (Cc) or format (Cf) character is left: that is where bidi overrides live.
      expect(label).not.toMatch(/[\p{Cc}\p{Cf}]/u);

      // Nothing but whitespace is not a selection: the plain menu.
      expect(
        lines(await contextMenuItems(electronApp, tab.tabId, { selectionText: ' \n\t ' })),
      ).toEqual([
        'back: Back (disabled)',
        'forward: Forward (disabled)',
        'reload: Reload',
        '---',
        'inspect: Inspect',
      ]);
    });

    test('an editable field offers Undo to Select all as its edit flags allow', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-a.html?case=editable'),
      );

      expect(
        lines(
          await contextMenuItems(electronApp, tab.tabId, {
            isEditable: true,
            editFlags: { ...NO_EDIT_FLAGS },
          }),
        ),
      ).toEqual([
        'undo: Undo (disabled)',
        'redo: Redo (disabled)',
        '---',
        'cut: Cut (disabled)',
        'copy: Copy (disabled)',
        'paste: Paste (disabled)',
        'paste-plain: Paste as plain text (disabled)',
        'select-all: Select all (disabled)',
        '---',
        'inspect: Inspect',
      ]);

      expect(
        lines(
          await contextMenuItems(electronApp, tab.tabId, {
            isEditable: true,
            // Selected text in a field gets the edit group, not the search item.
            selectionText: 'abc',
            editFlags: {
              ...NO_EDIT_FLAGS,
              canUndo: true,
              canCut: true,
              canCopy: true,
              canPaste: true,
              canSelectAll: true,
            },
          }),
        ),
      ).toEqual([
        'undo: Undo',
        'redo: Redo (disabled)',
        '---',
        'cut: Cut',
        'copy: Copy',
        'paste: Paste',
        'paste-plain: Paste as plain text',
        'select-all: Select all',
        '---',
        'inspect: Inspect',
      ]);
    });

    test('a misspelled word in a field offers up to five suggestions and "Add to dictionary"', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-a.html?case=spelling'),
      );
      const editing = [
        'undo: Undo (disabled)',
        'redo: Redo (disabled)',
        '---',
        'cut: Cut (disabled)',
        'copy: Copy (disabled)',
        'paste: Paste (disabled)',
        'paste-plain: Paste as plain text (disabled)',
        'select-all: Select all (disabled)',
        '---',
        'inspect: Inspect',
      ];
      const field = { isEditable: true, editFlags: { ...NO_EDIT_FLAGS } };

      expect(
        lines(
          await contextMenuItems(electronApp, tab.tabId, {
            ...field,
            misspelledWord: 'teh',
            dictionarySuggestions: ['the', 'ten', 'tea', 'tech', 'tee', 'tex', 'tez'],
          }),
        ),
      ).toEqual([
        'suggestion-0: the',
        'suggestion-1: ten',
        'suggestion-2: tea',
        'suggestion-3: tech',
        'suggestion-4: tee',
        'add-to-dictionary: Add to dictionary',
        '---',
        ...editing,
      ]);

      expect(
        lines(await contextMenuItems(electronApp, tab.tabId, { ...field, misspelledWord: 'qzxv' })),
      ).toEqual([
        'suggestion-0: No spelling suggestions (disabled)',
        'add-to-dictionary: Add to dictionary',
        '---',
        ...editing,
      ]);

      // A suggestion is page-influenced text too: it is made safe like a selection.
      expect(
        lines(
          await contextMenuItems(electronApp, tab.tabId, {
            ...field,
            misspelledWord: 'teh',
            dictionarySuggestions: ['th\u202ee\u0007'],
          }),
        ).slice(0, 1),
      ).toEqual(['suggestion-0: th e']);

      // Spelling is only for fields: a page cannot show it for ordinary text.
      expect(
        lines(
          await contextMenuItems(electronApp, tab.tabId, {
            misspelledWord: 'teh',
            dictionarySuggestions: ['the'],
          }),
        ),
      ).toEqual([
        'back: Back (disabled)',
        'forward: Forward (disabled)',
        'reload: Reload',
        '---',
        'inspect: Inspect',
      ]);
    });
  });

  test.describe('running an item', () => {
    test('"Open link in new tab" opens a background tab right after the page', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const [first] = await mainIds(electronApp);
      const tabA = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-a.html?case=open-link'),
      );
      const tabC = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-c.html?case=open-link'),
      );
      // Back to A: the new tab must land between A and C, and A stay selected, with the keyboard.
      await tabElement(shell, tabA.tabId).click();
      await expect.poll(() => selectedTabId(electronApp)).toBe(tabA.tabId);
      await expect
        .poll(async () => (await focusedWebContents(electronApp))?.webContentsId)
        .toBe(tabA.webContentsId);
      const target = fixtureServer.url('/page-b.html?case=open-link');

      await invokeContextMenuItem(
        electronApp,
        tabA.tabId,
        { linkURL: target },
        'open-link-in-new-tab',
      );

      await expect.poll(async () => (await mainIds(electronApp)).length).toBe(4);
      const ids = await mainIds(electronApp);
      expect(ids[0]).toBe(first);
      expect(ids[1]).toBe(tabA.tabId);
      expect(ids[3]).toBe(tabC.tabId);
      const opened = ids[2] ?? '';
      await waitForPage(electronApp, opened, { url: target, title: 'Page B' });
      // In the background: the selection and the keyboard stay with the page the user was on.
      expect(await selectedTabId(electronApp)).toBe(tabA.tabId);
      expect((await tabState(electronApp, opened))?.attached).toBe(false);
      expect((await focusedWebContents(electronApp))?.webContentsId).toBe(tabA.webContentsId);
    });

    test('a URL a tab may not open does nothing, however the item is run', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=refused'));
      const before = JSON.stringify((await tabStates(electronApp)).map((t) => [t.id, t.url]));

      const refused = [
        'javascript:document.title="pwned"',
        'data:text/html,<title>pwned</title>',
        'file:///C:/Windows/win.ini',
        'veltriva://settings',
        'app://shell/index.html',
        'blob:null/6e0c6b2a-8f1f-4a3e-9b52-2a1c1f5b7d11',
        '',
      ];
      for (const url of refused) {
        await invokeContextMenuItem(
          electronApp,
          tab.tabId,
          { linkURL: url },
          'open-link-in-new-tab',
        );
        await invokeContextMenuItem(
          electronApp,
          tab.tabId,
          { mediaType: 'image', srcURL: url },
          'open-image-in-new-tab',
        );
      }

      expect(
        await observeFor(700, async () =>
          JSON.stringify((await tabStates(electronApp)).map((t) => [t.id, t.url])),
        ),
      ).toEqual([before]);
      expect((await tabState(electronApp, tab.tabId))?.title).toBe('Page A');
    });

    test('"Open image in new tab" opens a background tab on the image', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/image.html'));
      const src = fixtureServer.url('/favicon.png');
      const before = await mainIds(electronApp);

      await invokeContextMenuItem(
        electronApp,
        tab.tabId,
        { mediaType: 'image', srcURL: src, hasImageContents: true },
        'open-image-in-new-tab',
      );

      await expect.poll(async () => (await mainIds(electronApp)).length).toBe(before.length + 1);
      const opened = (await mainIds(electronApp)).at(-1) ?? '';
      await expect.poll(async () => (await tabState(electronApp, opened))?.url).toBe(src);
      expect(await selectedTabId(electronApp)).toBe(tab.tabId);
    });

    test('"Copy link address" and "Copy image address" write the system clipboard', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-a.html?case=copy-url'),
      );
      await withSavedClipboard(electronApp, async () => {
        await writeClipboard(electronApp, 'veltriva-before-copy');
        // Building the menu is not choosing an item: the clipboard is untouched.
        await contextMenuItems(electronApp, tab.tabId, { linkURL: 'https://example.invalid/a' });
        expect(await readClipboard(electronApp)).toBe('veltriva-before-copy');

        // Any link can be copied, including ones a tab may not open.
        const link = 'javascript:alert("copied, not run")';
        await invokeContextMenuItem(electronApp, tab.tabId, { linkURL: link }, 'copy-link');
        await expect.poll(() => readClipboard(electronApp)).toBe(link);

        const src = fixtureServer.url('/favicon.png?case=copy-image-address');
        await invokeContextMenuItem(
          electronApp,
          tab.tabId,
          { mediaType: 'image', srcURL: src },
          'copy-image-address',
        );
        await expect.poll(() => readClipboard(electronApp)).toBe(src);
      });
    });

    test('"Copy image" puts the picture under the pointer on the clipboard', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/image.html'));
      const page = await pageForTab(electronApp, tab.tabId);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                (globalThis as FieldGlobal).document.getElementById('picture') as {
                  complete: boolean;
                }
              ).complete,
          ),
        )
        .toBe(true);
      await withSavedClipboard(electronApp, async () => {
        await electronApp.evaluate(({ clipboard }) => {
          clipboard.clear();
        });
        const imageBytes = (): Promise<number[]> =>
          electronApp.evaluate(async ({ clipboard }) => {
            const sizes: number[] = [];
            for (const item of await clipboard.read()) {
              if (item.types.includes('image/png')) {
                sizes.push((await item.getType('image/png')).size);
              }
            }
            return sizes;
          });
        expect(await imageBytes()).toEqual([]);

        await invokeContextMenuItem(
          electronApp,
          tab.tabId,
          {
            x: 40,
            y: 40,
            mediaType: 'image',
            srcURL: fixtureServer.url('/favicon.png'),
            hasImageContents: true,
          },
          'copy-image',
        );

        // A PNG is on the clipboard now: the 16 by 16 picture.
        await expect.poll(async () => (await imageBytes()).length).toBe(1);
        expect((await imageBytes())[0]).toBeGreaterThan(0);
      });
    });

    test('"Search … for" opens the selected text in a new, selected tab on the search template', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const [first] = await mainIds(electronApp);
      const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=search'));
      const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=search'));
      await tabElement(shell, tabA.tabId).click();
      await expect.poll(() => selectedTabId(electronApp)).toBe(tabA.tabId);

      // The text is encoded into the query, not pasted into the URL: `&`, `=` and `#` stay text.
      const selected = '  a&b=c #d "quoted" ';
      await invokeContextMenuItem(
        electronApp,
        tabA.tabId,
        { selectionText: selected },
        'search-selection',
      );

      await expect.poll(async () => (await mainIds(electronApp)).length).toBe(4);
      const ids = await mainIds(electronApp);
      expect(ids).toEqual([first, tabA.tabId, ids[2], tabB.tabId]);
      const opened = ids[2] ?? '';
      await expect.poll(() => selectedTabId(electronApp)).toBe(opened);
      await waitForPage(electronApp, opened, { title: 'Search results for: a&b=c #d "quoted"' });
      const url = new URL((await tabState(electronApp, opened))?.url ?? '');
      expect(url.origin).toBe(fixtureServer.origin);
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('q')).toBe('a&b=c #d "quoted"');
      // The keyboard goes to the page that opened (a selected tab with a page gets it).
      await expect
        .poll(async () => (await focusedWebContents(electronApp))?.webContentsId)
        .toBe((await tabState(electronApp, opened))?.webContentsId);
    });

    test('Back, Forward and Reload act on the tab', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const urlA = fixtureServer.url('/page-a.html?case=nav-menu');
      const urlB = fixtureServer.url('/page-b.html?case=nav-menu');
      const tab = await loadTab(electronApp, shell, urlA);
      await typeAddress(shell, urlB);
      await waitForPage(electronApp, tab.tabId, { url: urlB, title: 'Page B' });

      await invokeContextMenuItem(electronApp, tab.tabId, {}, 'back');
      await waitForPage(electronApp, tab.tabId, { url: urlA, title: 'Page A' });

      await invokeContextMenuItem(electronApp, tab.tabId, {}, 'forward');
      await waitForPage(electronApp, tab.tabId, { url: urlB, title: 'Page B' });

      const hits = fixtureServer.hits('/page-b.html?case=nav-menu');
      await invokeContextMenuItem(electronApp, tab.tabId, {}, 'reload');
      await expect.poll(() => fixtureServer.hits('/page-b.html?case=nav-menu')).toBe(hits + 1);
      await waitForPage(electronApp, tab.tabId, { url: urlB, title: 'Page B' });
    });

    test("Inspect opens the page's DevTools", async ({ electronApp, fixtureServer, shell }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=inspect'));
      expect(await isDevToolsOpened(electronApp, tab.webContentsId)).toBe(false);

      await invokeContextMenuItem(electronApp, tab.tabId, { x: 30, y: 30 }, 'inspect');

      await expect.poll(() => isDevToolsOpened(electronApp, tab.webContentsId)).toBe(true);
      await expect
        .poll(
          async () =>
            (await webContentsRoles(electronApp)).filter((e) => e.role === 'devtools').length,
        )
        .toBe(1);
      // Inspecting again does not close them or open a second window.
      await invokeContextMenuItem(electronApp, tab.tabId, { x: 60, y: 60 }, 'inspect');
      expect(
        await observeFor(700, async () =>
          JSON.stringify([
            await isDevToolsOpened(electronApp, tab.webContentsId),
            (await webContentsRoles(electronApp)).filter((e) => e.role === 'devtools').length,
          ]),
        ),
      ).toEqual([JSON.stringify([true, 1])]);
    });

    test('the edit items act on the field that has the keyboard', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/keys.html?case=edit'));
      const page = await pageForTab(electronApp, tab.tabId);
      const field = { isEditable: true };
      const fieldState = (): Promise<{ value: string; start: number | null; end: number | null }> =>
        page.evaluate(() => {
          const input = (globalThis as FieldGlobal).document.getElementById(
            'field',
          ) as FieldElement;
          return { value: input.value, start: input.selectionStart, end: input.selectionEnd };
        });

      await withSavedClipboard(electronApp, async () => {
        await writeClipboard(electronApp, 'veltriva-clip');
        await page.evaluate(() => {
          const input = (globalThis as FieldGlobal).document.getElementById(
            'field',
          ) as FieldElement;
          input.value = 'abc def';
          input.focus();
          input.select();
        });

        // Select all / Copy.
        await page.evaluate(() => {
          const input = (globalThis as FieldGlobal).document.getElementById(
            'field',
          ) as FieldElement;
          input.selectionStart = input.selectionEnd = 0;
        });
        await invokeContextMenuItem(electronApp, tab.tabId, field, 'select-all');
        await expect.poll(fieldState).toMatchObject({ value: 'abc def', start: 0, end: 7 });
        await invokeContextMenuItem(electronApp, tab.tabId, field, 'copy');
        await expect.poll(() => readClipboard(electronApp)).toBe('abc def');

        // Cut: the selection leaves the field and goes to the clipboard.
        await invokeContextMenuItem(electronApp, tab.tabId, field, 'cut');
        await expect.poll(fieldState).toMatchObject({ value: '' });
        expect(await readClipboard(electronApp)).toBe('abc def');

        // Paste puts it back, and Undo takes it away again, Redo restores it.
        await invokeContextMenuItem(electronApp, tab.tabId, field, 'paste');
        await expect.poll(fieldState).toMatchObject({ value: 'abc def' });
        await invokeContextMenuItem(electronApp, tab.tabId, field, 'undo');
        await expect.poll(async () => (await fieldState()).value).not.toBe('abc def');
        await invokeContextMenuItem(electronApp, tab.tabId, field, 'redo');
        await expect.poll(async () => (await fieldState()).value).toBe('abc def');

        // Paste as plain text pastes the clipboard's text too.
        await invokeContextMenuItem(electronApp, tab.tabId, field, 'select-all');
        await writeClipboard(electronApp, 'plain');
        await invokeContextMenuItem(electronApp, tab.tabId, field, 'paste-plain');
        await expect.poll(fieldState).toMatchObject({ value: 'plain' });
      });
    });

    test('"Copy" of selected page text puts the selection on the clipboard', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-a.html?case=copy-selection'),
      );
      const page = await pageForTab(electronApp, tab.tabId);
      await page.evaluate(() => {
        const view = globalThis as FieldGlobal;
        view.getSelection().selectAllChildren(view.document.querySelector('h1'));
      });
      await withSavedClipboard(electronApp, async () => {
        await writeClipboard(electronApp, 'veltriva-before-selection');

        await invokeContextMenuItem(electronApp, tab.tabId, { selectionText: 'Page A' }, 'copy');

        await expect.poll(() => readClipboard(electronApp)).toBe('Page A');
      });
    });

    test('"Add to dictionary" adds the misspelled word to the profile\'s dictionary', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-a.html?case=dictionary'),
      );
      const words = (): Promise<string[]> =>
        electronApp.evaluate(({ webContents }, id) => {
          const contents = webContents.fromId(id);
          return contents === undefined
            ? Promise.resolve([])
            : contents.session.listWordsInSpellCheckerDictionary();
        }, tab.webContentsId);
      expect(await words()).not.toContain('veltrivaword');

      await invokeContextMenuItem(
        electronApp,
        tab.tabId,
        { isEditable: true, misspelledWord: 'veltrivaword', dictionarySuggestions: [] },
        'add-to-dictionary',
      );

      await expect.poll(words).toContain('veltrivaword');
      // Without a misspelled word there is nothing to add.
      await invokeContextMenuItem(
        electronApp,
        tab.tabId,
        { isEditable: true },
        'add-to-dictionary',
      );
      expect(await words()).toEqual(['veltrivaword']);
    });
  });
});

/** Both menus are native and drawn by main; the sidebar tab menu is the keyboard's way to its actions too. */
test.describe('sidebar tab menu', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('entries follow the tab: Reload needs a page, Close others needs another unpinned tab, Reopen needs a closed tab', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    if (first === undefined) {
      throw new Error('the app starts with a tab');
    }

    // The only tab, a new-tab page.
    expect(lines(await tabMenuItems(electronApp, first))).toEqual([
      'new-tab-below: New tab below',
      '---',
      'reload: Reload (disabled)',
      'duplicate: Duplicate',
      'pin: Pin tab',
      '---',
      'close: Close tab',
      'close-others: Close other tabs (disabled)',
      '---',
      'reopen-closed: Reopen closed tab (disabled)',
    ]);

    // A second tab with a page: Reload and Close other tabs are available.
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=tab-menu'));
    expect(lines(await tabMenuItems(electronApp, tabA.tabId))).toEqual([
      'new-tab-below: New tab below',
      '---',
      'reload: Reload',
      'duplicate: Duplicate',
      'pin: Pin tab',
      '---',
      'close: Close tab',
      'close-others: Close other tabs',
      '---',
      'reopen-closed: Reopen closed tab (disabled)',
    ]);

    // A pinned tab offers to unpin.
    await invokeTabMenuItem(electronApp, tabA.tabId, 'pin');
    await expect.poll(async () => (await tabState(electronApp, tabA.tabId))?.pinned).toBe(true);
    const pinned = lines(await tabMenuItems(electronApp, tabA.tabId));
    expect(pinned).toContain('unpin: Unpin tab');
    expect(pinned).not.toContain('pin: Pin tab');

    // Once a tab with a page has been closed, Reopen closed tab is available on every tab.
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=tab-menu'));
    await invokeTabMenuItem(electronApp, tabB.tabId, 'close');
    await expect.poll(() => tabState(electronApp, tabB.tabId)).toBeUndefined();
    expect(lines(await tabMenuItems(electronApp, first)).at(-1)).toBe(
      'reopen-closed: Reopen closed tab',
    );
  });

  test('"New tab below" opens a tab right after this one', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=below'));
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=below'));

    await invokeTabMenuItem(electronApp, tabA.tabId, 'new-tab-below');

    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(4);
    const ids = await mainIds(electronApp);
    expect(ids[0]).toBe(first);
    expect(ids[1]).toBe(tabA.tabId);
    expect(ids[3]).toBe(tabB.tabId);
    const created = ids[2] ?? '';
    expect((await tabState(electronApp, created))?.page).toMatchObject({ name: 'new-tab' });
    // The sidebar shows it between the two.
    await expect
      .poll(async () => (await sidebarTabs(shell)).map((tab) => tab.id))
      .toEqual([first, tabA.tabId, created, tabB.tabId]);
  });

  test('"Reload" reloads the tab, selected or not', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const path = '/page-a.html?case=tab-reload';
    const tabA = await loadTab(electronApp, shell, fixtureServer.url(path));
    await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=tab-reload'));
    // Tab A is in the background now.
    expect((await tabState(electronApp, tabA.tabId))?.attached).toBe(false);
    expect(fixtureServer.hits(path)).toBe(1);

    await invokeTabMenuItem(electronApp, tabA.tabId, 'reload');

    await expect.poll(() => fixtureServer.hits(path)).toBe(2);
  });

  test('"Duplicate" opens a copy right after the tab, on the same address', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const url = fixtureServer.url('/page-a.html?case=duplicate');
    const tabA = await loadTab(electronApp, shell, url);
    const tabB = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-b.html?case=duplicate'),
    );
    const before = await mainIds(electronApp);

    await invokeTabMenuItem(electronApp, tabA.tabId, 'duplicate');

    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(before.length + 1);
    const ids = await mainIds(electronApp);
    const copy = ids[ids.indexOf(tabA.tabId) + 1] ?? '';
    expect(copy).not.toBe(tabB.tabId);
    expect(ids.indexOf(tabB.tabId)).toBe(ids.indexOf(copy) + 1);
    await waitForPage(electronApp, copy, { url, title: 'Page A' });
    expect(fixtureServer.hits('/page-a.html?case=duplicate')).toBe(2);
    // The original is untouched.
    expect(await tabState(electronApp, tabA.tabId)).toMatchObject({ url, title: 'Page A' });
  });

  test('"Pin tab" and "Unpin tab" move the tab between the pinned section and the rest', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=pin'));
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=pin'));

    await invokeTabMenuItem(electronApp, tabB.tabId, 'pin');
    await expect.poll(async () => (await mainIds(electronApp))[0]).toBe(tabB.tabId);
    expect(await mainIds(electronApp)).toEqual([tabB.tabId, first, tabA.tabId]);
    await expect
      .poll(async () => (await sidebarTabs(shell)).map((tab) => [tab.id, tab.pinned]))
      .toEqual([
        [tabB.tabId, true],
        [first, false],
        [tabA.tabId, false],
      ]);

    // A second pinned tab goes after the first one, before the rest.
    await invokeTabMenuItem(electronApp, tabA.tabId, 'pin');
    await expect
      .poll(async () => (await mainIds(electronApp)).join(' '))
      .toBe([tabB.tabId, tabA.tabId, first].join(' '));

    // Unpin: back to the start of the unpinned tabs.
    await invokeTabMenuItem(electronApp, tabB.tabId, 'unpin');
    await expect.poll(async () => (await tabState(electronApp, tabB.tabId))?.pinned).toBe(false);
    expect(await mainIds(electronApp)).toEqual([tabA.tabId, tabB.tabId, first]);
    await expect
      .poll(async () => (await sidebarTabs(shell)).map((tab) => [tab.id, tab.pinned]))
      .toEqual([
        [tabA.tabId, true],
        [tabB.tabId, false],
        [first, false],
      ]);
  });

  test('"Close tab" closes it and the tab that takes its place is selected', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=close'));
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=close'));

    // Closing a tab that is not selected leaves the selection alone.
    await invokeTabMenuItem(electronApp, tabA.tabId, 'close');
    await expect.poll(() => tabState(electronApp, tabA.tabId)).toBeUndefined();
    expect(await mainIds(electronApp)).toEqual([first, tabB.tabId]);
    expect(await selectedTabId(electronApp)).toBe(tabB.tabId);

    // Closing the selected one selects the neighbor.
    await invokeTabMenuItem(electronApp, tabB.tabId, 'close');
    await expect.poll(() => tabState(electronApp, tabB.tabId)).toBeUndefined();
    expect(await mainIds(electronApp)).toEqual([first]);
    expect(await selectedTabId(electronApp)).toBe(first);
  });

  test('"Close other tabs" leaves this tab, selected, and the pinned ones, as in Chrome', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=others'));
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=others'));
    await loadTab(electronApp, shell, fixtureServer.url('/page-c.html?case=others'));
    expect(await mainIds(electronApp)).toHaveLength(4);
    await invokeTabMenuItem(electronApp, tabB.tabId, 'pin');
    await expect.poll(async () => (await tabState(electronApp, tabB.tabId))?.pinned).toBe(true);

    // Run on a tab that is not selected: it and the pinned tab are left, and it is selected.
    await invokeTabMenuItem(electronApp, tabA.tabId, 'close-others');

    await expect.poll(async () => await mainIds(electronApp)).toEqual([tabB.tabId, tabA.tabId]);
    expect(await selectedTabId(electronApp)).toBe(tabA.tabId);
    await expect
      .poll(async () => (await sidebarTabs(shell)).map((tab) => [tab.id, tab.selected]))
      .toEqual([
        [tabB.tabId, false],
        [tabA.tabId, true],
      ]);
    await expect(tabElement(shell, tabA.tabId)).toHaveAttribute('aria-selected', 'true');
    // Only a pinned tab is left besides it, so there is nothing more to close from here...
    expect(lines(await tabMenuItems(electronApp, tabA.tabId))).toContain(
      'close-others: Close other tabs (disabled)',
    );
    // ...while from the pinned tab, the unpinned one can still be closed.
    expect(lines(await tabMenuItems(electronApp, tabB.tabId))).toContain(
      'close-others: Close other tabs',
    );
  });

  test('"Reopen closed tab" brings back the last closed address', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=reopen-menu');
    const urlB = fixtureServer.url('/page-b.html?case=reopen-menu');
    const tabA = await loadTab(electronApp, shell, urlA);
    const tabB = await loadTab(electronApp, shell, urlB);

    await invokeTabMenuItem(electronApp, tabB.tabId, 'close');
    await expect.poll(() => tabState(electronApp, tabB.tabId)).toBeUndefined();
    await closeWithButton(shell, tabA.tabId);
    await expect.poll(() => tabState(electronApp, tabA.tabId)).toBeUndefined();
    const remaining = await mainIds(electronApp);
    expect(remaining).toHaveLength(1);

    // The last closed (A) comes back first, then B.
    await invokeTabMenuItem(electronApp, remaining[0] ?? '', 'reopen-closed');
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(2);
    const reopenedA = (await mainIds(electronApp))[1] ?? '';
    await waitForPage(electronApp, reopenedA, { url: urlA, title: 'Page A' });

    await invokeTabMenuItem(electronApp, remaining[0] ?? '', 'reopen-closed');
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(3);
    const reopenedB = (await mainIds(electronApp))[2] ?? '';
    await waitForPage(electronApp, reopenedB, { url: urlB, title: 'Page B' });

    // Nothing left: the entry is disabled again.
    expect(lines(await tabMenuItems(electronApp, remaining[0] ?? '')).at(-1)).toBe(
      'reopen-closed: Reopen closed tab (disabled)',
    );
  });

  test("a right-click on a sidebar tab is the tab menu's: the shell's own context-menu event never fires", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabA = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=right-click'),
    );
    const shellId = await shellContentsId(electronApp);
    // Every `context-menu` event the shell's web contents raises: Chromium raises it for a
    // right-click the page left alone, and main answers it with an editing menu for fields.
    const events = await electronApp.evaluateHandle(({ webContents }, id) => {
      const seen: { x: number; y: number; isEditable: boolean }[] = [];
      webContents.fromId(id)?.on('context-menu', (_event, params) => {
        seen.push({ x: params.x, y: params.y, isEditable: params.isEditable });
      });
      return seen;
    }, shellId);

    // The control: a right-click on empty sidebar space raises it (and shows nothing: only fields
    // get a menu in the shell).
    await shell.mouse.click(40, 600, { button: 'right' });
    await expect.poll(() => events.jsonValue()).toEqual([{ x: 40, y: 600, isEditable: false }]);

    // On a tab the shell's page handles the right-click itself and asks main for the tab menu, so
    // Chromium has nothing to report.
    await tabElement(shell, tabA.tabId).click({ button: 'right' });
    expect(await observeFor(700, async () => (await events.jsonValue()).length)).toEqual([1]);
    // It only asked for a menu: no tab was selected, closed or changed by the click.
    expect(await selectedTabId(electronApp)).toBe(tabA.tabId);
    expect(await mainIds(electronApp)).toHaveLength(2);
  });
});
