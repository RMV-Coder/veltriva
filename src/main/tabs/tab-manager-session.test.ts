// TabManager's session behaviour (M2.2a, ADR-0003 items 6 and 8, spike S2): restoring a saved
// session into an empty manager, restoring a tab lazily when it is selected, and what the session
// store reads back (`sessionTabs`, `closedTabs`). The rest of TabManager is in tab-manager.test.ts.
import { describe, expect, it } from 'vitest';

import type { TabHistory } from '../../core/session/history';
import { MAX_CLOSED_TABS, SESSION_NEW_TAB_URL, TabManager } from './tab-manager';
import type { ClosedTab, SessionTab, TabId, TabRuntime, TabRuntimeEvents } from './tab-manager';

/** A runtime that records what TabManager asked of it (a trimmed copy of tab-manager.test.ts's). */
class FakeRuntime implements TabRuntime {
  shown = false;
  destroyed = false;
  focused = 0;
  readonly loads: string[] = [];
  readonly calls: string[] = [];
  /** Each restore, with whether the view was attached by then (S2: it must be). */
  readonly restores: { history: TabHistory; shownFirst: boolean }[] = [];
  /** What `history()` reports; tests set it as a page would build it. */
  historyValue: TabHistory | null = null;

  constructor(
    readonly tabId: TabId,
    readonly events: TabRuntimeEvents,
    /** `restore()` fails at once, the way a synchronous throw does (S2's creation failure). */
    readonly failRestoreAtOnce: boolean,
  ) {}

  load(url: string): void {
    this.assertAlive();
    this.loads.push(url);
  }
  goBack(): void {
    this.calls.push('back');
  }
  goForward(): void {
    this.calls.push('forward');
  }
  reload(options: { readonly ignoreCache?: boolean } = {}): void {
    this.calls.push(options.ignoreCache === true ? 'reload:ignoreCache' : 'reload');
  }
  stop(): void {
    this.calls.push('stop');
  }
  find(): number {
    return 1;
  }
  stopFind(): void {
    this.calls.push('stopFind');
  }
  zoomFactor(): number {
    return 1;
  }
  setZoomFactor(): void {
    this.calls.push('zoom');
  }
  toggleDevTools(): void {
    this.calls.push('devtools');
  }
  exitFullscreen(): void {
    this.calls.push('exitFullscreen');
  }
  show(): void {
    this.assertAlive();
    this.shown = true;
  }
  hide(): void {
    this.shown = false;
  }
  focus(): void {
    this.focused += 1;
  }
  destroy(): void {
    this.shown = false;
    this.destroyed = true;
  }
  restore(history: TabHistory): void {
    this.assertAlive();
    if (this.loads.length > 0 || this.restores.length > 0) {
      throw new Error(`runtime of ${this.tabId} restored after it loaded (S2 forbids it)`);
    }
    this.restores.push({ history, shownFirst: this.shown });
    if (this.failRestoreAtOnce) {
      this.events.restoreFailed();
    }
  }
  history(): TabHistory | null {
    return this.historyValue;
  }
  // The discard and freeze of M3.1 (tab-manager-model.test.ts covers them): never used here.
  showHidden(): void {
    this.calls.push('showHidden');
  }
  ping(): Promise<unknown> {
    return Promise.reject(new Error('not used in these tests'));
  }
  probe(): Promise<unknown> {
    return Promise.reject(new Error('not used in these tests'));
  }
  snapshot(): null {
    return null;
  }
  closeForDiscard(): Promise<'closed'> {
    return Promise.reject(new Error('not used in these tests'));
  }
  freeze(): Promise<void> {
    return Promise.reject(new Error('not used in these tests'));
  }
  thaw(): void {
    this.calls.push('thaw');
  }
  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`runtime of ${this.tabId} used after destroy()`);
    }
  }
}

function setup(
  options: {
    /** Which runtimes, by order of creation, fail their restore() at once. */
    readonly failRestoreOfRuntimes?: readonly number[];
    /** The ids newId() gives first, before it makes up its own. */
    readonly newIds?: readonly string[];
    /** Pages whose tab keeps no record when it closes (an excluded site, M5.1). */
    readonly keepsNoRecord?: (url: string) => boolean;
  } = {},
) {
  const runtimes: FakeRuntime[] = [];
  const clock = { now: 10_000 };
  const queuedIds = [...(options.newIds ?? [])];
  let changes = 0;
  let nextId = 0;
  const manager = new TabManager({
    createRuntime: (tabId, events) => {
      const runtime = new FakeRuntime(
        tabId,
        events,
        options.failRestoreOfRuntimes?.includes(runtimes.length) ?? false,
      );
      runtimes.push(runtime);
      return runtime;
    },
    newId: () => queuedIds.shift() ?? `new-${String((nextId += 1))}`,
    onChange: () => {
      changes += 1;
    },
    now: () => clock.now,
    ...(options.keepsNoRecord === undefined ? {} : { keepsNoRecord: options.keepsNoRecord }),
  });
  /** Every runtime a tab has had, oldest first. */
  const runtimesOf = (tabId: TabId): FakeRuntime[] =>
    runtimes.filter((runtime) => runtime.tabId === tabId);
  /** The one runtime a tab has now. */
  const runtimeOf = (tabId: TabId): FakeRuntime => {
    const live = runtimesOf(tabId).filter((runtime) => !runtime.destroyed);
    const [runtime] = live;
    if (live.length !== 1 || runtime === undefined) {
      throw new Error(`expected one live runtime for ${tabId}, found ${String(live.length)}`);
    }
    return runtime;
  };
  /** A tab showing a committed web page, as a user's own navigation leaves it. */
  const liveTab = (
    url: string,
    live: { readonly title?: string; readonly history?: TabHistory } = {},
  ): TabId => {
    const id = manager.create();
    manager.navigate(id, url);
    const runtime = runtimeOf(id);
    commit(runtime, url);
    if (live.title !== undefined) {
      runtime.events.titleChanged(live.title);
    }
    runtime.historyValue = live.history ?? null;
    return id;
  };
  return { manager, runtimes, runtimesOf, runtimeOf, liveTab, clock, changes: () => changes };
}

function commit(runtime: FakeRuntime, url: string): void {
  runtime.events.committed({ url, sameDocument: false, canGoBack: false, canGoForward: false });
}

/** A saved tab: two history entries, the second one active. */
function savedTab(id: string, overrides: Partial<SessionTab> = {}): SessionTab {
  const url = `https://${id}.example/`;
  return {
    id,
    pinned: false,
    url,
    title: `Title ${id}`,
    history: {
      index: 1,
      entries: [
        { url: `${url}old`, title: `Old ${id}` },
        { url, title: `Title ${id}` },
      ],
    },
    createdAt: 1000,
    lastUsedAt: 2000,
    // The engagement clock's values (M3.2); without an activity clock, engaged 0 on day 1.
    lastUsedEngaged: 0,
    lastUsedActiveDay: 1,
    // M3.3: placement facts; a tab that never moved shows its creation time.
    userProtected: false,
    placementChangedAt: 1000,
    ...overrides,
  };
}

function closedTab(id: string, overrides: Partial<ClosedTab> = {}): ClosedTab {
  return { ...savedTab(id), closedAt: 3000, index: 0, ...overrides };
}

function session(
  overrides: Partial<Parameters<TabManager['restoreSession']>[0]> = {},
): Parameters<TabManager['restoreSession']>[0] {
  return { tabs: [], selectedTabId: null, closed: [], loadSelected: true, ...overrides };
}

const ids = (manager: TabManager): TabId[] => manager.tabs().map((tab) => tab.id);

/** TabManager's invariants 1 to 4 (the top of tab-manager.ts), for the restore paths. */
function assertInvariants(manager: TabManager, runtimes: readonly FakeRuntime[]): void {
  const tabs = manager.tabs();
  const open = new Set(tabs.map((tab) => tab.id));
  expect(open.size).toBe(tabs.length);
  const firstUnpinned = tabs.findIndex((tab) => !tab.pinned);
  if (firstUnpinned !== -1) {
    expect(tabs.slice(firstUnpinned).every((tab) => !tab.pinned)).toBe(true);
  }
  const selected = manager.selectedTabId();
  if (tabs.length === 0) {
    expect(selected).toBeNull();
  } else {
    expect(open.has(selected ?? '')).toBe(true);
  }
  const shown = runtimes.filter((runtime) => runtime.shown);
  expect(shown.length).toBeLessThanOrEqual(1);
  for (const runtime of shown) {
    expect(runtime.destroyed).toBe(false);
    expect(runtime.tabId).toBe(selected);
    expect(manager.get(runtime.tabId).page.kind).toBe('web');
  }
  for (const runtime of runtimes) {
    if (!open.has(runtime.tabId) && !runtime.destroyed) {
      throw new Error(`the runtime of closed tab ${runtime.tabId} was not destroyed`);
    }
  }
}

describe('TabManager session', () => {
  describe('restoreSession', () => {
    it('puts the tabs back in order with the pinned ones first, all unloaded', () => {
      const { manager, runtimes } = setup();

      manager.restoreSession(
        session({
          tabs: [
            savedTab('a'),
            savedTab('b', { pinned: true }),
            savedTab('c'),
            savedTab('d', { pinned: true }),
          ],
          selectedTabId: 'c',
          loadSelected: false,
        }),
      );

      expect(ids(manager)).toEqual(['b', 'd', 'a', 'c']);
      expect(manager.tabs().map((tab) => tab.pinned)).toEqual([true, true, false, false]);
      expect(manager.tabs().map((tab) => tab.runtime)).toEqual([
        'unloaded',
        'unloaded',
        'unloaded',
        'unloaded',
      ]);
      expect(runtimes).toHaveLength(0);
      assertInvariants(manager, runtimes);
    });

    it('shows each restored tab as a web page with its saved address and title', () => {
      const { manager } = setup();

      manager.restoreSession(session({ tabs: [savedTab('a')], loadSelected: false }));

      expect(manager.get('a')).toMatchObject({
        id: 'a',
        placement: 'strip',
        runtime: 'unloaded',
        page: { kind: 'web' },
        url: 'https://a.example/',
        title: 'Title a',
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
        find: null,
        credentialsRemoved: false,
      });
    });

    it('keeps the order of the saved list within the pinned and the other tabs', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [
            savedTab('p2', { pinned: true }),
            savedTab('x3'),
            savedTab('p1', { pinned: true }),
            savedTab('x1'),
            savedTab('x2'),
          ],
          loadSelected: false,
        }),
      );

      expect(ids(manager)).toEqual(['p2', 'p1', 'x3', 'x1', 'x2']);
    });

    it('selects the saved tab', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({ tabs: [savedTab('a'), savedTab('b'), savedTab('c')], selectedTabId: 'b' }),
      );

      expect(manager.selectedTabId()).toBe('b');
    });

    it('selects the first tab when the saved one is not there, or none was saved', () => {
      for (const selectedTabId of ['gone', null]) {
        const { manager } = setup();

        manager.restoreSession(
          session({
            tabs: [savedTab('a'), savedTab('b', { pinned: true })],
            selectedTabId,
            loadSelected: false,
          }),
        );

        // The first tab in strip order, which puts pinned ones first.
        expect(manager.selectedTabId()).toBe('b');
      }
    });

    it('opens one new-tab page, selected, when the session has no tabs', () => {
      const { manager, runtimes } = setup();

      manager.restoreSession(session({ tabs: [], selectedTabId: 'gone' }));

      expect(manager.tabs()).toHaveLength(1);
      expect(manager.selectedTabId()).toBe(manager.tabs()[0]?.id);
      expect(manager.tabs()[0]).toMatchObject({
        runtime: 'unloaded',
        page: { kind: 'internal', name: 'new-tab' },
        url: '',
      });
      expect(runtimes).toHaveLength(0);
    });

    it('still brings back Recently closed when the session has no open tabs', () => {
      const { manager } = setup();

      manager.restoreSession(session({ tabs: [], closed: [closedTab('c1')] }));

      expect(manager.canReopenClosed()).toBe(true);
    });

    it('calls onChange', () => {
      const { manager, changes } = setup();

      manager.restoreSession(session({ tabs: [savedTab('a')] }));

      expect(changes()).toBeGreaterThan(0);
    });

    it('throws on a manager that already has a tab, and leaves it as it was', () => {
      const { manager } = setup();
      const existing = manager.create();

      expect(() => {
        manager.restoreSession(session({ tabs: [savedTab('a')] }));
      }).toThrow('restoreSession needs an empty TabManager.');

      expect(ids(manager)).toEqual([existing]);
      expect(manager.selectedTabId()).toBe(existing);
    });

    it('accepts a manager that was emptied with closeAll', () => {
      const { manager, runtimes } = setup();
      manager.create();
      manager.closeAll();

      manager.restoreSession(session({ tabs: [savedTab('a')], loadSelected: false }));

      expect(ids(manager)).toEqual(['a']);
      assertInvariants(manager, runtimes);
    });

    describe('a tab id that appears twice', () => {
      it('keeps the first', () => {
        const { manager } = setup();

        manager.restoreSession(
          session({
            tabs: [
              savedTab('a', { title: 'First' }),
              savedTab('b'),
              savedTab('a', { title: 'Second', url: 'https://other.example/' }),
            ],
            loadSelected: false,
          }),
        );

        expect(ids(manager)).toEqual(['a', 'b']);
        expect(manager.get('a')).toMatchObject({ title: 'First', url: 'https://a.example/' });
      });

      it('keeps the pinned copy first, because pinned tabs are put first', () => {
        const { manager } = setup();

        manager.restoreSession(
          session({
            tabs: [
              savedTab('a', { title: 'Not pinned' }),
              savedTab('a', { pinned: true, title: 'Pinned' }),
            ],
            loadSelected: false,
          }),
        );

        expect(manager.tabs()).toHaveLength(1);
        expect(manager.get('a')).toMatchObject({ pinned: true, title: 'Pinned' });
      });
    });
  });

  describe('loading the selected tab at startup', () => {
    it('creates exactly one runtime, for the selected tab, and restores it with its history', () => {
      const { manager, runtimes, runtimeOf } = setup();
      const tabs = [savedTab('a'), savedTab('b'), savedTab('c')];

      manager.restoreSession(session({ tabs, selectedTabId: 'b' }));

      expect(runtimes).toHaveLength(1);
      const runtime = runtimeOf('b');
      expect(runtime.restores).toEqual([{ history: tabs[1]?.history, shownFirst: true }]);
      // S2: never a load before restore().
      expect(runtime.loads).toEqual([]);
      expect(manager.get('b')).toMatchObject({ runtime: 'creating', loading: true });
      expect(manager.get('a').runtime).toBe('unloaded');
      expect(manager.get('c').runtime).toBe('unloaded');
      assertInvariants(manager, runtimes);
    });

    it('attaches the view before restoring into it (S2)', () => {
      const { manager, runtimeOf } = setup();

      manager.restoreSession(session({ tabs: [savedTab('a')], selectedTabId: 'a' }));

      expect(runtimeOf('a').restores[0]?.shownFirst).toBe(true);
      expect(runtimeOf('a').shown).toBe(true);
    });

    it('restores the active entry the history says, not just the last one', () => {
      const { manager, runtimeOf } = setup();
      const history: TabHistory = {
        index: 0,
        entries: [
          { url: 'https://a.example/1', title: 'One' },
          { url: 'https://a.example/2', title: 'Two' },
        ],
      };

      manager.restoreSession(
        session({ tabs: [savedTab('a', { url: 'https://a.example/1', history })] }),
      );

      expect(runtimeOf('a').restores[0]?.history).toEqual(history);
    });

    it('creates no runtime when loadSelected is false (safe mode)', () => {
      const { manager, runtimes } = setup();

      manager.restoreSession(
        session({ tabs: [savedTab('a'), savedTab('b')], selectedTabId: 'a', loadSelected: false }),
      );

      expect(runtimes).toHaveLength(0);
      expect(manager.get('a').runtime).toBe('unloaded');
      assertInvariants(manager, runtimes);
    });

    it('loads the selected tab when it is reloaded after a safe-mode start', () => {
      const { manager, runtimes, runtimeOf } = setup();
      const tabs = [savedTab('a'), savedTab('b')];
      manager.restoreSession(session({ tabs, selectedTabId: 'a', loadSelected: false }));

      manager.reload('a');

      expect(runtimes).toHaveLength(1);
      expect(runtimeOf('a').restores).toEqual([{ history: tabs[0]?.history, shownFirst: true }]);
      expect(runtimeOf('a').calls).toEqual([]);
      expect(manager.get('a').runtime).toBe('creating');
      expect(manager.get('b').runtime).toBe('unloaded');
      assertInvariants(manager, runtimes);
    });

    it('restores a tab only once, however often it is reloaded or reselected', () => {
      const { manager, runtimes } = setup();
      manager.restoreSession(
        session({ tabs: [savedTab('a'), savedTab('b')], selectedTabId: 'a', loadSelected: false }),
      );

      manager.reload('a');
      manager.select('b');
      manager.select('a');
      manager.reload('a');

      expect(runtimes.filter((runtime) => runtime.tabId === 'a')).toHaveLength(1);
      expect(runtimes.flatMap((runtime) => runtime.restores)).toHaveLength(2);
    });

    // Safe mode tells the user: "Select a tab, or press Reload, to load it". The tab that is
    // already selected is a tab the user can pick again.
    describe('selecting the selected tab again after a safe-mode start', () => {
      it('loads it, with its history, attached first', () => {
        const { manager, runtimes, runtimeOf } = setup();
        const tabs = [savedTab('a'), savedTab('b')];
        manager.restoreSession(session({ tabs, selectedTabId: 'a', loadSelected: false }));

        manager.select('a');

        expect(runtimes.filter((runtime) => runtime.tabId === 'a')).toHaveLength(1);
        expect(runtimeOf('a').restores).toEqual([{ history: tabs[0]?.history, shownFirst: true }]);
        expect(manager.get('a').runtime).toBe('creating');
        expect(manager.get('b').runtime).toBe('unloaded');
        assertInvariants(manager, runtimes);
      });

      it('loads it once, however often it is picked', () => {
        const { manager, runtimes } = setup();
        manager.restoreSession(
          session({ tabs: [savedTab('a')], selectedTabId: 'a', loadSelected: false }),
        );

        manager.select('a');
        manager.select('a');
        manager.select('a');

        expect(runtimes).toHaveLength(1);
        expect(runtimes[0]?.restores).toHaveLength(1);
      });

      it('does not count as using the tab: lastUsedAt stays', () => {
        const { manager, clock } = setup();
        manager.restoreSession(
          session({
            tabs: [savedTab('a', { lastUsedAt: 100 })],
            selectedTabId: 'a',
            loadSelected: false,
          }),
        );
        clock.now = 9000;

        manager.select('a');

        expect(manager.sessionTabs()[0]?.lastUsedAt).toBe(100);
      });

      it('does nothing, and reports no change, for a tab that is already loaded', () => {
        const { manager, runtimes, changes } = setup();
        manager.restoreSession(session({ tabs: [savedTab('a')], selectedTabId: 'a' }));
        const before = changes();

        manager.select('a');

        expect(changes()).toBe(before);
        expect(runtimes).toHaveLength(1);
      });

      it('does nothing for a new-tab page', () => {
        const { manager, runtimes, changes } = setup();
        const id = manager.create();
        const before = changes();

        manager.select(id);

        expect(changes()).toBe(before);
        expect(runtimes).toHaveLength(0);
      });
    });
  });

  describe('restoring a tab lazily, when it is selected', () => {
    it('restores another unloaded tab on selection, with its own history, attached first', () => {
      const { manager, runtimes, runtimeOf } = setup();
      const tabs = [savedTab('a'), savedTab('b'), savedTab('c')];
      manager.restoreSession(session({ tabs, selectedTabId: 'a' }));
      expect(runtimes).toHaveLength(1);

      manager.select('c');

      expect(runtimes).toHaveLength(2);
      expect(runtimeOf('c').restores).toEqual([{ history: tabs[2]?.history, shownFirst: true }]);
      expect(runtimeOf('c').loads).toEqual([]);
      expect(manager.get('c').runtime).toBe('creating');
      expect(manager.get('b').runtime).toBe('unloaded');
      // Only the selected tab's view is attached (invariant 3).
      expect(runtimeOf('a').shown).toBe(false);
      expect(runtimeOf('c').shown).toBe(true);
      assertInvariants(manager, runtimes);
    });

    it('does not restore a tab again when the user comes back to it', () => {
      const { manager, runtimes, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [savedTab('a'), savedTab('b')], selectedTabId: 'a' }));
      manager.select('b');

      manager.select('a');

      expect(runtimes).toHaveLength(2);
      expect(runtimeOf('a').restores).toHaveLength(1);
      expect(runtimeOf('a').shown).toBe(true);
      expect(runtimeOf('b').shown).toBe(false);
      assertInvariants(manager, runtimes);
    });

    it('restores on any way of selecting, not only select()', () => {
      const { manager, runtimes } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a'), savedTab('b'), savedTab('c'), savedTab('d')],
          selectedTabId: 'a',
          loadSelected: false,
        }),
      );

      manager.selectRelative(1);
      manager.selectIndex(2);
      manager.selectLast();

      expect(runtimes.map((runtime) => runtime.tabId)).toEqual(['b', 'c', 'd']);
    });

    it('closing the selected unloaded tab selects the next one and restores it', () => {
      const { manager, runtimes, runtimeOf } = setup();
      manager.restoreSession(
        session({ tabs: [savedTab('a'), savedTab('b')], selectedTabId: 'a', loadSelected: false }),
      );

      manager.close('a');

      expect(manager.selectedTabId()).toBe('b');
      expect(runtimeOf('b').restores).toHaveLength(1);
      assertInvariants(manager, runtimes);
    });
  });

  describe('a tab saved without a history', () => {
    it('restores a history of one entry, from its address and title', () => {
      const { manager, runtimeOf } = setup();

      manager.restoreSession(
        session({
          tabs: [savedTab('a', { url: 'https://a.example/page', title: 'Page A', history: null })],
        }),
      );

      expect(runtimeOf('a').restores).toEqual([
        {
          history: { index: 0, entries: [{ url: 'https://a.example/page', title: 'Page A' }] },
          shownFirst: true,
        },
      ]);
    });

    it('cleans that address too: no credentials, no token fragment', () => {
      const { manager, runtimeOf } = setup();

      manager.restoreSession(
        session({
          tabs: [
            savedTab('a', {
              url: 'https://user:pw@a.example/p#access_token=abc',
              title: 'A',
              history: null,
            }),
          ],
        }),
      );

      expect(runtimeOf('a').restores[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://a.example/p', title: 'A' }],
      });
    });
  });

  describe('a tab whose address can not be restored', () => {
    it.each([
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'veltriva://settings',
      'chrome://settings',
      'blob:https://a.example/1',
      'mailto:a@example.com',
      'not a url',
    ])('becomes a new-tab page, with no runtime, for %s', (url) => {
      const { manager, runtimes } = setup();

      manager.restoreSession(
        session({ tabs: [savedTab('a', { url, history: null })], selectedTabId: 'a' }),
      );

      expect(runtimes).toHaveLength(0);
      expect(manager.get('a')).toMatchObject({
        runtime: 'unloaded',
        page: { kind: 'internal', name: 'new-tab' },
        url: '',
        title: '',
      });
      assertInvariants(manager, runtimes);
    });

    it('becomes a new-tab page at restoreSession, whether or not it is selected, not on selection', () => {
      const { manager, runtimes } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a'), savedTab('b', { url: 'about:blank', history: null })],
          selectedTabId: 'a',
        }),
      );

      // Already a new-tab page, before anyone selects it.
      expect(manager.get('b')).toMatchObject({
        runtime: 'unloaded',
        page: { kind: 'internal', name: 'new-tab' },
        url: '',
        title: '',
      });

      manager.select('b');

      expect(runtimes.filter((runtime) => runtime.tabId === 'b')).toHaveLength(0);
      expect(manager.sessionTabs().find((tab) => tab.id === 'b')).toMatchObject({
        url: SESSION_NEW_TAB_URL,
        title: '',
        history: null,
      });
      assertInvariants(manager, runtimes);
    });

    it('is reported as a new-tab page, with its title and history gone, even if it had them', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [
            savedTab('a'),
            savedTab('b', { url: 'javascript:alert(1)', title: 'Click me', history: null }),
          ],
          selectedTabId: 'a',
        }),
      );

      expect(manager.sessionTabs().find((tab) => tab.id === 'b')).toMatchObject({
        url: SESSION_NEW_TAB_URL,
        title: '',
        history: null,
      });
    });

    describe('with a history that has a usable active entry', () => {
      const history: TabHistory = {
        index: 1,
        entries: [
          { url: 'https://a.example/first', title: 'First' },
          { url: 'https://a.example/real', title: 'Real' },
        ],
      };
      const unrestorable = (id: string, url: string) =>
        savedTab(id, { url, title: 'Saved', history });

      it('takes its address from the active entry and is restored from the history', () => {
        const { manager, runtimeOf } = setup();

        manager.restoreSession(session({ tabs: [unrestorable('a', 'about:blank')] }));

        expect(manager.get('a')).toMatchObject({
          page: { kind: 'web' },
          url: 'https://a.example/real',
        });
        expect(runtimeOf('a').restores[0]?.history).toEqual(history);
      });

      it.each(['about:blank', 'javascript:alert(1)', 'data:text/html,x', 'veltriva://settings'])(
        'does so for %s, and never keeps that address',
        (url) => {
          const { manager } = setup();

          manager.restoreSession(session({ tabs: [unrestorable('a', url)], loadSelected: false }));

          expect(manager.get('a').url).toBe('https://a.example/real');
          expect(manager.sessionTabs()[0]).toMatchObject({
            url: 'https://a.example/real',
            history,
          });
        },
      );

      it('does not load the unsafe address into a duplicate of the tab', () => {
        const { manager, runtimes } = setup();
        manager.restoreSession(
          session({
            tabs: [savedTab('a'), unrestorable('b', 'javascript:alert(1)')],
            selectedTabId: 'a',
          }),
        );

        manager.duplicate('b');

        expect(runtimes.flatMap((runtime) => runtime.loads)).toEqual(['https://a.example/real']);
      });
    });
  });

  describe('the address and title of a saved tab are checked, because the file is not trusted', () => {
    it('removes credentials and a token fragment from the address', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [
            savedTab('a', {
              url: 'https://user:pw@a.example/p#access_token=SECRET',
              history: null,
            }),
          ],
          loadSelected: false,
        }),
      );

      expect(manager.get('a').url).toBe('https://a.example/p');
      expect(JSON.stringify(manager.sessionTabs())).not.toMatch(/SECRET|pw@/);
    });

    it('keeps an address that is fine exactly as it was saved', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [savedTab('a', { url: 'https://a.example/p?q=1#part' })],
          loadSelected: false,
        }),
      );

      expect(manager.get('a').url).toBe('https://a.example/p?q=1#part');
    });

    it('removes control and bidi characters from the title, as a page title is cleaned', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [
            savedTab('a', { title: '‮evil‬  title\u0000⁦x⁩​ ' }),
            savedTab('b', { title: 'plain' }),
          ],
          loadSelected: false,
        }),
      );

      expect(manager.get('a').title).toBe('evil  titlex');
      expect(manager.get('b').title).toBe('plain');
      expect(manager.sessionTabs()[0]?.title).toBe('evil  titlex');
    });

    it('cuts a title to 1,024 characters', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({ tabs: [savedTab('a', { title: 'x'.repeat(5000) })], loadSelected: false }),
      );

      expect(manager.get('a').title).toHaveLength(1024);
    });

    it('cleans the title of a tab whose address was not restorable, too', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [
            savedTab('a', {
              url: 'about:blank',
              title: '‮saved\u0007 title',
              history: {
                index: 0,
                entries: [{ url: 'https://a.example/real', title: 'Real' }],
              },
            }),
          ],
          loadSelected: false,
        }),
      );

      expect(manager.get('a')).toMatchObject({
        url: 'https://a.example/real',
        title: 'saved title',
      });
    });

    it('has no title at all for a tab that became a new-tab page', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [savedTab('a', { url: 'about:blank', title: '‮saved', history: null })],
          loadSelected: false,
        }),
      );

      expect(manager.get('a').title).toBe('');
    });

    // reopenClosed() builds its record from the ClosedTab as given, so a saved Recently-closed
    // entry keeps the address and title it came with. They go through the same checks as a tab.
    it('checks the address and title of a closed tab it was given, as it does a tab', () => {
      const { manager } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('x', { url: 'javascript:alert(1)', title: '‮evil' })],
          loadSelected: false,
        }),
      );

      manager.reopenClosed();

      expect(manager.get('x').url).toBe('https://x.example/');
      expect(manager.get('x').title).toBe('evil');
    });

    it('never loads an unrestorable address of a reopened closed tab', () => {
      const { manager, runtimeOf, runtimes } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('x', { url: 'javascript:alert(1)' })],
        }),
      );
      manager.reopenClosed();
      runtimeOf('x').events.restoreFailed();

      expect(runtimes.flatMap((runtime) => runtime.loads)).not.toContain('javascript:alert(1)');
    });
  });

  describe('a new-tab page saved as SESSION_NEW_TAB_URL', () => {
    it('comes back as a new-tab page with no title and no history', () => {
      const { manager, runtimes } = setup();

      manager.restoreSession(
        session({
          tabs: [savedTab('a', { url: SESSION_NEW_TAB_URL, title: 'ignored' })],
          selectedTabId: 'a',
        }),
      );

      expect(runtimes).toHaveLength(0);
      expect(manager.get('a')).toMatchObject({
        runtime: 'unloaded',
        page: { kind: 'internal', name: 'new-tab' },
        url: '',
        title: '',
      });
      expect(manager.sessionTabs()).toEqual([
        expect.objectContaining({ id: 'a', url: SESSION_NEW_TAB_URL, title: '', history: null }),
      ]);
      assertInvariants(manager, runtimes);
    });

    it('loads nothing even when it is the selected tab and loading is on', () => {
      const { manager, runtimes } = setup();

      manager.restoreSession(
        session({
          tabs: [savedTab('a', { url: SESSION_NEW_TAB_URL }), savedTab('b')],
          selectedTabId: 'a',
          loadSelected: true,
        }),
      );

      expect(runtimes).toHaveLength(0);
    });

    it('is not offered again from Recently closed', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('x', { url: SESSION_NEW_TAB_URL })],
        }),
      );

      expect(manager.canReopenClosed()).toBe(false);
    });
  });

  describe('restoreFailed', () => {
    it('gives the tab a new runtime that loads its address, and destroys the old one', () => {
      const { manager, runtimes, runtimesOf, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [savedTab('a')], selectedTabId: 'a' }));
      const first = runtimeOf('a');

      // Reported later, as a rejected restore() is.
      first.events.restoreFailed();

      expect(first.destroyed).toBe(true);
      expect(runtimesOf('a')).toHaveLength(2);
      const second = runtimeOf('a');
      expect(second).not.toBe(first);
      expect(second.loads).toEqual(['https://a.example/']);
      expect(second.restores).toEqual([]);
      expect(manager.get('a')).toMatchObject({ runtime: 'creating', url: 'https://a.example/' });
      assertInvariants(manager, runtimes);
    });

    it('ignores what the replaced runtime reports afterwards', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [savedTab('a')], selectedTabId: 'a' }));
      const first = runtimeOf('a');
      first.events.restoreFailed();

      first.events.titleChanged('From the old runtime');
      first.events.restoreFailed();
      commit(first, 'https://stale.example/');

      expect(manager.get('a')).toMatchObject({ url: 'https://a.example/', title: 'Title a' });
      expect(manager.tabs()).toHaveLength(1);
      expect(runtimeOf('a').loads).toEqual(['https://a.example/']);
    });

    it('goes live when the replacement commits, and reports its history from then on', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [savedTab('a')], selectedTabId: 'a' }));
      runtimeOf('a').events.restoreFailed();
      const second = runtimeOf('a');

      commit(second, 'https://a.example/');
      second.historyValue = {
        index: 0,
        entries: [{ url: 'https://a.example/', title: 'Title a' }],
      };

      expect(manager.get('a')).toMatchObject({ runtime: 'live', page: { kind: 'web' } });
      expect(manager.sessionTabs()[0]?.history).toEqual(second.historyValue);
    });

    it('recovers when restore() fails at once, as a throw does, during startup', () => {
      const { manager, runtimes, runtimesOf, runtimeOf } = setup({ failRestoreOfRuntimes: [0] });

      manager.restoreSession(session({ tabs: [savedTab('a')], selectedTabId: 'a' }));

      expect(runtimesOf('a')).toHaveLength(2);
      expect(runtimes[0]?.destroyed).toBe(true);
      expect(runtimeOf('a').loads).toEqual(['https://a.example/']);
      // The replacement is attached, as the selected tab's view must be.
      expect(runtimeOf('a').shown).toBe(true);
      assertInvariants(manager, runtimes);
    });

    it('recovers when restore() fails at once on a lazy selection', () => {
      const { manager, runtimes, runtimeOf } = setup({ failRestoreOfRuntimes: [1] });
      manager.restoreSession(session({ tabs: [savedTab('a'), savedTab('b')], selectedTabId: 'a' }));

      manager.select('b');

      expect(runtimeOf('b').loads).toEqual(['https://b.example/']);
      expect(runtimeOf('b').shown).toBe(true);
      expect(runtimeOf('a').shown).toBe(false);
      assertInvariants(manager, runtimes);
    });

    it('keeps the replacement hidden while another tab is selected', () => {
      const { manager, runtimes, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [savedTab('a'), savedTab('b')], selectedTabId: 'a' }));
      const first = runtimeOf('a');
      manager.select('b');

      first.events.restoreFailed();

      expect(runtimeOf('a').loads).toEqual(['https://a.example/']);
      expect(runtimeOf('a').shown).toBe(false);
      expect(runtimeOf('b').shown).toBe(true);
      assertInvariants(manager, runtimes);
    });

    // The replacement is created by navigate(), which doesn't attach it; the commit attaches a view
    // only when the tab was showing an internal page, and a restored tab is a 'web' page. So the
    // handler attaches the selected tab's replacement itself, when the failure is reported after
    // restoreSession() returned (a rejected promise, the usual shape).
    it('shows the selected tab replacement, at once and still when it commits', () => {
      const { manager, runtimes, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [savedTab('a')], selectedTabId: 'a' }));
      runtimeOf('a').events.restoreFailed();
      const second = runtimeOf('a');

      expect(manager.selectedTabId()).toBe('a');
      expect(second.shown).toBe(true);
      commit(second, 'https://a.example/');
      expect(second.shown).toBe(true);
      assertInvariants(manager, runtimes);
    });

    it('shows the replacement of a lazily restored tab, at once and when it commits', () => {
      const { manager, runtimes, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [savedTab('a'), savedTab('b')], selectedTabId: 'a' }));
      manager.select('b');
      runtimeOf('b').events.restoreFailed();
      const second = runtimeOf('b');

      expect(second.shown).toBe(true);
      commit(second, 'https://b.example/');

      expect(second.shown).toBe(true);
      expect(runtimeOf('a').shown).toBe(false);
      assertInvariants(manager, runtimes);
    });

    it('loads the active entry of the history when the saved address was not restorable', () => {
      const { manager, runtimeOf, runtimes } = setup();
      manager.restoreSession(
        session({ tabs: [savedTab('a', { url: 'javascript:alert(1)' })], selectedTabId: 'a' }),
      );
      runtimeOf('a').events.restoreFailed();

      expect(runtimes.flatMap((runtime) => runtime.loads)).toEqual(['https://a.example/']);
    });

    it('loses the stack but not the page: the replacement reports one entry until it has more', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [savedTab('a')], selectedTabId: 'a' }));
      runtimeOf('a').events.restoreFailed();

      expect(manager.sessionTabs()[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://a.example/', title: 'Title a' }],
      });
    });
  });

  describe('the saved stack until the first commit', () => {
    const saved = savedTab('a');

    it('is what sessionTabs() reports between restore() and the first commit, if the runtime has no history yet', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [saved], selectedTabId: 'a' }));
      expect(runtimeOf('a').historyValue).toBeNull();

      // A flush before the page commits must not replace the stack with a one-entry one.
      expect(manager.sessionTabs()[0]?.history).toEqual(saved.history);
    });

    it('is what a lazily restored tab reports, too', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(
        session({ tabs: [savedTab('a'), savedTab('b')], selectedTabId: 'a', loadSelected: false }),
      );
      manager.select('b');
      expect(runtimeOf('b').historyValue).toBeNull();

      expect(manager.sessionTabs().find((tab) => tab.id === 'b')?.history).toEqual(
        savedTab('b').history,
      );
    });

    it('is what a safe-mode tab reports after it is loaded by selecting it again', () => {
      const { manager } = setup();
      manager.restoreSession(session({ tabs: [saved], selectedTabId: 'a', loadSelected: false }));
      manager.select('a');

      expect(manager.sessionTabs()[0]?.history).toEqual(saved.history);
    });

    it('gives way to the runtime history as soon as the runtime has one', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [saved], selectedTabId: 'a' }));
      const stack: TabHistory = {
        index: 2,
        entries: [
          { url: 'https://a.example/old', title: 'Old A' },
          { url: 'https://a.example/', title: 'Title a' },
          { url: 'https://a.example/next', title: 'Next' },
        ],
      };

      runtimeOf('a').historyValue = stack;

      expect(manager.sessionTabs()[0]?.history).toEqual(stack);
    });

    it('is dropped by the first commit: with no runtime history then, one entry is reported', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [saved], selectedTabId: 'a' }));

      commit(runtimeOf('a'), 'https://a.example/');

      expect(manager.sessionTabs()[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://a.example/', title: 'Title a' }],
      });
    });

    it('is dropped by a same-document commit as well', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [saved], selectedTabId: 'a' }));

      runtimeOf('a').events.committed({
        url: 'https://a.example/#part',
        sameDocument: true,
        canGoBack: true,
        canGoForward: false,
      });

      expect(manager.sessionTabs()[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://a.example/#part', title: 'Title a' }],
      });
    });

    it('is kept when only the title or loading state changes, which are not commits', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(session({ tabs: [saved], selectedTabId: 'a' }));

      runtimeOf('a').events.titleChanged('Loading...');
      runtimeOf('a').events.loadingChanged(true);
      runtimeOf('a').events.faviconChanged('data:image/png;base64,AAAA');

      expect(manager.sessionTabs()[0]?.history).toEqual(saved.history);
    });

    it('is what a tab closed before its first commit keeps for Recently closed', () => {
      const { manager, clock } = setup();
      manager.restoreSession(
        session({ tabs: [saved, savedTab('b')], selectedTabId: 'a', loadSelected: true }),
      );
      clock.now = 40_000;

      manager.close('a');

      expect(manager.closedTabs()[0]).toMatchObject({
        id: 'a',
        history: saved.history,
        closedAt: 40_000,
      });
    });

    it('is dropped by navigate(): a new address starts a new stack', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(
        session({ tabs: [saved, savedTab('b')], selectedTabId: 'a', loadSelected: false }),
      );

      manager.navigate('a', 'https://new.example/');
      commit(runtimeOf('a'), 'https://new.example/');

      expect(manager.sessionTabs()[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://new.example/', title: 'Title a' }],
      });
      expect(runtimeOf('a').loads).toEqual(['https://new.example/']);
      expect(runtimeOf('a').restores).toEqual([]);
    });

    it('is dropped by showInternal(): a new-tab page has no stack to bring back later', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(
        session({ tabs: [saved, savedTab('b')], selectedTabId: 'a', loadSelected: false }),
      );

      manager.showInternal('a', 'new-tab');
      manager.navigate('a', 'https://new.example/');
      commit(runtimeOf('a'), 'https://new.example/');

      expect(manager.sessionTabs()[0]?.history?.entries.map((entry) => entry.url)).toEqual([
        'https://new.example/',
      ]);
    });
  });

  describe('sessionTabs', () => {
    it('is empty for an empty manager', () => {
      expect(setup().manager.sessionTabs()).toEqual([]);
    });

    it('gives a restored, unloaded tab back as it was saved', () => {
      const { manager } = setup();
      const tabs = [savedTab('a'), savedTab('b', { pinned: true, lastUsedAt: 7777 })];

      manager.restoreSession(session({ tabs, selectedTabId: 'a', loadSelected: false }));

      expect(manager.sessionTabs()).toEqual([tabs[1], tabs[0]]);
    });

    it('gives a tab saved with no history a one-entry history', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [savedTab('a', { history: null })],
          selectedTabId: 'a',
          loadSelected: false,
        }),
      );

      expect(manager.sessionTabs()[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://a.example/', title: 'Title a' }],
      });
    });

    it('gives a live tab the runtime history, sanitized: no token fragments, credentials or bad entries', () => {
      const { manager, liveTab, runtimeOf } = setup();
      const id = liveTab('https://a.example/done', { title: 'Done' });
      runtimeOf(id).historyValue = {
        index: 3,
        entries: [
          { url: 'https://a.example/login', title: 'Login' },
          { url: 'https://a.example/cb#access_token=SECRET&token_type=bearer', title: 'Callback' },
          { url: 'https://user:pass@a.example/page', title: 'Page' },
          { url: 'https://a.example/done', title: 'Done' },
          { url: 'javascript:alert(1)', title: 'Bad' },
        ],
      };

      const [tab] = manager.sessionTabs();

      expect(tab?.history).toEqual({
        index: 3,
        entries: [
          { url: 'https://a.example/login', title: 'Login' },
          // The title of an address it cut goes too: Chromium may have made it from that address.
          { url: 'https://a.example/cb', title: '' },
          { url: 'https://a.example/page', title: '' },
          { url: 'https://a.example/done', title: 'Done' },
        ],
      });
      expect(JSON.stringify(tab)).not.toContain('SECRET');
    });

    it('reads the runtime again each time, so it follows the page', () => {
      const { manager, liveTab, runtimeOf } = setup();
      const id = liveTab('https://a.example/1');
      runtimeOf(id).historyValue = {
        index: 0,
        entries: [{ url: 'https://a.example/1', title: '1' }],
      };
      expect(manager.sessionTabs()[0]?.history?.entries).toHaveLength(1);

      runtimeOf(id).historyValue = {
        index: 1,
        entries: [
          { url: 'https://a.example/1', title: '1' },
          { url: 'https://a.example/2', title: '2' },
        ],
      };

      expect(manager.sessionTabs()[0]?.history).toMatchObject({ index: 1 });
      expect(manager.sessionTabs()[0]?.history?.entries).toHaveLength(2);
    });

    it('falls back to the tab address when a live runtime reports no history', () => {
      const { manager, liveTab } = setup();
      liveTab('https://a.example/p', { title: 'P' });

      expect(manager.sessionTabs()[0]).toMatchObject({
        url: 'https://a.example/p',
        title: 'P',
        history: { index: 0, entries: [{ url: 'https://a.example/p', title: 'P' }] },
      });
    });

    it('falls back too when everything in the runtime history is unusable', () => {
      const { manager, liveTab, runtimeOf } = setup();
      const id = liveTab('https://a.example/p', { title: 'P' });
      runtimeOf(id).historyValue = {
        index: 0,
        entries: [{ url: 'about:blank', title: '' }],
      };

      expect(manager.sessionTabs()[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://a.example/p', title: 'P' }],
      });
    });

    it('reports a new-tab page as SESSION_NEW_TAB_URL, with no title and no history', () => {
      const { manager } = setup();
      const id = manager.create();

      expect(manager.sessionTabs()).toEqual([
        {
          id,
          pinned: false,
          url: SESSION_NEW_TAB_URL,
          title: '',
          history: null,
          createdAt: 10_000,
          lastUsedAt: 10_000,
          lastUsedEngaged: 0,
          lastUsedActiveDay: 1,
          userProtected: false,
          placementChangedAt: 10_000,
        },
      ]);
    });

    it('reports a tab that went back to a new-tab page as one', () => {
      const { manager, liveTab } = setup();
      const id = liveTab('https://a.example/p', { title: 'P' });

      manager.showInternal(id, 'new-tab');

      expect(manager.sessionTabs()[0]).toMatchObject({
        url: SESSION_NEW_TAB_URL,
        title: '',
        history: null,
      });
    });

    it('lists tabs in strip order with their pinned flag', () => {
      const { manager, liveTab } = setup();
      const a = liveTab('https://a.example/');
      const b = liveTab('https://b.example/');
      manager.setPinned(b, true);

      expect(manager.sessionTabs().map((tab) => [tab.id, tab.pinned])).toEqual([
        [b, true],
        [a, false],
      ]);
    });

    it('carries createdAt and lastUsedAt from the injected clock', () => {
      const { manager, clock } = setup();
      clock.now = 1234;
      const id = manager.create();

      expect(manager.sessionTabs()[0]).toMatchObject({ id, createdAt: 1234, lastUsedAt: 1234 });
    });
  });

  describe('lastUsedAt', () => {
    it('moves to now when a tab is selected, and when it is left (in use until then, M3.2)', () => {
      const { manager, clock } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a', { lastUsedAt: 100 }), savedTab('b', { lastUsedAt: 200 })],
          selectedTabId: 'a',
          loadSelected: false,
        }),
      );
      clock.now = 5000;

      manager.select('b');

      expect(manager.sessionTabs().map((tab) => [tab.id, tab.lastUsedAt])).toEqual([
        ['a', 5000],
        ['b', 5000],
      ]);
    });

    it('does not move for a tab that was already selected, or for a restore itself', () => {
      const { manager, clock } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a', { lastUsedAt: 100 })],
          selectedTabId: 'a',
          loadSelected: true,
        }),
      );
      clock.now = 5000;

      manager.select('a');

      expect(manager.sessionTabs()[0]?.lastUsedAt).toBe(100);
    });

    it('moves for selection by position, and when a closed tab takes the selection', () => {
      const { manager, clock } = setup();
      manager.restoreSession(
        session({
          tabs: [
            savedTab('a', { lastUsedAt: 100 }),
            savedTab('b', { lastUsedAt: 200 }),
            savedTab('c', { lastUsedAt: 300 }),
          ],
          selectedTabId: 'a',
          loadSelected: false,
        }),
      );
      clock.now = 6000;
      manager.selectIndex(1);
      clock.now = 7000;
      manager.close('b');

      // `c` took the place of `b` and was selected; `a` was in use until `b` was selected.
      expect(manager.selectedTabId()).toBe('c');
      expect(manager.sessionTabs().map((tab) => [tab.id, tab.lastUsedAt])).toEqual([
        ['a', 6000],
        ['c', 7000],
      ]);
    });

    it('is set to now when a closed tab is reopened, and createdAt stays', () => {
      const { manager, clock } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('x', { createdAt: 50, lastUsedAt: 60 })],
          loadSelected: false,
        }),
      );
      clock.now = 9000;

      manager.reopenClosed();

      expect(manager.sessionTabs().find((tab) => tab.id === 'x')).toMatchObject({
        createdAt: 50,
        lastUsedAt: 9000,
      });
    });
  });

  describe('closedTabs', () => {
    it('is empty before anything closes', () => {
      const { manager, liveTab } = setup();
      liveTab('https://a.example/');

      expect(manager.closedTabs()).toEqual([]);
    });

    it('lists the newest first, each with when it closed and where it was', () => {
      const { manager, runtimeOf, liveTab, clock } = setup();
      const a = liveTab('https://a.example/', { title: 'A' });
      const b = liveTab('https://b.example/', { title: 'B' });
      liveTab('https://c.example/', { title: 'C' });
      const historyOfB: TabHistory = {
        index: 1,
        entries: [
          { url: 'https://b.example/old', title: 'Old B' },
          { url: 'https://b.example/', title: 'B' },
        ],
      };
      runtimeOf(b).historyValue = historyOfB;

      clock.now = 20_000;
      manager.close(b);
      clock.now = 30_000;
      manager.close(a);

      const closed = manager.closedTabs();
      expect(closed.map((tab) => [tab.id, tab.closedAt, tab.index])).toEqual([
        [a, 30_000, 0],
        [b, 20_000, 1],
      ]);
      expect(closed[1]).toMatchObject({
        url: 'https://b.example/',
        title: 'B',
        pinned: false,
        history: historyOfB,
        createdAt: 10_000,
      });
    });

    it('keeps whether the tab was pinned', () => {
      const { manager, liveTab } = setup();
      const a = liveTab('https://a.example/');
      liveTab('https://b.example/');
      manager.setPinned(a, true);

      manager.close(a);

      expect(manager.closedTabs()[0]).toMatchObject({ id: a, pinned: true, index: 0 });
    });

    it('does not list a new-tab page', () => {
      const { manager } = setup();
      manager.create();
      manager.close(manager.create());

      expect(manager.closedTabs()).toEqual([]);
    });

    it('does not list a tab whose site keeps no record, and still lists the others (M5.1)', () => {
      const { manager, liveTab } = setup({
        keepsNoRecord: (url) => new URL(url).hostname === 'bank.example',
      });
      const bank = liveTab('https://bank.example/account');
      const other = liveTab('https://a.example/');
      liveTab('https://b.example/');

      manager.close(bank);
      manager.close(other);

      expect(manager.closedTabs().map((tab) => tab.id)).toEqual([other]);
      expect(manager.canReopenClosed()).toBe(true);
      manager.reopenClosed();
      expect(manager.canReopenClosed()).toBe(false);
    });

    it('keeps the newest 100, newest first', () => {
      const { manager, liveTab } = setup();
      const closedIds: TabId[] = [];
      for (let n = 0; n < MAX_CLOSED_TABS + 5; n += 1) {
        const id = liveTab(`https://site${String(n)}.example/`);
        closedIds.push(id);
        manager.close(id);
      }

      const closed = manager.closedTabs();

      expect(closed).toHaveLength(MAX_CLOSED_TABS);
      expect(closed[0]?.id).toBe(closedIds.at(-1));
      expect(closed.at(-1)?.id).toBe(closedIds[5]);
    });

    it('hands out a copy', () => {
      const { manager, liveTab } = setup();
      manager.close(liveTab('https://a.example/'));

      (manager.closedTabs() as ClosedTab[]).length = 0;

      expect(manager.closedTabs()).toHaveLength(1);
      expect(manager.canReopenClosed()).toBe(true);
    });

    it('lists a tab that was restored closed, newest first, exactly as given', () => {
      const { manager } = setup();
      const closed = [
        closedTab('n', { closedAt: 9000, index: 2 }),
        closedTab('o', { closedAt: 8000, index: 0 }),
      ];

      manager.restoreSession(session({ tabs: [savedTab('a')], closed, loadSelected: false }));

      expect(manager.closedTabs()).toEqual(closed);
    });
  });

  describe('closing a restored tab that was never loaded', () => {
    it('keeps its pending history for Recently closed', () => {
      const { manager, clock } = setup();
      const tabs = [savedTab('a'), savedTab('b', { pinned: false, lastUsedAt: 4321 })];
      manager.restoreSession(session({ tabs, selectedTabId: 'a', loadSelected: false }));
      clock.now = 50_000;

      manager.close('b');

      expect(manager.closedTabs()).toEqual([{ ...tabs[1], closedAt: 50_000, index: 1 }]);
    });

    it('keeps it for the selected tab too', () => {
      const { manager, runtimes } = setup();
      const tabs = [savedTab('a'), savedTab('b')];
      manager.restoreSession(session({ tabs, selectedTabId: 'a', loadSelected: false }));

      manager.close('a');

      expect(manager.closedTabs()[0]).toMatchObject({ id: 'a', history: tabs[0]?.history });
      assertInvariants(manager, runtimes);
    });

    it('keeps a one-entry history for a tab that was saved with only an address', () => {
      const { manager } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a'), savedTab('b', { history: null })],
          selectedTabId: 'a',
          loadSelected: false,
        }),
      );

      manager.close('b');

      expect(manager.closedTabs()[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://b.example/', title: 'Title b' }],
      });
    });

    it('reopens with that history, restored when it is selected', () => {
      const { manager, runtimeOf, runtimes } = setup();
      const tabs = [savedTab('a'), savedTab('b')];
      manager.restoreSession(session({ tabs, selectedTabId: 'a', loadSelected: false }));
      manager.close('b');

      const reopened = manager.reopenClosed();

      expect(reopened).toBe('b');
      expect(runtimeOf('b').restores).toEqual([{ history: tabs[1]?.history, shownFirst: true }]);
      assertInvariants(manager, runtimes);
    });
  });

  describe('reopenClosed after restoreSession', () => {
    it('reopens a closed tab with its own id and its history, where it was', () => {
      const { manager, runtimes, runtimeOf } = setup();
      const history: TabHistory = {
        index: 2,
        entries: [
          { url: 'https://x.example/1', title: 'One' },
          { url: 'https://x.example/2', title: 'Two' },
          { url: 'https://x.example/3', title: 'Three' },
        ],
      };
      manager.restoreSession(
        session({
          tabs: [savedTab('a'), savedTab('b'), savedTab('c')],
          closed: [closedTab('x', { url: 'https://x.example/3', history, index: 1 })],
          selectedTabId: 'a',
        }),
      );

      const reopened = manager.reopenClosed();

      expect(reopened).toBe('x');
      expect(ids(manager)).toEqual(['a', 'x', 'b', 'c']);
      expect(manager.selectedTabId()).toBe('x');
      expect(runtimeOf('x').restores).toEqual([{ history, shownFirst: true }]);
      expect(runtimeOf('x').loads).toEqual([]);
      expect(runtimeOf('a').shown).toBe(false);
      expect(manager.canReopenClosed()).toBe(false);
      assertInvariants(manager, runtimes);
    });

    it('reopens them newest first', () => {
      const { manager } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('new'), closedTab('mid'), closedTab('old')],
          loadSelected: false,
        }),
      );

      expect([manager.reopenClosed(), manager.reopenClosed(), manager.reopenClosed()]).toEqual([
        'new',
        'mid',
        'old',
      ]);
      expect(manager.reopenClosed()).toBeNull();
    });

    it('puts a tab loaded from the database, which has no strip position, first among the unpinned', () => {
      const { manager } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('p', { pinned: true }), savedTab('a'), savedTab('b')],
          closed: [closedTab('x', { index: 0 })],
          loadSelected: false,
        }),
      );

      manager.reopenClosed();

      expect(ids(manager)).toEqual(['p', 'x', 'a', 'b']);
    });

    it('keeps a reopened tab inside its own section, pinned or not', () => {
      const { manager } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('p', { pinned: true }), savedTab('a')],
          closed: [
            closedTab('late', { index: 99 }),
            closedTab('pin', { pinned: true, index: 99 }),
            closedTab('early', { index: 0 }),
          ],
          loadSelected: false,
        }),
      );

      manager.reopenClosed();
      manager.reopenClosed();
      manager.reopenClosed();

      // 'late' (99) goes to the end of the unpinned tabs, 'pin' to the end of the pinned ones, and
      // 'early' (0) to the start of the unpinned ones: never across the boundary.
      expect(ids(manager)).toEqual(['p', 'pin', 'early', 'a', 'late']);
      expect(manager.tabs().map((tab) => tab.pinned)).toEqual([true, true, false, false, false]);
    });

    it('reopens a tab that was saved with only an address with a one-entry history', () => {
      const { manager, runtimeOf } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('x', { url: 'https://x.example/page', title: 'X', history: null })],
        }),
      );

      manager.reopenClosed();

      expect(runtimeOf('x').restores[0]?.history).toEqual({
        index: 0,
        entries: [{ url: 'https://x.example/page', title: 'X' }],
      });
    });

    it('drops a closed tab whose address can not be restored: there is nothing to reopen', () => {
      const { manager, runtimes } = setup();
      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('x', { url: 'about:blank', history: null })],
        }),
      );

      expect(manager.closedTabs()).toEqual([]);
      expect(manager.reopenClosed()).toBeNull();
      expect(runtimes.filter((runtime) => runtime.tabId === 'x')).toHaveLength(0);
      assertInvariants(manager, runtimes);
    });

    it('does not offer a closed tab that has the id of an open tab', () => {
      const { manager } = setup();

      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('a', { title: 'Same id' }), closedTab('x')],
          loadSelected: false,
        }),
      );

      expect(manager.closedTabs().map((tab) => tab.id)).toEqual(['x']);
    });

    it('keeps only the newest 100 of a longer list', () => {
      const { manager } = setup();
      const closed = Array.from({ length: MAX_CLOSED_TABS + 5 }, (_, n) =>
        closedTab(`closed-${String(n)}`, { closedAt: 100_000 - n }),
      );

      manager.restoreSession(session({ tabs: [savedTab('a')], closed, loadSelected: false }));

      const reopened: (TabId | null)[] = [];
      for (let n = 0; n < MAX_CLOSED_TABS + 1; n += 1) {
        reopened.push(manager.reopenClosed());
      }
      expect(reopened.slice(0, MAX_CLOSED_TABS)).toEqual(
        closed.slice(0, MAX_CLOSED_TABS).map((tab) => tab.id),
      );
      expect(reopened.at(-1)).toBeNull();
    });

    it('gives a new id to a tab whose id is in use by then', () => {
      // A new tab that happens to be given the id of a closed one.
      const { manager } = setup({ newIds: ['x', 'fresh'] });
      manager.restoreSession(
        session({
          tabs: [savedTab('a')],
          closed: [closedTab('x', { url: 'https://closed.example/', index: 9 })],
          loadSelected: false,
        }),
      );
      const taken = manager.create();
      expect(taken).toBe('x');

      const reopened = manager.reopenClosed();

      expect(reopened).toBe('fresh');
      expect(ids(manager)).toEqual(['a', 'x', 'fresh']);
      expect(manager.get('fresh').url).toBe('https://closed.example/');
      expect(manager.get('x').url).toBe('');
    });
  });

  describe('invariants across a whole session', () => {
    it('hold through restore, lazy restores, closes, reopens and a failed restore', () => {
      const { manager, runtimes, runtimeOf } = setup();
      manager.restoreSession(
        session({
          tabs: [
            savedTab('a'),
            savedTab('b', { pinned: true }),
            savedTab('c'),
            savedTab('d', { url: SESSION_NEW_TAB_URL }),
          ],
          closed: [closedTab('x', { index: 1 }), closedTab('y', { index: 0 })],
          selectedTabId: 'c',
        }),
      );
      assertInvariants(manager, runtimes);
      manager.select('a');
      assertInvariants(manager, runtimes);
      manager.select('d');
      assertInvariants(manager, runtimes);
      manager.select('b');
      runtimeOf('b').events.restoreFailed();
      assertInvariants(manager, runtimes);
      manager.close('b');
      assertInvariants(manager, runtimes);
      manager.reopenClosed();
      assertInvariants(manager, runtimes);
      manager.reopenClosed();
      assertInvariants(manager, runtimes);
      manager.closeAll();
      assertInvariants(manager, runtimes);

      expect(manager.tabs()).toEqual([]);
      expect(runtimes.every((runtime) => runtime.destroyed)).toBe(true);
    });
  });
});
