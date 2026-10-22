// Where a tab lives, M3.3 (assessment §4.4, §4.12, §4.13; ADR-0003): the strip ("Tabs"), the
// shelf ("Sleeping"), the Archive, and closed; the user's moves between them with Undo; protection
// from automation; and "Leave page?" when a page objects to the user closing its tab. The moves
// go through the same commands the sidebar and the tab menu send (placement-ui.ts), so these specs
// check main's side end to end; sidebar.spec-style UI checks are in placement-sidebar.spec.ts.
//
// Rules from ADR-0008 item 4 that matter here (see lifecycle.spec.ts for the reasons):
//  - Nothing asserts what a hidden page does through Playwright: hidden pages are read from main.
//  - Real clicks and keys are `sendInputEvent` from main (`clickElement`, `sendKey`), so a page's
//    user activation, which decides whether it may object to unloading (S3), is real.
//  - Archiving a live page discards it first (I3: no web contents in the Archive), which takes a
//    few seconds on this laptop, so no timeout here is tight.
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication, Page } from '@playwright/test';

import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import {
  archivedTabs,
  clickElement,
  evaluateInTab,
  lifecyclePlanWith,
  selectedTabId,
  sendKey,
  sleepingTabStates,
  tabState,
  tabStates,
  undoOffer,
  webContentsExists,
} from './hooks';
import type { TabId } from './hooks';
import type { PageGlobal } from './page-globals';
import {
  archiveTab,
  readSavedPlacement,
  restoreTab,
  setProtected,
  shelveTab,
  undoBatch,
} from './placement-ui';
import {
  clickNow,
  clickYes,
  expectNoStrip,
  promptOf,
  stripOfKind,
  stripSentence,
  waitForStrip,
} from './prompt-ui';
import { expectSaved, startWithPages, test } from './session-ui';
import type { Launcher } from './session-ui';
import { closeWithButton, sidebarIds, tabElement, waitForLoaded } from './shell-ui';

// Each test starts the app once or twice, and archiving a live tab discards it (seconds here).
test.describe.configure({ timeout: 180_000 });

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** The id of a tab's web contents; throws if it has none (it is unloaded). */
async function contentsOf(app: ElectronApplication, tabId: TabId): Promise<number> {
  const state = await tabState(app, tabId);
  if (state?.webContentsId === null || state?.webContentsId === undefined) {
    throw new Error(`Tab ${tabId} has no web contents.`);
  }
  return state.webContentsId;
}

/** Clicks the tab in the sidebar and waits until main has it selected. */
async function selectTab(app: ElectronApplication, shell: Page, tabId: TabId): Promise<void> {
  await tabElement(shell, tabId).click();
  await expect
    .poll(() => selectedTabId(app), { message: `tab ${tabId} should become the selected tab` })
    .toBe(tabId);
}

const sleepingIds = async (app: ElectronApplication): Promise<TabId[]> =>
  (await sleepingTabStates(app)).map((tab) => tab.id);

const archivedIds = async (app: ElectronApplication): Promise<TabId[]> =>
  (await archivedTabs(app)).entries.map((tab) => tab.id);

/** Three plain pages, the last one selected; returns the app, its shell and the three ids. */
async function threePages(launcher: Launcher, fixtureServer: FixtureServer) {
  const run = await launcher.launch();
  const page = (name: string): string =>
    fixtureServer.url(`/lifecycle-plain.html?case=placement&tab=${name}`);
  const urls = [page('a'), page('b'), page('c')] as const;
  const ids = await startWithPages(run.app, run.shell, urls);
  return { ...run, urls, ids };
}

/** The beforeunload reports the unload fixture sent for a tag (`?tag=` in its address). */
function beaconsFor(server: FixtureServer, tag: string): string[] {
  return server
    .requestsTo('/lifecycle-beacon')
    .map((request) => new URL(request.url, 'http://fixture.invalid').searchParams)
    .filter((query) => query.get('tag') === tag)
    .map((query) => query.get('objected') ?? '');
}

// ── 1. "Leave page?" ────────────────────────────────────────────────────────────────────────────

test.describe('closing a tab whose page objects', () => {
  test('a page the user worked in asks "Leave page?": Stay keeps it alive, Leave closes it to Recently closed', async ({
    launcher,
    fixtureServer,
  }) => {
    const tag = 'leave';
    const url = fixtureServer.url(`/lifecycle-unload.html?mode=always&tag=${tag}`);
    const { app, shell } = await launcher.launch();
    const [tab] = await startWithPages(app, shell, [url]);
    const contents = await contentsOf(app, tab);
    await clickElement(app, contents, '#button');
    expect(await evaluateInTab(app, contents, 'navigator.userActivation.hasBeenActive')).toBe(true);

    // Ctrl+W in the page: the page objects, and the toolbar asks. The site is main's own label.
    await sendKey(app, contents, 'W', ['control']);
    await waitForStrip(shell, 'leave-page');
    const host = new URL(url).host;
    await expect(stripSentence(shell)).toHaveText(
      `Leave ${host}? Changes you made may not be saved.`,
    );
    expect(await promptOf(shell, tab)).toMatchObject({ kind: 'leave-page', site: host });
    expect(await sidebarIds(shell)).toEqual([tab]);
    expect(await tabState(app, tab)).toMatchObject({
      runtime: 'live',
      webContentsId: contents,
      attached: true,
    });
    await expect.poll(() => beaconsFor(fixtureServer, tag), { timeout: 30_000 }).toContain('true');

    // Stay: nothing else happens, and the page is alive.
    await clickNow(shell, 'Stay');
    await expectNoStrip(shell, 'Stay should take the question down');
    expect(await evaluateInTab(app, contents, '1 + 1')).toBe(2);
    expect(await sidebarIds(shell)).toEqual([tab]);

    // The close button asks again; Leave closes the tab without running the handler again.
    const asked = beaconsFor(fixtureServer, tag).length;
    await closeWithButton(shell, tab);
    await waitForStrip(shell, 'leave-page');
    // Closing once more while the question waits doesn't ask the page again.
    await closeWithButton(shell, tab);
    await delay(1_000);
    await expect(stripOfKind(shell, 'leave-page')).toHaveCount(1);
    expect(beaconsFor(fixtureServer, tag)).toHaveLength(asked + 1);
    await clickYes(shell, 'Leave');
    await expect
      .poll(() => sidebarIds(shell), { message: 'Leave should close the tab' })
      .not.toContain(tab);
    await expect.poll(() => webContentsExists(app, contents)).toBe(false);
    await delay(1_000);
    expect(beaconsFor(fixtureServer, tag), 'Leave runs no beforeunload').toHaveLength(asked + 1);
    await expectSaved(app, { closedIds: [tab] }, 'the tab should be in Recently closed');
  });

  test('a page nobody worked in cannot object: its tab closes at once, without asking it', async ({
    launcher,
    fixtureServer,
  }) => {
    const tag = 'untouched-close';
    const url = fixtureServer.url(`/lifecycle-unload.html?mode=always&tag=${tag}`);
    const { app, shell } = await launcher.launch();
    const [tab, other] = await startWithPages(app, shell, [url, fixtureServer.url('/blank.html')]);
    await selectTab(app, shell, tab);
    await closeWithButton(shell, tab);
    await expect.poll(() => sidebarIds(shell)).toEqual([other]);
    await expectNoStrip(shell, 'nothing to ask');
    await delay(2_000);
    expect(beaconsFor(fixtureServer, tag), 'a plain close runs no beforeunload (S3)').toEqual([]);
  });
});

// ── 2. Sleeping ─────────────────────────────────────────────────────────────────────────────────

test.describe('Sleeping', () => {
  test('a tab moves to Sleeping keeping its page, comes back next to the current tab, and Undo puts it back where it was', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell, ids } = await threePages(launcher, fixtureServer);
    const [a, b, c] = ids;
    const bContents = await contentsOf(app, b);

    // B goes to Sleeping: out of the strip, still live (Sleeping may hold a loaded page).
    expect(await shelveTab(shell, b)).toBe(true);
    await expect.poll(() => sidebarIds(shell)).toEqual([a, c]);
    expect(await sleepingIds(app)).toEqual([b]);
    expect(await sleepingTabStates(app)).toMatchObject([
      { id: b, placement: 'shelf', runtime: 'live', webContentsId: bContents, attached: false },
    ]);
    expect(await selectedTabId(app)).toBe(c);
    expect(await undoOffer(app)).toMatchObject({ automated: false, shelved: 1, archived: 0 });

    // Undo: back where it was, between A and C, not selected.
    const offer = await undoOffer(app);
    expect(await undoBatch(shell, offer?.batchId ?? '')).toBe(1);
    await expect.poll(() => sidebarIds(shell)).toEqual([a, b, c]);
    expect(await sleepingIds(app)).toEqual([]);
    expect(await undoOffer(app)).toBeNull();
    expect(await selectedTabId(app)).toBe(c);
    // A second click on the same Undo does nothing.
    expect(await undoBatch(shell, offer?.batchId ?? '')).toBe(0);

    // To Sleeping again, then restore while A is selected: next to A, selected, the same page.
    expect(await shelveTab(shell, b)).toBe(true);
    await selectTab(app, shell, a);
    expect(await restoreTab(shell, b)).toBe(b);
    await expect.poll(() => sidebarIds(shell)).toEqual([a, b, c]);
    expect(await selectedTabId(app)).toBe(b);
    expect(await tabState(app, b)).toMatchObject({
      placement: 'strip',
      runtime: 'live',
      webContentsId: bContents,
      attached: true,
    });

    // The selected tab can go too: the one next to it is selected. A pinned tab cannot (I8).
    expect(await shelveTab(shell, b)).toBe(true);
    await expect.poll(() => selectedTabId(app)).not.toBe(b);
    await shell.evaluate(
      (id) => (globalThis as PageGlobal).veltriva.tabs.setPinned({ tabId: id, pinned: true }),
      a,
    );
    expect(await shelveTab(shell, a)).toBe(false);
    expect(await sleepingIds(app)).toEqual([b]);
  });
});

// ── 3. The Archive ──────────────────────────────────────────────────────────────────────────────

test.describe('the Archive', () => {
  test('archiving a live page unloads it first (I3); restoring brings it back next to the current tab with its history', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell, ids, urls } = await threePages(launcher, fixtureServer);
    const [a, b, c] = ids;
    // B gets a second page, so its back/forward stack has two entries.
    await selectTab(app, shell, b);
    const second = fixtureServer.url('/lifecycle-plain.html?case=placement&tab=b2');
    await evaluateInTab(app, await contentsOf(app, b), `location.href = ${JSON.stringify(second)}`);
    await expect.poll(async () => (await tabState(app, b))?.url).toBe(second);
    await waitForLoaded(app, b);
    await selectTab(app, shell, c);
    const bContents = await contentsOf(app, b);

    expect(await archiveTab(shell, b)).toBe(true);
    await expect.poll(() => sidebarIds(shell)).toEqual([a, c]);
    expect(await sleepingIds(app)).toEqual([]);
    const archived = await archivedTabs(app);
    expect(archived.count).toBe(1);
    expect(archived.entries).toMatchObject([{ id: b, url: second, reason: 'manual' }]);
    // No web contents in the Archive.
    await expect.poll(() => webContentsExists(app, bContents)).toBe(false);
    expect(await tabState(app, b)).toBeUndefined();
    expect(await undoOffer(app)).toMatchObject({ automated: false, shelved: 0, archived: 1 });

    // Restore while A is selected: next to A, selected, loaded at the second page, and Back goes
    // to the first.
    await selectTab(app, shell, a);
    const restored = await restoreTab(shell, b);
    await expect.poll(() => sidebarIds(shell)).toEqual([a, restored, c]);
    expect(await selectedTabId(app)).toBe(restored);
    await waitForLoaded(app, restored);
    expect(await tabState(app, restored)).toMatchObject({ url: second, canGoBack: true });
    expect((await archivedTabs(app)).count).toBe(0);
    const back = await contentsOf(app, restored);
    await evaluateInTab(app, back, 'history.back()');
    await expect.poll(async () => (await tabState(app, restored))?.url).toBe(urls[1]);
  });

  test('Undo of an archive puts the tab back in its place, unloaded; a page that objects keeps its tab out', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell, ids } = await threePages(launcher, fixtureServer);
    const [a, b, c] = ids;
    expect(await archiveTab(shell, a)).toBe(true);
    await expect.poll(() => sidebarIds(shell)).toEqual([b, c]);
    const offer = await undoOffer(app);
    expect(await undoBatch(shell, offer?.batchId ?? '')).toBe(1);
    await expect.poll(() => sidebarIds(shell)).toEqual([a, b, c]);
    expect(await tabState(app, a)).toMatchObject({ runtime: 'unloaded', placement: 'strip' });
    expect(await archivedIds(app)).toEqual([]);

    // A page the user worked in that objects to unloading keeps its tab: nothing is lost.
    const unload = fixtureServer.url('/lifecycle-unload.html?mode=always&case=archive');
    await evaluateInTab(app, await contentsOf(app, c), `location.href = ${JSON.stringify(unload)}`);
    await expect.poll(async () => (await tabState(app, c))?.url).toBe(unload);
    await waitForLoaded(app, c);
    const cContents = await contentsOf(app, c);
    await clickElement(app, cContents, '#button');
    await selectTab(app, shell, b);
    expect(await archiveTab(shell, c)).toBe(false);
    expect(await sidebarIds(shell)).toEqual([a, b, c]);
    expect(await tabState(app, c)).toMatchObject({ runtime: 'live', webContentsId: cContents });
    expect(await archivedIds(app)).toEqual([]);
  });
});

// ── 4. Protection ───────────────────────────────────────────────────────────────────────────────

test.describe('protection', () => {
  test('a protected tab is never planned for automation, however long unused; unprotecting lets the plan in again', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell, ids } = await threePages(launcher, fixtureServer);
    const [a, b] = ids;
    await setProtected(shell, a, true);
    expect(await tabState(app, a)).toMatchObject({ userProtected: true });
    // Ten hours later, under critical pressure: B is planned, A is not. (This all happens within
    // the scheduler's 2-minute quiet start, so the plan is only read, never carried out.)
    const plan = await lifecyclePlanWith(app, {
      clock: { wallMs: 10 * 60 * 60 * 1000 },
      pressure: 'critical',
      then: { pressure: 'none' },
    });
    expect(plan.map((action) => action.tabId)).toContain(b);
    expect(plan.map((action) => action.tabId)).not.toContain(a);
    await setProtected(shell, a, false);
    expect(await tabState(app, a)).toMatchObject({ userProtected: false });
    const after = await lifecyclePlanWith(app, {});
    expect(after.map((action) => action.tabId)).toContain(a);
  });
});

// ── 5. A restart ────────────────────────────────────────────────────────────────────────────────

test.describe('after a restart', () => {
  test('Sleeping and the Archive come back as they were, unloaded, with the user protection', async ({
    launcher,
    fixtureServer,
  }) => {
    const first = await threePages(launcher, fixtureServer);
    const [a, b, c] = first.ids;
    expect(await shelveTab(first.shell, a)).toBe(true);
    expect(await archiveTab(first.shell, b)).toBe(true);
    await setProtected(first.shell, a, true);
    await expect
      .poll(async () => {
        const saved = await readSavedPlacement(first.app);
        return {
          shelf: saved.shelf.map((row) => [row.id, row.userProtected]),
          archived: saved.archived.map((row) => [row.id, row.archiveReason]),
          count: saved.archivedCount,
        };
      })
      .toEqual({ shelf: [[a, true]], archived: [[b, 'manual']], count: 1 });
    await expectSaved(first.app, { ids: [c] });
    await launcher.quit(first);

    const second = await launcher.launch();
    await expect.poll(() => sidebarIds(second.shell)).toEqual([c]);
    expect(await sleepingTabStates(second.app)).toMatchObject([
      { id: a, placement: 'shelf', runtime: 'unloaded', userProtected: true, url: first.urls[0] },
    ]);
    const archived = await archivedTabs(second.app);
    expect(archived).toMatchObject({
      count: 1,
      entries: [{ id: b, url: first.urls[1], reason: 'manual' }],
    });
    // Nothing from the earlier run is offered for Undo.
    expect(await undoOffer(second.app)).toBeNull();
    expect((await tabStates(second.app)).map((tab) => tab.id)).toEqual([c]);
  });
});
