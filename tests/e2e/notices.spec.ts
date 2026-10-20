// M2.1b: the notice strip (src/renderer/features/notices). When Veltriva had to recover its
// database, main holds a notice and the shell shows it under the toolbar until the user dismisses
// it. Main is authoritative (ADR-0005): the shell shows the notices in the snapshot, oldest first,
// and sends a dismissal by id.
//
// A recovery can't be staged from here without damaging a database, so these specs raise notices
// with the `showNotice` test hook, which calls what main calls after a recovery. A strip is
// `[data-notice-strip]` with `data-notice-kind` and `data-notice-id`; its button is found by role
// and name, as everything in the shell is. The strips are chrome, so the page is placed below them:
// the specs check the content rect the layout manager computes, the shell's own `#content-area`
// box and the tab's view together (`expectConsistent`).
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import type { AppNotice, NewAppNotice } from '../../src/main/notices/app-notices';
import { expect } from './expect';
import { test } from './fixtures';
import { contentRect, tabState } from './hooks';
import type { PageGlobal } from './page-globals';
import { workspaceSnapshot } from './prompt-ui';
import { expectConsistent, loadTab, omnibox } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

// ── What the specs raise ────────────────────────────────────────────────────────────────────────

const BACKUP_AT = Date.UTC(2026, 9, 21, 8, 30);
const CORRUPT = 'veltriva.db.corrupt-2026-10-21T08-30-00Z';

const RESTORED: NewAppNotice = {
  kind: 'database-restored',
  backupAt: BACKUP_AT,
  corruptFile: CORRUPT,
};
const RESET: NewAppNotice = { kind: 'database-reset', corruptFile: 'veltriva.db.corrupt-reset' };

/** Raises a notice in main, as it does after a recovery. Resolves to the notice's id. */
function showNotice(app: ElectronApplication, notice: NewAppNotice): Promise<string> {
  return app.evaluate((_electron, raised) => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.showNotice(raised);
  }, notice);
}

/** The notices as main holds them, oldest first. */
function mainNotices(app: ElectronApplication): Promise<AppNotice[]> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.notices();
  });
}

// ── Locators ────────────────────────────────────────────────────────────────────────────────────

/** Every strip, whatever it says. */
function strips(shell: Page): Locator {
  return shell.locator('[data-notice-strip]');
}

/** The strip of one notice, by main's id for it. */
function stripFor(shell: Page, noticeId: string): Locator {
  return shell.locator(`[data-notice-strip][data-notice-id="${noticeId}"]`);
}

function sentenceOf(shell: Page, noticeId: string): Locator {
  return stripFor(shell, noticeId).locator('p');
}

function dismissButton(shell: Page, noticeId: string): Locator {
  return stripFor(shell, noticeId).getByRole('button', { name: 'Dismiss', exact: true });
}

/** The ids of the strips on screen, top to bottom. */
function stripIds(shell: Page): Promise<(string | null)[]> {
  return shell.evaluate(() => {
    const page = globalThis as PageGlobal;
    return Array.from(page.document.querySelectorAll('[data-notice-strip]'), (strip) =>
      strip.getAttribute('data-notice-id'),
    );
  });
}

// ── The room the strips take ────────────────────────────────────────────────────────────────────

/** Display scaling rounds a fractional box inward on each edge, so an edge can be a pixel or two off. */
const EDGE_TOLERANCE = 2;

async function heightOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error('The element has no box: it is not on screen.');
  }
  return box.height;
}

/**
 * Waits until the selected tab's content rect starts `moved` pixels below where `before` started
 * and ends where it did: the strips took their room from the top of the page, and nothing else
 * moved.
 */
async function expectContentMovedDown(
  app: ElectronApplication,
  before: { readonly y: number; readonly height: number },
  moved: number,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const rect = await contentRect(app);
        return {
          top: Math.abs(rect.y - before.y - moved) <= EDGE_TOLERANCE,
          bottom: Math.abs(rect.y + rect.height - (before.y + before.height)) <= EDGE_TOLERANCE,
        };
      },
      { message },
    )
    .toEqual({ top: true, bottom: true });
}

// ── What a strip says ───────────────────────────────────────────────────────────────────────────

test.describe('the notice strip', () => {
  test('says a restored database was damaged, when its backup is from, and where the file went', async ({
    electronApp,
    shell,
  }) => {
    await expect(strips(shell), 'no notice until main raises one').toHaveCount(0);

    const id = await showNotice(electronApp, RESTORED);
    const strip = stripFor(shell, id);
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('data-notice-kind', 'database-restored');
    await expect(shell.getByRole('region', { name: 'Database restored from backup' })).toHaveCount(
      1,
    );

    // The sentence is exact except for the time, which the machine's language and zone decide.
    await expect(sentenceOf(shell, id)).toHaveText(
      new RegExp(
        "^Veltriva's database was damaged, so it was restored from a backup from .+\\. " +
          'The damaged file was kept as veltriva\\.db\\.corrupt-2026-10-21T08-30-00Z in your profile folder\\.$',
        'u',
      ),
    );
    // The time is the backup's, in the user's own language: the shell writes it as it writes any
    // date. (A wrong instant, such as seconds taken for milliseconds, would read as 1970.)
    const expectedTime = await shell.evaluate(
      (ms) =>
        new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms),
      BACKUP_AT,
    );
    await expect(sentenceOf(shell, id)).toContainText(`a backup from ${expectedTime}.`);

    // The file name is text from outside the sentence: isolated in a <bdi>.
    const name = sentenceOf(shell, id).locator('bdi');
    await expect(name).toHaveText(CORRUPT);
    await expect(name).toHaveAttribute('dir', 'ltr');
    await expect(sentenceOf(shell, id).locator('bdi')).toHaveCount(1);

    // The strip sits under the toolbar, across the window, and its button is named for what it does.
    const toolbar = await shell.locator('header').first().boundingBox();
    const box = await strip.boundingBox();
    expect(toolbar).not.toBeNull();
    expect(box).not.toBeNull();
    expect(Math.abs((box?.y ?? NaN) - ((toolbar?.y ?? 0) + (toolbar?.height ?? 0)))).toBeLessThan(
      EDGE_TOLERANCE,
    );
    const button = dismissButton(shell, id);
    await expect(button).toBeVisible();
    await expect(button).toHaveText('Dismiss');
    // The button says which notice it dismisses: it is described by the sentence.
    await expect(button).toHaveAttribute('aria-describedby', `notice-text-${id}`);
    await expect(sentenceOf(shell, id)).toHaveAttribute('id', `notice-text-${id}`);
  });

  test('says a reset database was damaged, that no backup helped, and where the file went', async ({
    electronApp,
    shell,
  }) => {
    const id = await showNotice(electronApp, RESET);
    const strip = stripFor(shell, id);
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('data-notice-kind', 'database-reset');
    await expect(shell.getByRole('region', { name: 'Database reset' })).toHaveCount(1);
    await expect(sentenceOf(shell, id)).toHaveText(
      "Veltriva's database was damaged and no backup could be used, so Veltriva started with an empty one. " +
        'The damaged file was kept as veltriva.db.corrupt-reset in your profile folder.',
    );
    await expect(sentenceOf(shell, id).locator('bdi')).toHaveText('veltriva.db.corrupt-reset');
    await expect(dismissButton(shell, id)).toBeVisible();
  });

  test('is in the snapshot main sends, as the contract defines it, and main holds the same list', async ({
    electronApp,
    shell,
  }) => {
    expect((await workspaceSnapshot(shell)).notices).toEqual([]);

    const first = await showNotice(electronApp, RESTORED);
    const second = await showNotice(electronApp, RESET);
    expect(first).toMatch(/^notice-[0-9]+$/u);
    expect(second).toMatch(/^notice-[0-9]+$/u);
    expect(second).not.toBe(first);
    await expect(strips(shell)).toHaveCount(2);

    expect((await workspaceSnapshot(shell)).notices).toEqual([
      { id: first, kind: 'database-restored', backupAt: BACKUP_AT, corruptFile: CORRUPT },
      { id: second, kind: 'database-reset', corruptFile: 'veltriva.db.corrupt-reset' },
    ]);
    expect(await mainNotices(electronApp)).toEqual([
      { id: first, kind: 'database-restored', backupAt: BACKUP_AT, corruptFile: CORRUPT },
      { id: second, kind: 'database-reset', corruptFile: 'veltriva.db.corrupt-reset' },
    ]);
  });

  test('stacks several, oldest first, and keeps only the three newest', async ({
    electronApp,
    shell,
  }) => {
    const first = await showNotice(electronApp, RESTORED);
    const second = await showNotice(electronApp, RESET);
    await expect.poll(() => stripIds(shell)).toEqual([first, second]);

    const third = await showNotice(electronApp, RESET);
    const fourth = await showNotice(electronApp, RESTORED);
    // More would only push the page down: the oldest goes.
    await expect.poll(() => stripIds(shell)).toEqual([second, third, fourth]);
    expect((await mainNotices(electronApp)).map((notice) => notice.id)).toEqual([
      second,
      third,
      fourth,
    ]);
    expect((await workspaceSnapshot(shell)).notices.map((notice) => notice.id)).toEqual([
      second,
      third,
      fourth,
    ]);
  });

  test('cuts a long file name in the middle and keeps the whole name for the tooltip', async ({
    electronApp,
    shell,
  }) => {
    const long = `veltriva.db.corrupt-${'x'.repeat(200)}-2026-10-21T08-30-00Z`;
    const id = await showNotice(electronApp, { kind: 'database-reset', corruptFile: long });
    const name = sentenceOf(shell, id).locator('bdi');
    await expect(name).toBeVisible();
    const shown = (await name.textContent()) ?? '';
    expect(Array.from(shown)).toHaveLength(64);
    expect(shown.startsWith('veltriva.db.corrupt-')).toBe(true);
    expect(shown.endsWith('08-30-00Z')).toBe(true);
    expect(shown).toContain('…');
    await expect(name).toHaveAttribute('title', long);
  });
});

// ── Hostile text ────────────────────────────────────────────────────────────────────────────────

test.describe('a hostile file name', () => {
  // A right-to-left override, a null, a bell and a zero-width space, then markup.
  const HOSTILE = 'inv\u202Eoice\u0000\u0007\u200B<img src=x onerror=alert(1)>.exe';
  const CLEANED = 'inv_oice___' + '_img src=x onerror=alert(1)_' + '.exe';
  const FORBIDDEN = ['\u202E', '\u0000', '\u0007', '\u200B'];

  test('is shown cleaned, as text, and isolated in a <bdi>', async ({ electronApp, shell }) => {
    const id = await showNotice(electronApp, { kind: 'database-reset', corruptFile: HOSTILE });
    const strip = stripFor(shell, id);
    await expect(strip).toBeVisible();

    // What the shell was sent is already clean: main builds everything the shell shows.
    const notice = (await workspaceSnapshot(shell)).notices.find(
      (candidate) => candidate.id === id,
    );
    expect(notice?.corruptFile).toBe(CLEANED);

    const name = sentenceOf(shell, id).locator('bdi');
    await expect(name).toHaveText(CLEANED);
    await expect(name).toHaveAttribute('dir', 'ltr');
    const text = (await sentenceOf(shell, id).textContent()) ?? '';
    for (const character of FORBIDDEN) {
      expect(text.includes(character), JSON.stringify(character)).toBe(false);
    }
    expect(text).toBe(
      "Veltriva's database was damaged and no backup could be used, so Veltriva started with an empty one. " +
        `The damaged file was kept as ${CLEANED} in your profile folder.`,
    );
    // Markup in a name stays text: nothing in the strip is an image, and the name is the only
    // run isolated in a <bdi>.
    await expect(strip.locator('img')).toHaveCount(0);
    await expect(strip.locator('bdi')).toHaveCount(1);
  });

  test('is cut to a bare name when it came as a path, so no folder is named', async ({
    electronApp,
    shell,
  }) => {
    const id = await showNotice(electronApp, {
      kind: 'database-restored',
      backupAt: BACKUP_AT,
      corruptFile: 'C:\\Users\\someone\\AppData\\Roaming\\Veltriva\\veltriva.db.corrupt-x',
    });
    await expect(sentenceOf(shell, id).locator('bdi')).toHaveText('veltriva.db.corrupt-x');
    await expect(sentenceOf(shell, id)).not.toContainText('Users');
    const notice = (await workspaceSnapshot(shell)).notices.find(
      (candidate) => candidate.id === id,
    );
    expect(notice?.corruptFile).toBe('veltriva.db.corrupt-x');
  });

  test('that has nothing in it gets a placeholder, and the sentence still reads', async ({
    electronApp,
    shell,
  }) => {
    const id = await showNotice(electronApp, { kind: 'database-reset', corruptFile: '' });
    await expect(sentenceOf(shell, id)).toBeVisible();
    // Main puts a placeholder in an empty name, so the contract holds and the shell shows it.
    await expect(sentenceOf(shell, id)).toContainText('The damaged file was kept as (unnamed) in');
    expect((await workspaceSnapshot(shell)).notices.map((notice) => notice.id)).toEqual([id]);
  });
});

// ── Dismiss ─────────────────────────────────────────────────────────────────────────────────────

test.describe('Dismiss', () => {
  test('removes only that notice, in main and in the shell', async ({ electronApp, shell }) => {
    const first = await showNotice(electronApp, RESTORED);
    const second = await showNotice(electronApp, RESET);
    const third = await showNotice(electronApp, RESTORED);
    await expect.poll(() => stripIds(shell)).toEqual([first, second, third]);

    // The one in the middle.
    await dismissButton(shell, second).click();
    await expect(stripFor(shell, second)).toHaveCount(0);
    await expect.poll(() => stripIds(shell)).toEqual([first, third]);
    expect((await mainNotices(electronApp)).map((notice) => notice.id)).toEqual([first, third]);
    expect((await workspaceSnapshot(shell)).notices.map((notice) => notice.id)).toEqual([
      first,
      third,
    ]);
    // The others are untouched.
    await expect(sentenceOf(shell, first)).toContainText('was restored from a backup');
    await expect(sentenceOf(shell, third)).toContainText('was restored from a backup');

    await dismissButton(shell, first).click();
    await expect.poll(() => stripIds(shell)).toEqual([third]);
    await dismissButton(shell, third).click();
    await expect(strips(shell)).toHaveCount(0);
    expect(await mainNotices(electronApp)).toEqual([]);
    expect((await workspaceSnapshot(shell)).notices).toEqual([]);
  });

  test('a notice raised later gets a new id: a dismissed id never comes back', async ({
    electronApp,
    shell,
  }) => {
    const first = await showNotice(electronApp, RESET);
    await dismissButton(shell, first).click();
    await expect(strips(shell)).toHaveCount(0);

    const again = await showNotice(electronApp, RESET);
    expect(again).not.toBe(first);
    await expect(stripFor(shell, again)).toBeVisible();
    await expect(stripFor(shell, first)).toHaveCount(0);
  });

  test('answers not_found for an id main no longer shows, and nothing for one it does', async ({
    electronApp,
    shell,
  }) => {
    const id = await showNotice(electronApp, RESET);
    const other = await showNotice(electronApp, RESTORED);
    await expect(strips(shell)).toHaveCount(2);

    const outcomes = await shell.evaluate(
      async ({ noticeId, never }) => {
        const { veltriva } = globalThis as PageGlobal;
        const first = await veltriva.notices.dismiss({ noticeId });
        // The same id again, as a second click or a second window would send it.
        const second = await veltriva.notices.dismiss({ noticeId });
        // An id main never issued.
        const unknown = await veltriva.notices.dismiss({ noticeId: never });
        return { first, second, unknown };
      },
      { noticeId: id, never: 'notice-999999' },
    );
    expect(outcomes.first).toEqual({ ok: true, value: {} });
    expect(outcomes.second).toEqual({ ok: false, code: 'not_found' });
    expect(outcomes.unknown).toEqual({ ok: false, code: 'not_found' });

    // The other notice was not touched by any of it.
    await expect.poll(() => stripIds(shell)).toEqual([other]);
    expect((await mainNotices(electronApp)).map((notice) => notice.id)).toEqual([other]);
  });

  test('refuses malformed input with invalid_input, and dismisses nothing', async ({
    electronApp,
    shell,
  }) => {
    const id = await showNotice(electronApp, RESET);
    await expect(stripFor(shell, id)).toBeVisible();

    // Each payload is built in the page from JSON, so `__proto__` is an own property, as it would
    // be in a real attack. (An object literal would set the prototype instead.)
    const payloads: Record<string, string> = {
      'an empty object': '{}',
      null: 'null',
      'an array': '[]',
      'a string': JSON.stringify(id),
      'a number': '42',
      'a boolean': 'true',
      'a number for the id': '{"noticeId":7}',
      'an empty id': '{"noticeId":""}',
      'an id with no number': '{"noticeId":"notice-"}',
      'an id that is not one': '{"noticeId":"notice-1/../x"}',
      "another kind of main's ids": '{"noticeId":"download-1"}',
      'an id with text after it': JSON.stringify({ noticeId: `${id}x` }),
      'an id with a newline after it': JSON.stringify({ noticeId: `${id}\n` }),
      'an id too long to be one': JSON.stringify({ noticeId: `notice-${'1'.repeat(16)}` }),
      'an unknown key': JSON.stringify({ noticeId: id, extra: 1 }),
      'a key that belongs to prompts': JSON.stringify({ noticeId: id, keepFocus: true }),
      'an own __proto__ key': `{"noticeId":${JSON.stringify(id)},"__proto__":{"polluted":true}}`,
      'an own constructor key': `{"noticeId":${JSON.stringify(id)},"constructor":{"prototype":{"polluted":true}}}`,
    };

    const results = await shell.evaluate(async (jsonByLabel) => {
      const { veltriva } = globalThis as PageGlobal;
      const dismiss = (input?: unknown): Promise<unknown> =>
        (veltriva.notices as unknown as { dismiss(input?: unknown): Promise<unknown> }).dismiss(
          input,
        );
      const outcomes: Record<string, unknown> = { 'no input at all': await dismiss() };
      for (const [label, json] of Object.entries(jsonByLabel)) {
        outcomes[label] = await dismiss(JSON.parse(json));
      }
      return { outcomes, pagePolluted: 'polluted' in {} };
    }, payloads);

    const invalid = { ok: false, code: 'invalid_input' };
    expect(results.outcomes).toEqual(
      Object.fromEntries(
        ['no input at all', ...Object.keys(payloads)].map((label) => [label, invalid]),
      ),
    );
    expect(results.pagePolluted).toBe(false);
    expect(await electronApp.evaluate(() => 'polluted' in {})).toBe(false);

    // Not one of them removed the notice.
    expect((await mainNotices(electronApp)).map((notice) => notice.id)).toEqual([id]);
    await expect(stripFor(shell, id)).toBeVisible();
  });
});

// ── The room the strips take ────────────────────────────────────────────────────────────────────

test.describe('the page below the strips', () => {
  test('makes room for each strip and takes it back when the notice is dismissed', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=notices-room'),
    );
    await expectConsistent(electronApp, shell, 'the page should start below the toolbar');
    const before = await contentRect(electronApp);
    const viewBefore = (await tabState(electronApp, tab.tabId))?.bounds;
    expect(viewBefore).toBeTruthy();

    const first = await showNotice(electronApp, RESTORED);
    await expect(stripFor(shell, first)).toBeVisible();
    const firstHeight = await heightOf(stripFor(shell, first));
    expect(firstHeight).toBeGreaterThan(30);
    await expectContentMovedDown(electronApp, before, firstHeight, 'the page should sit lower');
    await expectConsistent(electronApp, shell, 'the page should sit below the strip, not under it');

    // A second strip takes room too, and the page's view follows the content area.
    const second = await showNotice(electronApp, RESET);
    await expect(stripFor(shell, second)).toBeVisible();
    const secondHeight = await heightOf(stripFor(shell, second));
    await expectContentMovedDown(
      electronApp,
      before,
      firstHeight + secondHeight,
      'the page should sit lower still',
    );
    await expectConsistent(electronApp, shell, 'the page should sit below both strips');
    const viewWith = (await tabState(electronApp, tab.tabId))?.bounds;
    expect(
      Math.abs((viewWith?.y ?? NaN) - ((viewBefore?.y ?? 0) + firstHeight + secondHeight)),
    ).toBeLessThanOrEqual(EDGE_TOLERANCE + 1);

    // Dismissing one gives its room back; the other still holds its own.
    await dismissButton(shell, first).click();
    await expect(stripFor(shell, first)).toHaveCount(0);
    await expectContentMovedDown(
      electronApp,
      before,
      secondHeight,
      'the first strip’s room is back',
    );
    await expectConsistent(electronApp, shell);

    await dismissButton(shell, second).click();
    await expect(strips(shell)).toHaveCount(0);
    await expectContentMovedDown(electronApp, before, 0, 'the page should be where it was');
    await expectConsistent(electronApp, shell, 'the page should take all the room back');
  });

  test('stays while another tab is selected: a notice is about Veltriva, not a tab', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const before = await contentRect(electronApp);
    const id = await showNotice(electronApp, RESET);
    await expect(stripFor(shell, id)).toBeVisible();
    const height = await heightOf(stripFor(shell, id));
    await expectContentMovedDown(electronApp, before, height, 'the page should sit lower');

    // A page opened in another tab: the strip is still there, and so is the room for it.
    await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=notices-other-tab'));
    await expect(stripFor(shell, id)).toBeVisible();
    await expect(strips(shell)).toHaveCount(1);
    await expectContentMovedDown(
      electronApp,
      before,
      height,
      'the room should stay with the strip',
    );
    await expectConsistent(electronApp, shell);

    await dismissButton(shell, id).click();
    await expect(strips(shell)).toHaveCount(0);
    await expectContentMovedDown(electronApp, before, 0, 'the page should be where it was');
    await expectConsistent(electronApp, shell);
  });
});

// ── Keyboard ────────────────────────────────────────────────────────────────────────────────────

interface Focused {
  readonly name: string;
  readonly describedBy: string;
}

/** What has the shell's keyboard focus: a name to tell it by, and what it is described by. */
function focusedElement(shell: Page): Promise<Focused> {
  return shell.evaluate(() => {
    const element = (globalThis as PageGlobal).document.activeElement;
    return {
      name: element?.getAttribute('aria-label') ?? element?.textContent ?? '',
      describedBy: element?.getAttribute('aria-describedby') ?? '',
    };
  });
}

test.describe('with the keyboard', () => {
  test('Tab reaches Dismiss, Enter dismisses it, and the keyboard stays in the shell', async ({
    electronApp,
    shell,
  }) => {
    const first = await showNotice(electronApp, RESTORED);
    const second = await showNotice(electronApp, RESET);
    await expect.poll(() => stripIds(shell)).toEqual([first, second]);

    // From the address bar, Tab goes on through the toolbar, then into the strips, top first.
    await omnibox(shell).focus();
    const visited = [(await focusedElement(shell)).name];
    let reached = false;
    for (let presses = 0; presses < 20 && !reached; presses += 1) {
      await shell.keyboard.press('Tab');
      const now = await focusedElement(shell);
      reached = now.describedBy === `notice-text-${first}`;
      if (!reached) {
        visited.push(now.name);
      }
    }
    expect(reached, `Tab should reach the first Dismiss; it visited ${visited.join(' > ')}`).toBe(
      true,
    );
    await expect(dismissButton(shell, first)).toBeFocused();

    // Tab goes on to the next strip's button.
    await shell.keyboard.press('Tab');
    await expect(dismissButton(shell, second)).toBeFocused();
    await shell.keyboard.press('Shift+Tab');
    await expect(dismissButton(shell, first)).toBeFocused();

    // Enter dismisses the first; its button is about to go, so focus moves to the second's.
    await shell.keyboard.press('Enter');
    await expect(stripFor(shell, first)).toHaveCount(0);
    await expect(dismissButton(shell, second)).toBeFocused();
    expect((await mainNotices(electronApp)).map((notice) => notice.id)).toEqual([second]);

    // The last one: focus goes back to where the keyboard came from, not to the page or to nothing.
    await shell.keyboard.press('Enter');
    await expect(strips(shell)).toHaveCount(0);
    expect(await mainNotices(electronApp)).toEqual([]);
    await expect
      .poll(async () => (await focusedElement(shell)).name, {
        message: `focus should return to ${String(visited.at(-1))}`,
      })
      .toBe(visited.at(-1));
  });

  test('Space dismisses too, as it does any button', async ({ electronApp, shell }) => {
    const id = await showNotice(electronApp, RESET);
    await dismissButton(shell, id).focus();
    await expect(dismissButton(shell, id)).toBeFocused();
    await shell.keyboard.press('Space');
    await expect(stripFor(shell, id)).toHaveCount(0);
    expect(await mainNotices(electronApp)).toEqual([]);
  });
});
