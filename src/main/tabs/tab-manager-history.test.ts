// What TabManager tells the memory (M2.2b): the `history` observer's calls, and above all how the
// user got to each commit. The rest of TabManager is in tab-manager.test.ts and
// tab-manager-session.test.ts.
import { describe, expect, it, vi } from 'vitest';

import type { TabHistory } from '../../core/session/history';
import { VISIT_TRANSITIONS } from '../../core/search/frecency';
import type { VisitTransition } from '../../core/search/frecency';
import { sanitizeTitle, TabManager } from './tab-manager';
import type {
  SessionTab,
  TabHistoryObserver,
  TabId,
  TabRuntime,
  TabRuntimeEvents,
} from './tab-manager';

/** A runtime that records what TabManager asked of it (a trimmed copy of the others’). */
class FakeRuntime implements TabRuntime {
  shown = false;
  destroyed = false;
  focused = 0;
  readonly loads: string[] = [];
  readonly calls: string[] = [];
  readonly restores: TabHistory[] = [];

  constructor(
    readonly tabId: TabId,
    readonly events: TabRuntimeEvents,
  ) {}

  load(url: string): void {
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
    this.restores.push(history);
  }
  history(): TabHistory | null {
    return null;
  }
  // The discard and freeze of M3.1 (tab-manager-model.test.ts covers them): never used here.
  showHidden(): void {
    this.calls.push('showHidden');
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
}

/** An item of a list that must have one there. */
function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) {
    throw new Error(`expected an item at ${String(index)}`);
  }
  return item;
}

function setup() {
  const runtimes: FakeRuntime[] = [];
  const history = {
    committed: vi.fn<TabHistoryObserver['committed']>(),
    titleChanged: vi.fn<TabHistoryObserver['titleChanged']>(),
    faviconChanged: vi.fn<TabHistoryObserver['faviconChanged']>(),
    closed: vi.fn<TabHistoryObserver['closed']>(),
  };
  let nextId = 0;
  const manager = new TabManager({
    createRuntime: (tabId, events) => {
      const runtime = new FakeRuntime(tabId, events);
      runtimes.push(runtime);
      return runtime;
    },
    newId: () => `tab-${String((nextId += 1))}`,
    onChange: () => undefined,
    history,
  });
  /** The one runtime of a tab that is not destroyed. */
  const runtimeOf = (tabId: TabId): FakeRuntime => {
    const live = runtimes.filter((runtime) => runtime.tabId === tabId && !runtime.destroyed);
    const [runtime] = live;
    if (live.length !== 1 || runtime === undefined) {
      throw new Error(`expected one live runtime for ${tabId}, found ${String(live.length)}`);
    }
    return runtime;
  };
  /** The transitions of the commits reported so far, for one tab. */
  const transitions = (tabId: TabId): VisitTransition[] =>
    history.committed.mock.calls
      .filter(([id]) => id === tabId)
      .map(([, commit]) => commit.transition);
  return { manager, runtimes, runtimeOf, history, transitions };
}

function commit(
  runtime: FakeRuntime,
  url: string,
  options: { sameDocument?: boolean; canGoBack?: boolean; canGoForward?: boolean } = {},
): void {
  runtime.events.committed({
    url,
    sameDocument: options.sameDocument ?? false,
    canGoBack: options.canGoBack ?? false,
    canGoForward: options.canGoForward ?? false,
  });
}

function savedTab(id: string): SessionTab {
  const url = `https://${id}.example/`;
  return {
    id,
    pinned: false,
    url,
    title: `Title ${id}`,
    history: { index: 0, entries: [{ url, title: `Title ${id}` }] },
    createdAt: 1000,
    lastUsedAt: 2000,
  };
}

function restoredSession(...ids: string[]): Parameters<TabManager['restoreSession']>[0] {
  return { tabs: ids.map(savedTab), selectedTabId: ids[0] ?? null, closed: [], loadSelected: true };
}

describe('TabManager history observer: how the user got to a commit', () => {
  it('is a link when the navigation says nothing', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();

    manager.navigate(id, 'https://example.com/');
    commit(runtimeOf(id), 'https://example.com/');

    expect(transitions(id)).toEqual(['link']);
  });

  it.each(VISIT_TRANSITIONS)('is %s when the navigation says so', (transition) => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();

    manager.navigate(id, 'https://example.com/', { transition });
    commit(runtimeOf(id), 'https://example.com/');

    expect(transitions(id)).toEqual([transition]);
  });

  it('is typed for an address from the address bar, and generated for its search', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();

    manager.navigate(id, 'https://example.com/', { transition: 'typed' });
    commit(runtimeOf(id), 'https://example.com/');
    manager.navigate(id, 'https://search.example/?q=x', { transition: 'generated' });
    commit(runtimeOf(id), 'https://search.example/?q=x');

    expect(transitions(id)).toEqual(['typed', 'generated']);
  });

  it('is a link for a commit nobody asked for: a click, a form, or the page’s own script', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://example.com/');
    commit(runtimeOf(id), 'https://example.com/');

    commit(runtimeOf(id), 'https://example.com/next');
    commit(runtimeOf(id), 'https://example.com/more', { sameDocument: true });

    expect(transitions(id)).toEqual(['link', 'link', 'link']);
  });

  it('is used by one commit: a redirect that follows it is a link', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();

    manager.navigate(id, 'https://example.com/', { transition: 'typed' });
    commit(runtimeOf(id), 'https://example.com/');
    commit(runtimeOf(id), 'https://www.example.com/');
    commit(runtimeOf(id), 'https://www.example.com/home');

    expect(transitions(id)).toEqual(['typed', 'link', 'link']);
  });

  it('is used by a same-document commit as well, which is a commit', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://app.example/', { transition: 'typed' });

    commit(runtimeOf(id), 'https://app.example/#route', { sameDocument: true });
    commit(runtimeOf(id), 'https://app.example/next', { sameDocument: true });

    expect(transitions(id)).toEqual(['typed', 'link']);
  });

  it('is the latest one asked for: a second navigation replaces the first', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();

    manager.navigate(id, 'https://one.example/', { transition: 'typed' });
    manager.navigate(id, 'https://two.example/', { transition: 'generated' });
    commit(runtimeOf(id), 'https://two.example/');

    expect(transitions(id)).toEqual(['generated']);
  });

  it('is a link again when a navigation with none follows one that had one', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();

    manager.navigate(id, 'https://one.example/', { transition: 'typed' });
    manager.navigate(id, 'https://two.example/');
    commit(runtimeOf(id), 'https://two.example/');

    expect(transitions(id)).toEqual(['link']);
  });

  it('is kept apart for each tab', () => {
    const { manager, runtimeOf, transitions } = setup();
    const a = manager.create();
    const b = manager.create();

    manager.navigate(a, 'https://a.example/', { transition: 'typed' });
    manager.navigate(b, 'https://b.example/', { transition: 'generated' });
    commit(runtimeOf(b), 'https://b.example/');
    commit(runtimeOf(a), 'https://a.example/');

    expect(transitions(a)).toEqual(['typed']);
    expect(transitions(b)).toEqual(['generated']);
  });

  it('is forgotten when the load fails: the next commit has nothing to do with it', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://down.example/', { transition: 'typed' });

    runtimeOf(id).events.loadFailed({
      code: -105,
      name: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://down.example/',
    });
    commit(runtimeOf(id), 'https://up.example/');

    expect(transitions(id)).toEqual(['link']);
  });

  // Regression (found by E2E): a typed address that turned into a download commits nothing and
  // fails nothing; its `typed` stayed for the next commit, a link click.
  it('is forgotten when loading stops without a commit', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://example.com/file.zip', { transition: 'typed' });

    runtimeOf(id).events.loadingChanged(true);
    runtimeOf(id).events.loadingChanged(false);
    commit(runtimeOf(id), 'https://example.com/next');

    expect(transitions(id)).toEqual(['link']);
  });

  it('is kept while the load it belongs to is still going', () => {
    const { manager, runtimeOf, transitions } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://example.com/', { transition: 'typed' });

    runtimeOf(id).events.loadingChanged(true);
    commit(runtimeOf(id), 'https://example.com/');
    runtimeOf(id).events.loadingChanged(false);

    expect(transitions(id)).toEqual(['typed']);
  });

  it('is not reported for a load that failed: there is no commit', () => {
    const { manager, runtimeOf, history } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://down.example/', { transition: 'typed' });

    runtimeOf(id).events.loadFailed({
      code: -105,
      name: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://down.example/',
    });

    expect(history.committed).not.toHaveBeenCalled();
  });

  describe('back, forward and reload', () => {
    it('is back_forward for the commit that follows going back', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://example.com/one');
      commit(runtimeOf(id), 'https://example.com/one');
      commit(runtimeOf(id), 'https://example.com/two', { canGoBack: true });

      manager.goBack(id);
      commit(runtimeOf(id), 'https://example.com/one', { canGoForward: true });

      expect(runtimeOf(id).calls).toEqual(['back']);
      expect(transitions(id)).toEqual(['link', 'link', 'back_forward']);
    });

    it('is back_forward for the commit that follows going forward', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://example.com/one');
      commit(runtimeOf(id), 'https://example.com/one', { canGoForward: true });

      manager.goForward(id);
      commit(runtimeOf(id), 'https://example.com/two', { canGoBack: true });

      expect(runtimeOf(id).calls).toEqual(['forward']);
      expect(transitions(id)).toEqual(['link', 'back_forward']);
    });

    it('is back_forward for a same-document commit too, as a single-page app goes back', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://app.example/a');
      commit(runtimeOf(id), 'https://app.example/a');
      commit(runtimeOf(id), 'https://app.example/b', { sameDocument: true, canGoBack: true });

      manager.goBack(id);
      commit(runtimeOf(id), 'https://app.example/a', { sameDocument: true, canGoForward: true });

      expect(transitions(id)).toEqual(['link', 'link', 'back_forward']);
    });

    it('is not changed by going back when there is nowhere to go', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://example.com/', { transition: 'typed' });

      manager.goBack(id);
      manager.goForward(id);
      commit(runtimeOf(id), 'https://example.com/');

      expect(runtimeOf(id).calls).toEqual([]);
      expect(transitions(id)).toEqual(['typed']);
    });

    it('is used by one commit: what follows going back is a link again', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://example.com/one');
      commit(runtimeOf(id), 'https://example.com/one', { canGoBack: true });

      manager.goBack(id);
      commit(runtimeOf(id), 'https://example.com/zero', { canGoForward: true });
      commit(runtimeOf(id), 'https://example.com/zero/next');

      expect(transitions(id)).toEqual(['link', 'back_forward', 'link']);
    });

    it('is reload for the commit that follows a reload', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://example.com/');
      commit(runtimeOf(id), 'https://example.com/');

      manager.reload(id);
      commit(runtimeOf(id), 'https://example.com/');

      expect(runtimeOf(id).calls).toEqual(['reload']);
      expect(transitions(id)).toEqual(['link', 'reload']);
    });

    it('is reload for a reload that ignores the cache, too', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://example.com/');
      commit(runtimeOf(id), 'https://example.com/');

      manager.reload(id, { ignoreCache: true });
      commit(runtimeOf(id), 'https://example.com/');

      expect(runtimeOf(id).calls).toEqual(['reload:ignoreCache']);
      expect(transitions(id)).toEqual(['link', 'reload']);
    });

    it('is reload for the retry of a page that failed to load', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://down.example/', { transition: 'typed' });
      runtimeOf(id).events.loadFailed({
        code: -105,
        name: 'ERR_NAME_NOT_RESOLVED',
        url: 'https://down.example/',
      });

      manager.reload(id);
      commit(runtimeOf(id), 'https://down.example/');

      expect(transitions(id)).toEqual(['reload']);
    });

    it('is reload for the new renderer a crashed tab gets', () => {
      const { manager, runtimeOf, transitions } = setup();
      const id = manager.create();
      manager.navigate(id, 'https://example.com/');
      commit(runtimeOf(id), 'https://example.com/');
      runtimeOf(id).events.crashed({ code: 11, name: 'crashed' });

      manager.reload(id);
      commit(runtimeOf(id), 'https://example.com/');

      expect(transitions(id)).toEqual(['link', 'reload']);
    });
  });

  describe('restoring a tab', () => {
    it('is restore for the selected tab loaded at startup', () => {
      const { manager, runtimeOf, transitions } = setup();
      manager.restoreSession(restoredSession('a'));

      commit(runtimeOf('a'), 'https://a.example/');

      expect(runtimeOf('a').restores).toHaveLength(1);
      expect(transitions('a')).toEqual(['restore']);
    });

    it('is restore for an unloaded tab that the user selects', () => {
      const { manager, runtimeOf, transitions } = setup();
      manager.restoreSession(restoredSession('a', 'b'));
      commit(runtimeOf('a'), 'https://a.example/');

      manager.select('b');
      commit(runtimeOf('b'), 'https://b.example/');

      expect(runtimeOf('b').restores).toHaveLength(1);
      expect(transitions('b')).toEqual(['restore']);
    });

    it('is restore for an unloaded tab that is reloaded, which loads it', () => {
      const { manager, runtimeOf, transitions } = setup();
      manager.restoreSession({ ...restoredSession('a'), loadSelected: false });

      manager.reload('a');
      commit(runtimeOf('a'), 'https://a.example/');

      expect(transitions('a')).toEqual(['restore']);
    });

    it('is restore only for the first commit, and a link after it', () => {
      const { manager, runtimeOf, transitions } = setup();
      manager.restoreSession(restoredSession('a'));

      commit(runtimeOf('a'), 'https://a.example/');
      commit(runtimeOf('a'), 'https://a.example/next');

      expect(transitions('a')).toEqual(['restore', 'link']);
    });

    it('is not reported for a tab that stays unloaded', () => {
      const { manager, history } = setup();

      manager.restoreSession({ ...restoredSession('a', 'b'), loadSelected: false });

      expect(history.committed).not.toHaveBeenCalled();
    });

    it('is restore for the address alone that a failed restore falls back to', () => {
      const { manager, runtimeOf, transitions } = setup();
      manager.restoreSession(restoredSession('a'));
      const first = runtimeOf('a');

      first.events.restoreFailed();
      const second = runtimeOf('a');
      commit(second, 'https://a.example/');

      expect(second.loads).toEqual(['https://a.example/']);
      expect(transitions('a')).toEqual(['restore']);
    });

    it('is restore for a fallback on a tab selected lazily', () => {
      const { manager, runtimeOf, transitions } = setup();
      manager.restoreSession(restoredSession('a', 'b'));
      manager.select('b');

      runtimeOf('b').events.restoreFailed();
      commit(runtimeOf('b'), 'https://b.example/');

      expect(transitions('b')).toEqual(['restore']);
    });

    it('is typed instead when the user navigates before the restore commits', () => {
      const { manager, runtimeOf, transitions } = setup();
      manager.restoreSession(restoredSession('a'));

      manager.navigate('a', 'https://elsewhere.example/', { transition: 'typed' });
      commit(runtimeOf('a'), 'https://elsewhere.example/');

      expect(transitions('a')).toEqual(['typed']);
    });
  });
});

describe('TabManager history observer: committed', () => {
  it('tells the tab, the address, whether it stayed in the document, and how it got there', () => {
    const { manager, runtimeOf, history } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://example.com/a?b=1#c', { transition: 'typed' });

    commit(runtimeOf(id), 'https://example.com/a?b=1#c');

    expect(history.committed).toHaveBeenCalledTimes(1);
    expect(history.committed).toHaveBeenCalledWith(id, {
      url: 'https://example.com/a?b=1#c',
      sameDocument: false,
      transition: 'typed',
    });
  });

  it('tells a same-document commit as one', () => {
    const { manager, runtimeOf, history } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://app.example/');
    commit(runtimeOf(id), 'https://app.example/');

    commit(runtimeOf(id), 'https://app.example/next', { sameDocument: true });

    expect(history.committed).toHaveBeenLastCalledWith(id, {
      url: 'https://app.example/next',
      sameDocument: true,
      transition: 'link',
    });
  });

  it('tells the address of the document, even one the memory will not record', () => {
    const { manager, runtimeOf, history } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://example.com/');

    commit(runtimeOf(id), 'file:///C:/page.html');

    expect(history.committed).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ url: 'file:///C:/page.html' }),
    );
  });

  it('tells it after the tab shows the page, so the observer reads the tab as it is now', () => {
    const { manager, runtimeOf, history } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://example.com/');
    const seen: unknown[] = [];
    history.committed.mockImplementation((tabId) => {
      const tab = manager.get(tabId);
      seen.push({ url: tab.url, page: tab.page.kind, runtime: tab.runtime });
    });

    commit(runtimeOf(id), 'https://example.com/');

    expect(seen).toEqual([{ url: 'https://example.com/', page: 'web', runtime: 'live' }]);
  });

  it('tells every commit, one call each', () => {
    const { manager, runtimeOf, history } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://example.com/');

    commit(runtimeOf(id), 'https://example.com/');
    commit(runtimeOf(id), 'https://example.com/');
    commit(runtimeOf(id), 'https://example.com/#x', { sameDocument: true });

    expect(history.committed).toHaveBeenCalledTimes(3);
  });

  it('does not tell a commit from a runtime that was replaced, or of a tab that closed', () => {
    const { manager, runtimeOf, runtimes, history } = setup();
    manager.restoreSession(restoredSession('a'));
    const first = runtimeOf('a');
    first.events.restoreFailed();
    history.committed.mockClear();

    commit(first, 'https://stale.example/');
    manager.close('a');
    commit(at(runtimes, -1), 'https://late.example/');

    expect(history.committed).not.toHaveBeenCalled();
  });

  it('is not told anything for an internal page, which has no web contents', () => {
    const { manager, history } = setup();
    const id = manager.create();

    manager.showInternal(id, 'new-tab');
    manager.showInternal(id, 'new-tab');

    expect(history.committed).not.toHaveBeenCalled();
    expect(history.titleChanged).not.toHaveBeenCalled();
    expect(history.faviconChanged).not.toHaveBeenCalled();
  });

  it('works with no observer at all', () => {
    const runtimes: FakeRuntime[] = [];
    const manager = new TabManager({
      createRuntime: (tabId, events) => {
        const runtime = new FakeRuntime(tabId, events);
        runtimes.push(runtime);
        return runtime;
      },
      newId: () => 'tab-1',
      onChange: () => undefined,
    });
    const id = manager.create();
    manager.navigate(id, 'https://example.com/');

    expect(() => {
      commit(at(runtimes, 0), 'https://example.com/');
      runtimes[0]?.events.titleChanged('Title');
      runtimes[0]?.events.faviconChanged('data:image/png;base64,AAAA');
      manager.close(id);
    }).not.toThrow();
  });
});

describe('TabManager history observer: titleChanged', () => {
  const liveTab = () => {
    const world = setup();
    const id = world.manager.create();
    world.manager.navigate(id, 'https://example.com/');
    commit(world.runtimeOf(id), 'https://example.com/');
    return { ...world, id };
  };

  it('tells the title the tab shows', () => {
    const { manager, runtimeOf, history, id } = liveTab();

    runtimeOf(id).events.titleChanged('Example Domain');

    expect(history.titleChanged).toHaveBeenCalledWith(id, 'Example Domain');
    expect(manager.get(id).title).toBe('Example Domain');
  });

  it('tells the title cleaned: no controls, no bidi marks, no padding', () => {
    const { manager, runtimeOf, history, id } = liveTab();

    runtimeOf(id).events.titleChanged('  Hello\u202e World\n\u0007 ');

    expect(history.titleChanged).toHaveBeenCalledWith(id, 'Hello World');
    expect(manager.get(id).title).toBe('Hello World');
  });

  it('tells exactly what the tab shows, whatever the title is', () => {
    const { manager, runtimeOf, history, id } = liveTab();

    for (const raw of [
      '\u200bZero\u200d width\ufeff',
      '\u2066isolate\u2069',
      'tab\tseparated',
      'ok',
    ]) {
      runtimeOf(id).events.titleChanged(raw);
      expect(history.titleChanged).toHaveBeenLastCalledWith(id, sanitizeTitle(raw));
      expect(manager.get(id).title).toBe(sanitizeTitle(raw));
    }
  });

  it('tells a title cut to 1,024 characters', () => {
    const { runtimeOf, history, id } = liveTab();

    runtimeOf(id).events.titleChanged('x'.repeat(5000));

    expect(history.titleChanged).toHaveBeenCalledWith(id, 'x'.repeat(1024));
  });

  it('tells a title that is empty once it is cleaned: the observer decides what that means', () => {
    const { runtimeOf, history, id } = liveTab();

    runtimeOf(id).events.titleChanged('\u202e\u0007  ');

    expect(history.titleChanged).toHaveBeenCalledWith(id, '');
  });

  it('tells each change, one call each', () => {
    const { runtimeOf, history, id } = liveTab();

    runtimeOf(id).events.titleChanged('One');
    runtimeOf(id).events.titleChanged('Two');
    runtimeOf(id).events.titleChanged('Two');

    expect(history.titleChanged.mock.calls).toEqual([
      [id, 'One'],
      [id, 'Two'],
      [id, 'Two'],
    ]);
  });

  it('does not tell a title for a page that is not on show: an error page’s own title', () => {
    const { runtimeOf, history, id } = liveTab();
    runtimeOf(id).events.loadFailed({
      code: -105,
      name: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://down.example/',
    });

    runtimeOf(id).events.titleChanged('down.example');

    expect(history.titleChanged).not.toHaveBeenCalled();
  });

  it('does not tell a title for a crashed tab', () => {
    const { runtimeOf, history, id } = liveTab();
    runtimeOf(id).events.crashed({ code: 11, name: 'crashed' });

    runtimeOf(id).events.titleChanged('Aw, Snap');

    expect(history.titleChanged).not.toHaveBeenCalled();
  });

  it('does not tell a title from a runtime that was replaced', () => {
    const { manager, runtimeOf, history } = setup();
    manager.restoreSession(restoredSession('a'));
    const first = runtimeOf('a');
    first.events.restoreFailed();

    first.events.titleChanged('From the old runtime');

    expect(history.titleChanged).not.toHaveBeenCalled();
  });

  it('does not tell a title for a tab that closed', () => {
    const { manager, runtimeOf, history, id } = liveTab();
    const runtime = runtimeOf(id);
    manager.close(id);

    runtime.events.titleChanged('Too late');

    expect(history.titleChanged).not.toHaveBeenCalled();
  });

  it('tells the titles of two tabs apart', () => {
    const { manager, runtimeOf, history, id } = liveTab();
    const other = manager.create();
    manager.navigate(other, 'https://other.example/');
    commit(runtimeOf(other), 'https://other.example/');

    runtimeOf(other).events.titleChanged('Other');
    runtimeOf(id).events.titleChanged('First');

    expect(history.titleChanged.mock.calls).toEqual([
      [other, 'Other'],
      [id, 'First'],
    ]);
  });
});

describe('TabManager history observer: faviconChanged', () => {
  const FAVICON = 'data:image/png;base64,iVBORw0KGgo=';
  const liveTab = () => {
    const world = setup();
    const id = world.manager.create();
    world.manager.navigate(id, 'https://example.com/');
    commit(world.runtimeOf(id), 'https://example.com/');
    return { ...world, id };
  };

  it('tells the icon the favicon service made', () => {
    const { manager, runtimeOf, history, id } = liveTab();

    runtimeOf(id).events.faviconChanged(FAVICON);

    expect(history.faviconChanged).toHaveBeenCalledWith(id, FAVICON);
    expect(manager.get(id).favicon).toBe(FAVICON);
  });

  it('does not tell that there is none: the tab loses its icon, the memory keeps the page’s', () => {
    const { manager, runtimeOf, history, id } = liveTab();
    runtimeOf(id).events.faviconChanged(FAVICON);
    history.faviconChanged.mockClear();

    runtimeOf(id).events.faviconChanged(null);

    expect(history.faviconChanged).not.toHaveBeenCalled();
    expect(manager.get(id).favicon).toBeNull();
  });

  it('does not tell an icon for a page that is not on show', () => {
    const { runtimeOf, history, id } = liveTab();
    runtimeOf(id).events.loadFailed({
      code: -105,
      name: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://down.example/',
    });

    runtimeOf(id).events.faviconChanged(FAVICON);

    expect(history.faviconChanged).not.toHaveBeenCalled();
  });

  it('does not tell an icon from a runtime that was replaced, or for a tab that closed', () => {
    const { manager, runtimeOf, history } = setup();
    manager.restoreSession(restoredSession('a'));
    const first = runtimeOf('a');
    first.events.restoreFailed();
    first.events.faviconChanged(FAVICON);
    const second = runtimeOf('a');
    manager.close('a');

    second.events.faviconChanged(FAVICON);

    expect(history.faviconChanged).not.toHaveBeenCalled();
  });
});

describe('TabManager history observer: closed', () => {
  it('tells that a tab closed, with its id, once', () => {
    const { manager, history } = setup();
    const a = manager.create();
    const b = manager.create();

    manager.close(a);

    expect(history.closed).toHaveBeenCalledTimes(1);
    expect(history.closed).toHaveBeenCalledWith(a);
    expect(manager.tabs().map((tab) => tab.id)).toEqual([b]);
  });

  it('tells it after the tab is gone from the strip', () => {
    const { manager, history } = setup();
    const a = manager.create();
    manager.create();
    const stillThere: boolean[] = [];
    history.closed.mockImplementation((tabId) => {
      stillThere.push(manager.tabs().some((tab) => tab.id === tabId));
    });

    manager.close(a);

    expect(stillThere).toEqual([false]);
  });

  it('tells it for a tab with a page, an unloaded one and a new-tab page', () => {
    const { manager, runtimeOf, history } = setup();
    manager.restoreSession(restoredSession('a', 'b'));
    commit(runtimeOf('a'), 'https://a.example/');
    const blank = manager.create();

    manager.close('a');
    manager.close('b');
    manager.close(blank);

    expect(history.closed.mock.calls.map(([id]) => id)).toEqual(['a', 'b', blank]);
  });

  it('tells it for the last tab too, though a new one opens in its place', () => {
    const { manager, history } = setup();
    const only = manager.create();

    manager.close(only);

    expect(history.closed).toHaveBeenCalledWith(only);
    expect(manager.tabs()).toHaveLength(1);
    expect(manager.tabs()[0]?.id).not.toBe(only);
  });

  it('tells it once the runtime is destroyed, so nothing more arrives for the tab', () => {
    const { manager, runtimeOf, history, runtimes } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://example.com/');
    commit(runtimeOf(id), 'https://example.com/');
    const destroyedWhenTold: boolean[] = [];
    history.closed.mockImplementation(() => {
      destroyedWhenTold.push(runtimes.every((runtime) => runtime.destroyed));
    });

    manager.close(id);

    expect(destroyedWhenTold).toEqual([true]);
  });

  it('is not told for a tab that is still open', () => {
    const { manager, history } = setup();
    manager.create();
    manager.create();

    expect(history.closed).not.toHaveBeenCalled();
  });
});
