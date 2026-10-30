// What the M1.3a specs share about the shell UI (src/renderer): locators for the toolbar, the
// sidebar and the content area, the actions a user takes there (open a tab, type an address, close,
// pin, drag), and the cross-check between what the shell shows, what TabManager holds and where
// the tab's view sits (`expectConsistent`).
//
// Everything here follows the harness rules at the top of ./launch.ts: it finds elements by role
// and name, polls instead of sleeping, and never closes a Page. The shell renders snapshots main
// sends (at most one per frame), so every read of the DOM is eventually consistent: use
// `expect.poll` or the `expect(locator)` assertions, which retry.
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import type { Rect } from '../../src/core/layout/rect';
import type { WorkspaceSnapshot } from '../../src/shared/contracts/schemas';
import { expect } from './expect';
import { contentRect, selectedTabId, tabState, tabStates } from './hooks';
import type { TabId } from './hooks';
import type { PageGlobal } from './page-globals';

/** The machine may be heavily loaded: be generous. */
export const SLOW_TIMEOUT_MS = 30_000;

// ── Locators ────────────────────────────────────────────────────────────────────────────────────

export function backButton(shell: Page): Locator {
  return shell.getByRole('button', { name: 'Back', exact: true });
}
export function forwardButton(shell: Page): Locator {
  return shell.getByRole('button', { name: 'Forward', exact: true });
}
/** One button: "Reload" while idle, "Stop" while the selected tab loads. */
export function reloadButton(shell: Page): Locator {
  return shell.getByRole('button', { name: 'Reload', exact: true });
}
export function stopButton(shell: Page): Locator {
  return shell.getByRole('button', { name: 'Stop', exact: true });
}
export function omnibox(shell: Page): Locator {
  // A combobox since M4.2: the memory's suggestions hang under it (its role was a textbox).
  return shell.getByRole('combobox', { name: 'Address and search bar', exact: true });
}
export function newTabButton(shell: Page): Locator {
  return shell.getByRole('button', { name: 'New tab', exact: true });
}
/** The security indicator; `data-security` is secure | not-secure | local | internal | neutral. */
export function securityIndicator(shell: Page): Locator {
  return shell.locator('[data-security]');
}
export function credentialsWarning(shell: Page): Locator {
  return shell.locator('[data-indicator="credentials-removed"]');
}
export function loadingBar(shell: Page): Locator {
  return shell.locator('[data-loading-indicator]');
}
export function contentArea(shell: Page): Locator {
  return shell.locator('#content-area');
}
export type InternalPageName =
  | 'new-tab'
  | 'network-error'
  | 'certificate-error'
  | 'client-certificate'
  | 'crashed'
  | 'diagnostics'
  | 'settings'
  | 'welcome'
  | 'about';

/** An internal page the shell draws in the content area. */
export function internalPage(shell: Page, name: InternalPageName): Locator {
  return shell.locator(`[data-internal-page="${name}"]`);
}
/** The search box of the new-tab page (not the address bar). */
export function newTabSearchBox(shell: Page): Locator {
  return internalPage(shell, 'new-tab').getByRole('textbox', {
    name: 'Search or enter address',
    exact: true,
  });
}

export function tabList(shell: Page): Locator {
  return shell.getByRole('tablist', { name: 'Open tabs' });
}
/** Every tab element, in sidebar order. */
export function tabElements(shell: Page): Locator {
  return shell.locator('[role="tab"][data-tab-id]');
}
export function tabElement(shell: Page, tabId: TabId): Locator {
  return shell.locator(`[role="tab"][data-tab-id="${tabId}"]`);
}
/** The wrapper of a tab and its buttons. */
export function tabRow(shell: Page, tabId: TabId): Locator {
  return shell.locator(`[data-tab-row="${tabId}"]`);
}

// ── Reading the sidebar ─────────────────────────────────────────────────────────────────────────

export interface SidebarTab {
  readonly id: TabId;
  /** The accessible name: the page title, else "New Tab", else the address, else "Untitled". */
  readonly label: string;
  /** `aria-selected`. */
  readonly selected: boolean;
  /** `data-selected`, which must always agree with `aria-selected`. */
  readonly dataSelected: boolean;
  readonly pinned: boolean;
  /** `data-tab-status` of the row's icon: loading | failed | crashed, or null. */
  readonly status: string | null;
  /** The favicon `<img>` src in the row, or null if the row has none. */
  readonly faviconSrc: string | null;
}

/** Every tab in the sidebar, in DOM order (pinned section first), read in one go. */
export function sidebarTabs(shell: Page): Promise<SidebarTab[]> {
  return shell.evaluate(() => {
    const page = globalThis as PageGlobal;
    return Array.from(page.document.querySelectorAll('[role="tab"][data-tab-id]'), (tab) => ({
      id: tab.getAttribute('data-tab-id') ?? '',
      label: tab.getAttribute('aria-label') ?? '',
      selected: tab.getAttribute('aria-selected') === 'true',
      dataSelected: tab.getAttribute('data-selected') === 'true',
      pinned: tab.getAttribute('data-pinned') === 'true',
      status: tab.querySelector('[data-tab-status]')?.getAttribute('data-tab-status') ?? null,
      faviconSrc: tab.querySelector('img')?.getAttribute('src') ?? null,
    }));
  });
}

export async function sidebarIds(shell: Page): Promise<TabId[]> {
  return (await sidebarTabs(shell)).map((tab) => tab.id);
}

export async function sidebarLabels(shell: Page): Promise<string[]> {
  return (await sidebarTabs(shell)).map((tab) => tab.label);
}

/** The ids TabManager has, in strip order. */
export async function mainIds(app: ElectronApplication): Promise<TabId[]> {
  return (await tabStates(app)).map((tab) => tab.id);
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Clicks "New tab" and returns the new tab's id once the shell shows it selected and its address
 * bar has focus. Typing earlier loses keystrokes: the shell focuses the address bar only when the
 * new tab's snapshot arrives.
 */
export async function openNewTab(shell: Page): Promise<TabId> {
  // The toolbar and the button exist before the first snapshot arrives. Until the sidebar lists
  // the tab the app started with, "the tabs we had before the click" would be an empty set, and
  // the starting tab would be mistaken for the new one.
  await expect(tabElements(shell).first()).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
  const before = new Set(await sidebarIds(shell));
  await newTabButton(shell).click();

  let created: TabId | undefined;
  await expect
    .poll(
      async () => {
        const tabs = await sidebarTabs(shell);
        created = tabs.find((tab) => !before.has(tab.id) && tab.selected)?.id;
        return created !== undefined;
      },
      { message: 'a new, selected tab should appear in the sidebar', timeout: SLOW_TIMEOUT_MS },
    )
    .toBe(true);
  if (created === undefined) {
    throw new Error('unreachable: the poll above passed without a new tab');
  }

  await expect(omnibox(shell)).toBeFocused({ timeout: SLOW_TIMEOUT_MS });
  return created;
}

/** Types `text` into the address bar of the selected tab and presses Enter. */
export async function typeAddress(shell: Page, text: string): Promise<void> {
  const box = omnibox(shell);
  await box.fill(text);
  await box.press('Enter');
}

/** Opens a new tab and submits `text` from its address bar. Returns the tab's id. */
export async function openTabAt(shell: Page, text: string): Promise<TabId> {
  const tabId = await openNewTab(shell);
  await typeAddress(shell, text);
  return tabId;
}

/**
 * Waits until a tab shows a web page that has committed and stopped loading. Returns the tab's
 * state. (A tab that failed or crashed never gets here: it shows an internal page.)
 */
export async function waitForLoaded(app: ElectronApplication, tabId: TabId) {
  await expect
    .poll(
      async () => {
        const tab = await tabState(app, tabId);
        return tab === undefined
          ? 'missing'
          : `${tab.page.kind}/${tab.runtime}/${tab.loading ? 'loading' : 'idle'}`;
      },
      {
        message: `tab ${tabId} should finish loading a web page`,
        timeout: SLOW_TIMEOUT_MS,
      },
    )
    .toBe('web/live/idle');
  const tab = await tabState(app, tabId);
  if (tab === undefined) {
    throw new Error(`Tab ${tabId} disappeared`);
  }
  return tab;
}

/**
 * Waits until a tab shows the web page at `url` (when given) with `title` (when given), committed
 * and no longer loading. Use it for a second or later navigation in a tab, where `waitForLoaded`
 * could still see the previous page.
 */
export async function waitForPage(
  app: ElectronApplication,
  tabId: TabId,
  expected: { readonly url?: string; readonly title?: string },
): Promise<void> {
  await expect
    .poll(
      async () => {
        const tab = await tabState(app, tabId);
        if (tab === undefined) {
          return { missing: true };
        }
        return {
          page: `${tab.page.kind}/${tab.runtime}/${tab.loading ? 'loading' : 'idle'}`,
          url: tab.url,
          title: tab.title,
        };
      },
      { message: `tab ${tabId} should show ${JSON.stringify(expected)}`, timeout: SLOW_TIMEOUT_MS },
    )
    .toEqual({
      page: 'web/live/idle',
      url: expected.url ?? expect.any(String),
      title: expected.title ?? expect.any(String),
    });
}

/** Opens a new tab, loads `url` through the address bar and waits for the page. */
export async function loadInNewTab(
  app: ElectronApplication,
  shell: Page,
  url: string,
): Promise<TabId> {
  const tabId = await openTabAt(shell, url);
  await waitForLoaded(app, tabId);
  return tabId;
}

/** Shows the tab's "Close tab" button by hovering its row, then clicks it. */
export async function closeWithButton(shell: Page, tabId: TabId): Promise<void> {
  const row = tabRow(shell, tabId);
  await row.hover();
  await row.getByRole('button', { name: 'Close tab', includeHidden: true }).click();
}

/**
 * Clicks the row's "Pin tab" or "Unpin tab" button, whichever it shows, and waits until the shell
 * draws the tab in its new section. Waiting for the order isn't enough: pinning the first tab
 * leaves the order as it was, but adds the "Pinned" label and a separator above the other tabs,
 * which moves every unpinned row down by about one row (35 px, measured). Anything measured
 * before that lands is a row off (the drag-reorder intermittent, M1.3b to v1.0.0).
 */
export async function togglePinWithButton(shell: Page, tabId: TabId): Promise<void> {
  const tab = tabElement(shell, tabId);
  const pinned = (await tab.getAttribute('data-pinned')) === 'true';
  const row = tabRow(shell, tabId);
  await row.hover();
  await row.getByRole('button', { name: /^(Un)?[Pp]in tab$/, includeHidden: true }).click();
  await expect(tab).toHaveAttribute('data-pinned', String(!pinned));
}

/**
 * The drop line the shell draws while `tabId` is dragged to `edge` of `onto`: at the top of the row
 * the tab will land before, or at the bottom of its section's last row. A tab moves only within its
 * own section, so aiming at a row of the other one lands it at the nearer end of its own.
 */
async function dropLineFor(
  shell: Page,
  tabId: TabId,
  onto: TabId,
  edge: 'before' | 'after',
): Promise<Locator> {
  const tabs = await sidebarTabs(shell);
  const dragged = tabs.find((tab) => tab.id === tabId);
  const target = tabs.find((tab) => tab.id === onto);
  if (dragged === undefined || target === undefined) {
    throw new Error('Both tabs must be in the sidebar to drag one.');
  }
  const section = tabs.filter((tab) => tab.pinned === dragged.pinned);
  const from = section.indexOf(dragged);
  let slot: number;
  if (target.pinned === dragged.pinned) {
    slot = section.indexOf(target) + (edge === 'after' ? 1 : 0);
  } else {
    slot = target.pinned ? 0 : section.length;
  }
  if (slot === from || slot === from + 1) {
    throw new Error(`Dropping ${tabId} there leaves it where it is, and the shell draws no line.`);
  }
  const below = section[slot];
  const last = section.at(-1);
  if (below !== undefined) {
    return tabRow(shell, below.id).locator('[data-drop-indicator="top"]');
  }
  if (last === undefined) {
    throw new Error('unreachable: the dragged tab is in its own section');
  }
  return tabRow(shell, last.id).locator('[data-drop-indicator="bottom"]');
}

/**
 * Drags a tab with the pointer (press, move more than 4 px, release) until it is above or below
 * another tab's row. While the drag is in progress, `duringDrag` runs (to look at the drop line).
 *
 * It releases only once the shell shows the drag the test means: the pressed tab marked as
 * dragged, and the drop line where the tab will land. Otherwise a drag that went wrong would drop
 * the wrong tab, or drop it a slot off, and fail later as a wrong order.
 */
export async function dragTab(
  shell: Page,
  tabId: TabId,
  onto: TabId,
  edge: 'before' | 'after',
  duringDrag?: () => Promise<void>,
): Promise<void> {
  // Right after a pin the sidebar re-renders its sections, and a row can be off screen for a
  // moment (found by repeating the tabs spec): measure only once both are shown.
  await expect(tabElement(shell, tabId)).toBeVisible();
  await expect(tabElement(shell, onto)).toBeVisible();
  const landing = await dropLineFor(shell, tabId, onto, edge);
  const from = await tabElement(shell, tabId).boundingBox();
  const to = await tabElement(shell, onto).boundingBox();
  if (from === null || to === null) {
    throw new Error('Both tabs must be on screen to drag one.');
  }
  // Press on the label side of the row, away from its buttons at the right end.
  const x = from.x + 40;
  const startY = from.y + from.height / 2;
  const endY = to.y + to.height * (edge === 'before' ? 0.25 : 0.75);

  await shell.mouse.move(x, startY);
  await shell.mouse.down();
  // A first move past the 4 px threshold, in the direction of travel, then the rest of the way.
  await shell.mouse.move(x, startY + (endY >= startY ? 8 : -8));
  await shell.mouse.move(x, endY, { steps: 6 });
  try {
    // Release only once the shell shows this drag: on a loaded machine the moves can all be sent
    // before the shell has started the drag, and then the release drops nothing (M1.3b to M2.1b).
    await expect(tabElement(shell, tabId), `the shell should be dragging ${tabId}`).toHaveAttribute(
      'data-dragging',
      'true',
    );
    await expect(landing, `the drop line should show where ${tabId} will land`).toHaveCount(1);
    await expect(shell.locator('[data-drop-indicator]')).toHaveCount(1);
    await duringDrag?.();
  } finally {
    await shell.mouse.up();
  }
}

// ── Recording what main sends the shell ────────────────────────────────────────────────────────

type RecorderGlobal = PageGlobal & { __workspaceSnapshots?: WorkspaceSnapshot[] };

/**
 * Starts recording every `workspace.changed` snapshot the shell receives from now on (the same
 * events its UI renders). The shell is the last stop for anything a page could make main show.
 */
export async function recordWorkspaceSnapshots(shell: Page) {
  await shell.evaluate(() => {
    const page = globalThis as RecorderGlobal;
    const seen: WorkspaceSnapshot[] = [];
    page.__workspaceSnapshots = seen;
    page.veltriva.on('workspace.changed', (snapshot) => {
      seen.push(snapshot);
    });
  });
  return {
    snapshots: (): Promise<WorkspaceSnapshot[]> =>
      shell.evaluate(() => (globalThis as RecorderGlobal).__workspaceSnapshots ?? []),
  };
}

// ── Consistency between the shell, TabManager and the view ──────────────────────────────────────

/** One pixel of slack for display-scaling rounding. */
const PIXEL_TOLERANCE = 1;

/**
 * Whether two rectangles have the same edges, each within the tolerance. Edges, not sizes: main
 * rounds every inset of a fractional box inward (src/core/layout/rect.ts), so each edge moves by
 * under a pixel but the size can shrink by up to two (found at 125% scaling: a box at y=198.39,
 * 564.01 tall, became 199 and 563).
 */
function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= PIXEL_TOLERANCE &&
    Math.abs(a.y - b.y) <= PIXEL_TOLERANCE &&
    Math.abs(a.x + a.width - (b.x + b.width)) <= PIXEL_TOLERANCE &&
    Math.abs(a.y + a.height - (b.y + b.height)) <= PIXEL_TOLERANCE
  );
}

const show = (rect: Rect | null): string =>
  rect === null
    ? 'none'
    : `${String(rect.x)},${String(rect.y)} ${String(rect.width)}x${String(rect.height)}`;

/**
 * Everything that is wrong right now, as readable sentences. Empty means consistent:
 *  - the sidebar lists the tabs TabManager has, in the same order, with the same pinned flags;
 *  - exactly one sidebar tab is selected (`aria-selected` and `data-selected` agree), and it is
 *    the tab TabManager selected;
 *  - pinned tabs come first;
 *  - only the selected tab's web view is attached, and only while it shows a web page;
 *  - that view's bounds equal the layout manager's content rect, which equals the shell's
 *    `#content-area` box (within a pixel).
 */
export async function describeProblems(app: ElectronApplication, shell: Page): Promise<string[]> {
  const [sidebar, states, selected, rect, box] = await Promise.all([
    sidebarTabs(shell),
    tabStates(app),
    selectedTabId(app),
    contentRect(app),
    contentArea(shell).boundingBox(),
  ]);
  const problems: string[] = [];

  const sidebarOrder = sidebar.map((tab) => tab.id).join(' ');
  const mainOrder = states.map((tab) => tab.id).join(' ');
  if (sidebarOrder !== mainOrder) {
    problems.push(`the sidebar lists [${sidebarOrder}] but main has [${mainOrder}]`);
  }

  const selectedInSidebar = sidebar.filter((tab) => tab.selected).map((tab) => tab.id);
  if (selectedInSidebar.length !== 1) {
    problems.push(`${String(selectedInSidebar.length)} tabs are aria-selected (want exactly 1)`);
  } else if (selectedInSidebar[0] !== selected) {
    problems.push(
      `the sidebar selects ${selectedInSidebar[0] ?? '?'} but main selects ${String(selected)}`,
    );
  }
  for (const tab of sidebar) {
    if (tab.selected !== tab.dataSelected) {
      problems.push(
        `tab ${tab.id}: aria-selected=${String(tab.selected)} but data-selected=${String(tab.dataSelected)}`,
      );
    }
  }

  const pinnedInSidebar = sidebar.map((tab) => (tab.pinned ? 'P' : '-')).join('');
  const pinnedInMain = states.map((tab) => (tab.pinned ? 'P' : '-')).join('');
  if (pinnedInSidebar !== pinnedInMain) {
    problems.push(`pinned flags differ: sidebar ${pinnedInSidebar}, main ${pinnedInMain}`);
  }
  if (pinnedInMain.includes('-P')) {
    problems.push(`a pinned tab comes after an unpinned one in main: ${pinnedInMain}`);
  }

  const selectedState = states.find((tab) => tab.id === selected);
  const shouldBeAttached =
    selectedState?.page.kind === 'web' &&
    selectedState.runtime !== 'crashed' &&
    selectedState.webContentsId !== null
      ? [selectedState.id]
      : [];
  const attached = states.filter((tab) => tab.attached).map((tab) => tab.id);
  if (attached.join(' ') !== shouldBeAttached.join(' ')) {
    problems.push(
      `attached views are [${attached.join(' ')}] but should be [${shouldBeAttached.join(' ')}]`,
    );
  }

  if (box === null) {
    problems.push('the shell has no #content-area box');
  } else if (!sameRect(rect, { x: box.x, y: box.y, width: box.width, height: box.height })) {
    problems.push(`content rect ${show(rect)} differs from the #content-area box ${show(box)}`);
  }
  for (const tab of states.filter((candidate) => candidate.attached)) {
    if (tab.bounds === null || !sameRect(tab.bounds, rect)) {
      problems.push(
        `tab ${tab.id}: view bounds ${show(tab.bounds)} differ from the content rect ${show(rect)}`,
      );
    }
  }
  return problems;
}

/** Polls until `describeProblems` finds nothing; on failure the problems are in the message. */
export async function expectConsistent(
  app: ElectronApplication,
  shell: Page,
  message = 'the shell, TabManager and the views should agree',
): Promise<void> {
  await expect
    .poll(() => describeProblems(app, shell), { message, timeout: SLOW_TIMEOUT_MS })
    .toEqual([]);
}

// ── M1.3b: find, zoom, fullscreen ───────────────────────────────────────────────────────────────

/** The find bar at the right end of the toolbar; it exists only while the tab's find is open. */
export function findBar(shell: Page): Locator {
  return shell.locator('[data-find-bar]');
}
export function findField(shell: Page): Locator {
  return findBar(shell).getByRole('textbox', { name: 'Find in page', exact: true });
}
/** "2 of 5", "No results", "3 matches" or empty: what the bar says about the search. */
export function findCount(shell: Page): Locator {
  return findBar(shell).locator('[data-find-count]');
}
export function findNextButton(shell: Page): Locator {
  return findBar(shell).getByRole('button', { name: 'Next match', exact: true });
}
export function findPreviousButton(shell: Page): Locator {
  return findBar(shell).getByRole('button', { name: 'Previous match', exact: true });
}
export function findCloseButton(shell: Page): Locator {
  return findBar(shell).getByRole('button', { name: 'Close find bar', exact: true });
}
/** The zoom indicator in the address bar; it exists only while the page is not at 100%. */
export function zoomIndicator(shell: Page): Locator {
  return shell.locator('[data-zoom-indicator]');
}
/** The fullscreen notice's pill, drawn by the shell while main says to. */
export function fullscreenNotice(shell: Page): Locator {
  return shell.locator('[data-fullscreen-notice]');
}
/** The notice's click target: the layer that covers the shell while the notice shows. */
export function fullscreenNoticeLayer(shell: Page): Locator {
  return shell.locator('[data-fullscreen-notice-layer]');
}

/** A tab loaded through the address bar: its id and its web contents id. */
export interface LoadedTab {
  readonly tabId: TabId;
  readonly webContentsId: number;
}

/**
 * `loadInNewTab`, plus the id of the tab's web contents, which is what `sendKey` and the main-side
 * helpers take. The tab is selected and its page has the keyboard (a typed navigation that commits
 * focuses the page).
 */
export async function loadTab(
  app: ElectronApplication,
  shell: Page,
  url: string,
): Promise<LoadedTab> {
  const tabId = await loadInNewTab(app, shell, url);
  const state = await tabState(app, tabId);
  if (state?.webContentsId === null || state?.webContentsId === undefined) {
    throw new Error(`Tab ${tabId} has no web contents after loading ${url}.`);
  }
  return { tabId, webContentsId: state.webContentsId };
}

/** What a text field exposes about its selection (the specs' Node config has no DOM types). */
interface TextFieldElement {
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

/** The start and end of a text field's selection: `[0, length]` means all of it is selected. */
export function fieldSelection(field: Locator): Promise<[number | null, number | null]> {
  return field.evaluate((input: TextFieldElement): [number | null, number | null] => [
    input.selectionStart,
    input.selectionEnd,
  ]);
}

/** What a spec needs of the address bar's `<input>` to take the DOM focus away from it. */
interface BlurrableField {
  blur(): void;
  setSelectionRange(start: number, end: number): void;
}

/**
 * Takes the DOM focus (and the selection) away from the address bar. The shell document keeps
 * `document.activeElement` while main gives the keyboard to a page, so "the address bar is focused"
 * would stay true on its own; a spec that wants to see main move the focus resets it first.
 */
export async function blurAddressBar(shell: Page): Promise<void> {
  await omnibox(shell).evaluate((input: BlurrableField) => {
    input.blur();
    input.setSelectionRange(0, 0);
  });
  await expect(omnibox(shell)).not.toBeFocused();
}

// ── M4.2: the memory palette and the address bar's suggestions ──────────────────────────────────

/** The palette's dialog; it exists only while the palette is open. */
export function palette(shell: Page): Locator {
  return shell.locator('[data-palette]');
}
/** The palette's search field (a combobox). */
export function paletteInput(shell: Page): Locator {
  return shell.getByRole('combobox', { name: 'Search memory', exact: true });
}
export function paletteOptions(shell: Page): Locator {
  return palette(shell).getByRole('option');
}
/** The palette's filters: All, Open, Sleeping, Archived, Today, This week. */
export function paletteFilter(shell: Page, label: string): Locator {
  return palette(shell).getByRole('radio', { name: label, exact: true });
}
/** The sidebar's "Search memory…" entry point. */
export function searchMemoryButton(shell: Page): Locator {
  return shell.locator('[data-search-memory]');
}
/** The address bar's suggestions: the dropdown and its options. */
export function suggestionList(shell: Page): Locator {
  return shell.locator('[data-suggestions]');
}
export function suggestionOptions(shell: Page): Locator {
  return suggestionList(shell).getByRole('option');
}
/** The Archive section's list of rows, and its scroll box. */
export function archiveRows(shell: Page): Locator {
  return shell.locator('[data-row-list="archived"] > li');
}
export function archiveScroller(shell: Page): Locator {
  return shell.locator('[data-archive-scroller]');
}
