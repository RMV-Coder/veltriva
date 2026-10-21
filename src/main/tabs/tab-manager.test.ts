import { describe, expect, it } from 'vitest';

import { sanitizeTitle, TabManager, TabNotFoundError } from './tab-manager';
import type { TabHistory } from '../../core/session/history';
import type { TabId, TabRuntime, TabRuntimeEvents } from './tab-manager';

/** Zoom per host, as Chromium keeps it: shared by every fake runtime of one test. */
type ZoomByHost = Map<string, number>;

/** A runtime that records what TabManager asked of it. */
class FakeRuntime implements TabRuntime {
  shown = false;
  destroyed = false;
  focused = 0;
  /** The host of the document on display, for per-host zoom. Tests set it. */
  host = '';
  readonly loads: string[] = [];
  readonly calls: string[] = [];
  #nextFindId = 0;

  constructor(
    readonly tabId: TabId,
    readonly events: TabRuntimeEvents,
    readonly zoomByHost: ZoomByHost,
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
  find(text: string, options: { readonly forward: boolean; readonly newSearch: boolean }): number {
    this.#nextFindId += 1;
    this.calls.push(
      `find:${text}:${options.forward ? 'forward' : 'backward'}:${options.newSearch ? 'new' : 'next'}`,
    );
    return this.#nextFindId;
  }
  stopFind(action: string): void {
    this.calls.push(`stopFind:${action}`);
  }
  zoomFactor(): number {
    return this.zoomByHost.get(this.host) ?? 1;
  }
  setZoomFactor(factor: number): void {
    this.zoomByHost.set(this.host, factor);
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
  /** Each restore, with whether the view was attached by then (S2: it must be). */
  readonly restores: { history: TabHistory; shownFirst: boolean }[] = [];
  /** What `history()` reports; tests set it as a page would build it. */
  historyValue: TabHistory | null = null;
  restore(history: TabHistory): void {
    this.assertAlive();
    if (this.loads.length > 0 || this.restores.length > 0) {
      throw new Error(`runtime of ${this.tabId} restored after it loaded (S2 forbids it)`);
    }
    this.restores.push({ history, shownFirst: this.shown });
  }
  history(): TabHistory | null {
    return this.historyValue;
  }
  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`runtime of ${this.tabId} used after destroy()`);
    }
  }
}

function setup() {
  const runtimes: FakeRuntime[] = [];
  const zoomByHost: ZoomByHost = new Map();
  const fullscreenChanges: (TabId | null)[] = [];
  let changes = 0;
  let nextId = 0;
  const manager = new TabManager({
    createRuntime: (tabId, events) => {
      const runtime = new FakeRuntime(tabId, events, zoomByHost);
      runtimes.push(runtime);
      return runtime;
    },
    newId: () => `tab-${String((nextId += 1))}`,
    onChange: () => {
      changes += 1;
    },
    onFullscreenChange: (tabId) => {
      fullscreenChanges.push(tabId);
    },
  });
  const runtimeOf = (tabId: TabId): FakeRuntime => {
    const found = runtimes.filter((runtime) => runtime.tabId === tabId && !runtime.destroyed);
    const [runtime] = found;
    if (found.length !== 1 || runtime === undefined) {
      throw new Error(`expected one live runtime for ${tabId}, found ${String(found.length)}`);
    }
    return runtime;
  };
  /** A tab showing a committed web page at `url` (its runtime's host set to match). */
  const webTab = (url: string, options: { readonly select?: boolean } = {}): TabId => {
    const id = manager.create(options);
    manager.navigate(id, url);
    const runtime = runtimeOf(id);
    runtime.host = new URL(url).host;
    commit(runtime, url);
    return id;
  };
  return {
    manager,
    runtimes,
    runtimeOf,
    webTab,
    fullscreenChanges,
    changes: () => changes,
  };
}

/** A new document committing in a runtime, as Electron reports it. */
function commit(runtime: FakeRuntime, url: string, canGoBack = false): void {
  runtime.events.committed({ url, sameDocument: false, canGoBack, canGoForward: false });
}

/** Invariants 1–4 from tab-manager.ts. */
function assertInvariants(manager: TabManager, runtimes: readonly FakeRuntime[]): void {
  const tabs = manager.tabs();
  const ids = tabs.map((tab) => tab.id);
  const open = new Set(ids);
  expect(open.size).toBe(ids.length);
  const firstUnpinned = tabs.findIndex((tab) => !tab.pinned);
  if (firstUnpinned !== -1) {
    expect(tabs.slice(firstUnpinned).every((tab) => !tab.pinned)).toBe(true);
  }

  const selected = manager.selectedTabId();
  if (tabs.length === 0) {
    expect(selected).toBeNull();
  } else {
    expect(selected).not.toBeNull();
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

describe('TabManager', () => {
  it('opens a new-tab page without creating a web contents', () => {
    const { manager, runtimes } = setup();
    const id = manager.create();
    expect(manager.selectedTabId()).toBe(id);
    expect(manager.get(id)).toMatchObject({
      runtime: 'unloaded',
      page: { kind: 'internal', name: 'new-tab' },
      url: '',
      placement: 'strip',
    });
    expect(runtimes).toHaveLength(0);
  });

  it('creates the runtime on first navigation and shows only the selected tab', () => {
    const { manager, runtimes, runtimeOf } = setup();
    const a = manager.create();
    manager.navigate(a, 'https://a.example/');
    const b = manager.create();
    manager.navigate(b, 'https://b.example/');

    expect(runtimeOf(a).loads).toEqual(['https://a.example/']);
    // Until a document commits, each tab keeps its new-tab page, drawn by the shell.
    expect(manager.get(b)).toMatchObject({
      runtime: 'creating',
      page: { kind: 'internal', name: 'new-tab' },
      url: '',
      loading: true,
    });
    expect(runtimeOf(b).shown).toBe(false);

    commit(runtimeOf(a), 'https://a.example/');
    commit(runtimeOf(b), 'https://b.example/');
    expect(runtimeOf(a).shown).toBe(false);
    expect(runtimeOf(b).shown).toBe(true);
    expect(manager.get(b)).toMatchObject({ runtime: 'live', page: { kind: 'web' } });

    manager.select(a);
    expect(runtimeOf(a).shown).toBe(true);
    expect(runtimeOf(b).shown).toBe(false);
    assertInvariants(manager, runtimes);
  });

  it('tracks navigation events from the runtime', () => {
    const { manager, runtimeOf } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://a.example/');
    const runtime = runtimeOf(id);

    runtime.events.committed({
      url: 'https://a.example/',
      sameDocument: false,
      canGoBack: false,
      canGoForward: false,
    });
    runtime.events.titleChanged('  A ‮title\u0000 ');
    runtime.events.faviconChanged('data:image/png;base64,AAAA');
    runtime.events.loadingChanged(false);
    expect(manager.get(id)).toMatchObject({
      runtime: 'live',
      url: 'https://a.example/',
      title: 'A title',
      favicon: 'data:image/png;base64,AAAA',
      loading: false,
    });

    // A same-document change keeps the favicon; a new document drops the old site's favicon.
    runtime.events.committed({
      url: 'https://a.example/#part',
      sameDocument: true,
      canGoBack: true,
      canGoForward: false,
    });
    expect(manager.get(id)).toMatchObject({
      url: 'https://a.example/#part',
      favicon: 'data:image/png;base64,AAAA',
    });
    runtime.events.committed({
      url: 'https://b.example/',
      sameDocument: false,
      canGoBack: true,
      canGoForward: false,
    });
    expect(manager.get(id)).toMatchObject({ url: 'https://b.example/', favicon: null });
  });

  it('focuses the page when an address-bar navigation commits', () => {
    const { manager, runtimeOf } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://a.example/');
    const runtime = runtimeOf(id);
    const before = runtime.focused;
    runtime.events.committed({
      url: 'https://a.example/',
      sameDocument: false,
      canGoBack: false,
      canGoForward: false,
    });
    expect(runtime.focused).toBe(before + 1);
    // Later commits (links, history) don't steal focus again.
    runtime.events.committed({
      url: 'https://a.example/2',
      sameDocument: false,
      canGoBack: true,
      canGoForward: false,
    });
    expect(runtime.focused).toBe(before + 1);
  });

  it('shows the network-error page instead of the view, and retries on reload', () => {
    const { manager, runtimes, runtimeOf } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://down.example/');
    const runtime = runtimeOf(id);
    runtime.events.titleChanged('The previous page');

    runtime.events.loadFailed({
      code: -105,
      name: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://down.example/',
    });
    expect(manager.get(id).page).toEqual({
      kind: 'internal',
      name: 'network-error',
      error: { code: -105, name: 'ERR_NAME_NOT_RESOLVED' },
    });
    // The sidebar must not label the error page with the page that was there before.
    expect(manager.get(id).title).toBe('');
    expect(manager.get(id).url).toBe('https://down.example/');
    expect(runtime.shown).toBe(false);
    assertInvariants(manager, runtimes);

    manager.reload(id);
    expect(runtime.calls).toEqual(['reload']);
    // The error page stays until a document actually commits.
    expect(runtime.shown).toBe(false);
    runtime.events.committed({
      url: 'https://down.example/',
      sameDocument: false,
      canGoBack: false,
      canGoForward: false,
    });
    expect(manager.get(id).page).toEqual({ kind: 'web' });
    expect(runtime.shown).toBe(true);
  });

  it('shows the crashed page and restarts the renderer on reload', () => {
    const { manager, runtimes, runtimeOf } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://a.example/');
    const runtime = runtimeOf(id);
    runtime.events.committed({
      url: 'https://a.example/',
      sameDocument: false,
      canGoBack: false,
      canGoForward: false,
    });

    runtime.events.crashed({ code: 1, name: 'crashed' });
    expect(manager.get(id)).toMatchObject({
      runtime: 'crashed',
      page: { kind: 'internal', name: 'crashed', error: { code: 1, name: 'crashed' } },
    });
    expect(runtime.shown).toBe(false);
    assertInvariants(manager, runtimes);

    manager.reload(id);
    expect(manager.get(id).runtime).toBe('creating');
    expect(runtime.shown).toBe(false);
    runtime.events.committed({
      url: 'https://a.example/',
      sameDocument: false,
      canGoBack: false,
      canGoForward: false,
    });
    expect(manager.get(id)).toMatchObject({ runtime: 'live', page: { kind: 'web' } });
    expect(runtime.shown).toBe(true);
  });

  it('selects the next tab when the selected one closes, or the previous at the end', () => {
    const { manager, runtimes } = setup();
    const [a, b, c] = [manager.create(), manager.create(), manager.create()];
    manager.select(b);
    manager.close(b);
    expect(manager.selectedTabId()).toBe(c);
    manager.close(c);
    expect(manager.selectedTabId()).toBe(a);
    assertInvariants(manager, runtimes);
  });

  it('keeps the selection when another tab closes', () => {
    const { manager } = setup();
    const [a, b] = [manager.create(), manager.create()];
    manager.select(a);
    manager.close(b);
    expect(manager.selectedTabId()).toBe(a);
  });

  it('destroys the runtime of a closed tab and ignores its late events', () => {
    const { manager, runtimeOf } = setup();
    const a = manager.create();
    manager.navigate(a, 'https://a.example/');
    const runtime = runtimeOf(a);
    manager.create();
    manager.close(a);
    expect(runtime.destroyed).toBe(true);
    expect(() => {
      runtime.events.titleChanged('late');
      runtime.events.committed({
        url: 'https://x.example/',
        sameDocument: false,
        canGoBack: true,
        canGoForward: false,
      });
      runtime.events.crashed({ code: 1, name: 'crashed' });
    }).not.toThrow();
    expect(manager.has(a)).toBe(false);
  });

  it('opens a new tab when the last one closes', () => {
    const { manager } = setup();
    const only = manager.create();
    manager.close(only);
    expect(manager.tabs()).toHaveLength(1);
    const [replacement] = manager.tabs();
    expect(replacement?.id).not.toBe(only);
    expect(manager.selectedTabId()).toBe(replacement?.id);
  });

  it('keeps pinned tabs first when pinning, unpinning and moving', () => {
    const { manager, runtimes } = setup();
    const [a, b, c, d] = [manager.create(), manager.create(), manager.create(), manager.create()];
    const order = () => manager.tabs().map((tab) => tab.id);

    manager.setPinned(c, true);
    expect(order()).toEqual([c, a, b, d]);
    manager.setPinned(d, true);
    expect(order()).toEqual([c, d, a, b]);

    // An unpinned tab can't move into the pinned section, nor a pinned one out of it.
    manager.move(b, 0);
    expect(order()).toEqual([c, d, b, a]);
    manager.move(c, 10);
    expect(order()).toEqual([d, c, b, a]);

    manager.setPinned(c, false);
    expect(order()).toEqual([d, c, b, a]);
    expect(manager.get(c).pinned).toBe(false);
    manager.move(a, 1);
    expect(order()).toEqual([d, a, c, b]);
    assertInvariants(manager, runtimes);
  });

  it('duplicates a tab right after it, with the same URL and pin state', () => {
    const { manager, runtimeOf } = setup();
    const a = manager.create();
    manager.navigate(a, 'https://a.example/');
    commit(runtimeOf(a), 'https://a.example/');
    manager.setPinned(a, true);
    const b = manager.create();
    const copy = manager.duplicate(a);

    expect(manager.tabs().map((tab) => tab.id)).toEqual([a, copy, b]);
    expect(manager.selectedTabId()).toBe(copy);
    expect(manager.get(copy).pinned).toBe(true);
    expect(runtimeOf(copy).loads).toEqual(['https://a.example/']);
  });

  it('duplicates a new-tab page as a new-tab page', () => {
    const { manager, runtimes } = setup();
    const copy = manager.duplicate(manager.create());
    expect(manager.get(copy).page).toEqual({ kind: 'internal', name: 'new-tab' });
    expect(runtimes).toHaveLength(0);
  });

  it('ignores events from a runtime that was replaced', () => {
    const { manager, runtimes } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://a.example/');
    const first = runtimes[0];
    manager.showInternal(id, 'new-tab');
    manager.navigate(id, 'https://b.example/');
    first?.events.committed({
      url: 'https://stale.example/',
      sameDocument: false,
      canGoBack: true,
      canGoForward: false,
    });
    first?.events.crashed({ code: 1, name: 'crashed' });
    // The new load hasn't committed: the tab still shows the new-tab page, untouched.
    expect(manager.get(id)).toMatchObject({
      url: '',
      page: { kind: 'internal', name: 'new-tab' },
      runtime: 'creating',
    });
  });

  it('keeps the address of the document on display until a new one commits', () => {
    const { manager, runtimeOf } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://a.example/');
    const runtime = runtimeOf(id);
    commit(runtime, 'https://a.example/');

    // Typed a new address, then stopped it: the page and address stay those of a.example.
    manager.navigate(id, 'https://b.example/');
    runtime.events.loadingChanged(true);
    expect(manager.get(id)).toMatchObject({ url: 'https://a.example/', loading: true });
    runtime.events.loadingChanged(false);
    expect(manager.get(id)).toMatchObject({
      url: 'https://a.example/',
      page: { kind: 'web' },
      loading: false,
    });

    commit(runtime, 'https://b.example/', true);
    expect(manager.get(id).url).toBe('https://b.example/');
  });

  it('warns on the commit of a typed address whose credentials were removed, and only that one', () => {
    const { manager, runtimeOf } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://evil.example/', { credentialsRemoved: true });
    const runtime = runtimeOf(id);
    expect(manager.get(id).credentialsRemoved).toBe(false);

    commit(runtime, 'https://evil.example/');
    expect(manager.get(id).credentialsRemoved).toBe(true);
    // A fragment change is the same document: still the address that was typed.
    runtime.events.committed({
      url: 'https://evil.example/#x',
      sameDocument: true,
      canGoBack: true,
      canGoForward: false,
    });
    expect(manager.get(id).credentialsRemoved).toBe(true);
    // The page moves on by itself: a new document, a new address.
    commit(runtime, 'https://evil.example/next', true);
    expect(manager.get(id).credentialsRemoved).toBe(false);

    // A failed load of such an address warns too.
    manager.navigate(id, 'https://down.example/', { credentialsRemoved: true });
    runtime.events.loadFailed({
      code: -105,
      name: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://down.example/',
    });
    expect(manager.get(id).credentialsRemoved).toBe(true);
    manager.showInternal(id, 'new-tab');
    expect(manager.get(id).credentialsRemoved).toBe(false);
  });

  it('closes the web contents when a tab shows an internal page', () => {
    const { manager, runtimeOf } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://a.example/');
    const runtime = runtimeOf(id);
    manager.showInternal(id, 'new-tab');
    expect(runtime.destroyed).toBe(true);
    expect(manager.get(id)).toMatchObject({ runtime: 'unloaded', url: '', canGoBack: false });
  });

  it('only goes back or forward when history allows it', () => {
    const { manager, runtimeOf } = setup();
    const id = manager.create();
    manager.navigate(id, 'https://a.example/');
    const runtime = runtimeOf(id);
    manager.goBack(id);
    manager.goForward(id);
    expect(runtime.calls).toEqual([]);
    runtime.events.committed({
      url: 'https://a.example/2',
      sameDocument: false,
      canGoBack: true,
      canGoForward: true,
    });
    manager.goBack(id);
    manager.goForward(id);
    manager.stop(id);
    expect(runtime.calls).toEqual(['back', 'forward', 'stop']);
  });

  it('reports unknown tabs', () => {
    const { manager } = setup();
    expect(() => {
      manager.select('nope');
    }).toThrow(TabNotFoundError);
    expect(() => {
      manager.close('nope');
    }).toThrow(TabNotFoundError);
  });

  it('notifies on every change', () => {
    const { manager, changes } = setup();
    const before = changes();
    manager.create();
    expect(changes()).toBeGreaterThan(before);
  });

  it('keeps every invariant through rapid switching', () => {
    const { manager, runtimes } = setup();
    const ids = [manager.create(), manager.create(), manager.create()];
    for (const id of ids) {
      manager.navigate(id, `https://${id}.example/`);
    }
    for (let step = 0; step < 1_000; step += 1) {
      manager.select(ids[step % ids.length] ?? ids[0] ?? '');
      assertInvariants(manager, runtimes);
    }
  });

  it('keeps every invariant through a long random sequence of operations', () => {
    const { manager, runtimes } = setup();
    // A small deterministic PRNG (mulberry32), so a failure is reproducible.
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(items: readonly T[]): T | undefined =>
      items[Math.floor(random() * items.length)];

    manager.create();
    for (let step = 0; step < 2_000; step += 1) {
      const tabs = manager.tabs();
      const tab = pick(tabs);
      if (tab === undefined) {
        throw new Error('the strip should never be empty here');
      }
      const live = runtimes.find((runtime) => !runtime.destroyed && runtime.tabId === tab.id);
      switch (Math.floor(random() * 12)) {
        case 0:
          if (tabs.length < 25) {
            manager.create({ select: random() < 0.7 });
          } else {
            manager.close(tab.id);
          }
          break;
        case 1:
          manager.close(tab.id);
          break;
        case 2:
          manager.select(tab.id);
          break;
        case 3:
          manager.move(tab.id, Math.floor(random() * (tabs.length + 2)));
          break;
        case 4:
          manager.setPinned(tab.id, !tab.pinned);
          break;
        case 5:
          if (tabs.length < 25) {
            manager.duplicate(tab.id);
          } else {
            manager.close(tab.id);
          }
          break;
        case 6:
          manager.navigate(tab.id, `https://site${String(step)}.example/`);
          break;
        case 7:
          manager.reload(tab.id);
          break;
        case 8:
          live?.events.crashed({ code: 1, name: 'crashed' });
          break;
        case 9:
          live?.events.loadFailed({ code: -105, name: 'ERR_NAME_NOT_RESOLVED', url: tab.url });
          break;
        case 10:
          live?.events.committed({
            url: `${tab.url}#${String(step)}`,
            sameDocument: true,
            canGoBack: true,
            canGoForward: false,
          });
          break;
        default:
          live?.events.committed({
            url: tab.url,
            sameDocument: false,
            canGoBack: random() < 0.5,
            canGoForward: false,
          });
      }
      assertInvariants(manager, runtimes);
    }
  });

  it('closes everything on shutdown', () => {
    const { manager, runtimes } = setup();
    for (let i = 0; i < 3; i += 1) {
      manager.navigate(manager.create(), 'https://a.example/');
    }
    manager.closeAll();
    expect(manager.tabs()).toEqual([]);
    expect(manager.selectedTabId()).toBeNull();
    expect(runtimes.every((runtime) => runtime.destroyed)).toBe(true);
  });
});

describe('sanitizeTitle', () => {
  it('removes controls and bidi overrides, trims and caps the length', () => {
    expect(sanitizeTitle('‮gnp.exe‬  Invoice\u0007\n')).toBe('gnp.exe  Invoice');
    expect(sanitizeTitle('x'.repeat(5000))).toHaveLength(1024);
  });
});

describe('TabManager in M1.3b', () => {
  describe('find in page', () => {
    it('opens the find bar on a web page, searches as the text changes and reports matches', () => {
      const { manager, runtimeOf, webTab } = setup();
      const id = webTab('https://a.example/');
      const runtime = runtimeOf(id);

      expect(manager.openFind(id)).toBe(true);
      expect(manager.get(id).find).toEqual({ text: '', activeMatch: 0, matches: 0 });
      // An empty find bar searches for nothing.
      expect(runtime.calls).toEqual([]);

      manager.updateFind(id, 'cat');
      expect(runtime.calls).toEqual(['find:cat:forward:new']);
      runtime.events.foundInPage({ requestId: 1, activeMatch: 1, matches: 4 });
      expect(manager.get(id).find).toEqual({ text: 'cat', activeMatch: 1, matches: 4 });

      manager.findNext(id, true);
      manager.findNext(id, false);
      expect(runtime.calls.slice(1)).toEqual(['find:cat:forward:next', 'find:cat:backward:next']);
      runtime.events.foundInPage({ requestId: 3, activeMatch: 4, matches: 4 });
      expect(manager.get(id).find?.activeMatch).toBe(4);
    });

    it('ignores results of an older search once the text has changed', () => {
      const { manager, runtimeOf, webTab } = setup();
      const id = webTab('https://a.example/');
      const runtime = runtimeOf(id);
      manager.openFind(id);
      manager.updateFind(id, 'ca');
      manager.updateFind(id, 'cat');
      runtime.events.foundInPage({ requestId: 1, activeMatch: 1, matches: 9 });
      expect(manager.get(id).find).toEqual({ text: 'cat', activeMatch: 0, matches: 0 });
      runtime.events.foundInPage({ requestId: 2, activeMatch: 1, matches: 2 });
      expect(manager.get(id).find).toEqual({ text: 'cat', activeMatch: 1, matches: 2 });
    });

    it('clears an emptied search, closes keeping the selection, and offers the text again', () => {
      const { manager, runtimeOf, webTab } = setup();
      const id = webTab('https://a.example/');
      const runtime = runtimeOf(id);
      manager.openFind(id);
      manager.updateFind(id, 'dog');
      manager.updateFind(id, '');
      expect(runtime.calls.at(-1)).toBe('stopFind:clearSelection');
      manager.updateFind(id, 'dog');
      manager.closeFind(id);
      expect(runtime.calls.at(-1)).toBe('stopFind:keepSelection');
      expect(manager.get(id).find).toBeNull();

      // Reopening offers the last text, and searches for it right away.
      manager.openFind(id);
      expect(manager.get(id).find?.text).toBe('dog');
      expect(runtime.calls.at(-1)).toBe('find:dog:forward:new');
    });

    it('closes the find bar on a new document and ends the old search, as in Chrome', () => {
      const { manager, runtimeOf, webTab } = setup();
      const id = webTab('https://a.example/');
      const runtime = runtimeOf(id);
      manager.openFind(id);
      manager.updateFind(id, 'cat');
      runtime.events.foundInPage({ requestId: 1, activeMatch: 2, matches: 5 });
      commit(runtime, 'https://a.example/next', true);
      expect(manager.get(id).find).toBeNull();
      // Chromium's find session would otherwise carry over into the new document.
      expect(runtime.calls.at(-1)).toBe('stopFind:clearSelection');
      // A late result for the old document doesn't bring the bar back.
      runtime.events.foundInPage({ requestId: 1, activeMatch: 2, matches: 5 });
      expect(manager.get(id).find).toBeNull();

      // Ctrl+F offers the text again and searches the new page.
      manager.openFind(id);
      expect(manager.get(id).find).toEqual({ text: 'cat', activeMatch: 0, matches: 0 });
      expect(runtime.calls.at(-1)).toBe('find:cat:forward:new');
    });

    it('keeps the find bar on a same-document navigation, and stops nothing without one', () => {
      const { manager, runtimeOf, webTab } = setup();
      const id = webTab('https://a.example/');
      const runtime = runtimeOf(id);
      manager.openFind(id);
      manager.updateFind(id, 'cat');
      runtime.events.foundInPage({ requestId: 1, activeMatch: 2, matches: 5 });
      runtime.events.committed({
        url: 'https://a.example/#part',
        sameDocument: true,
        canGoBack: true,
        canGoForward: false,
      });
      expect(manager.get(id).find).toEqual({ text: 'cat', activeMatch: 2, matches: 5 });

      // With the bar closed, a navigation has no search to stop.
      manager.closeFind(id);
      const calls = runtime.calls.length;
      commit(runtime, 'https://a.example/next', true);
      expect(runtime.calls.slice(calls).filter((call) => call.startsWith('stopFind'))).toEqual([]);
    });

    it('has nothing to search on a new-tab page, and closes when the page fails or crashes', () => {
      const { manager, runtimeOf, webTab } = setup();
      expect(manager.openFind(manager.create())).toBe(false);

      const failed = webTab('https://a.example/');
      manager.openFind(failed);
      runtimeOf(failed).events.loadFailed({
        code: -105,
        name: 'ERR_NAME_NOT_RESOLVED',
        url: 'https://b.example/',
      });
      expect(manager.get(failed).find).toBeNull();
      expect(manager.openFind(failed)).toBe(false);

      const crashed = webTab('https://c.example/');
      manager.openFind(crashed);
      runtimeOf(crashed).events.crashed({ code: 1, name: 'crashed' });
      expect(manager.get(crashed).find).toBeNull();
    });
  });

  describe('zoom', () => {
    it('steps through the presets and resets', () => {
      const { manager, webTab } = setup();
      const id = webTab('https://a.example/');
      expect(manager.get(id).zoomPercent).toBe(100);
      manager.zoom(id, 'in');
      manager.zoom(id, 'in');
      expect(manager.get(id).zoomPercent).toBe(125);
      manager.zoom(id, 'out');
      expect(manager.get(id).zoomPercent).toBe(110);
      manager.zoom(id, 'reset');
      expect(manager.get(id).zoomPercent).toBe(100);
    });

    it('shows a zoom change on every tab of the same host, as Chromium applies it', () => {
      const { manager, webTab } = setup();
      const first = webTab('https://a.example/one');
      const second = webTab('https://a.example/two');
      const other = webTab('https://b.example/');
      manager.zoom(first, 'out');
      expect(manager.get(first).zoomPercent).toBe(90);
      expect(manager.get(second).zoomPercent).toBe(90);
      expect(manager.get(other).zoomPercent).toBe(100);
    });

    it('zooms on a Ctrl+wheel request, and reads the new host zoom after a navigation', () => {
      const { manager, runtimeOf, webTab } = setup();
      const id = webTab('https://a.example/');
      const runtime = runtimeOf(id);
      runtime.events.zoomRequested('in');
      expect(manager.get(id).zoomPercent).toBe(110);
      runtime.host = 'b.example';
      commit(runtime, 'https://b.example/', true);
      expect(manager.get(id).zoomPercent).toBe(100);
    });

    it('leaves tabs without a web page alone', () => {
      const { manager } = setup();
      const id = manager.create();
      manager.zoom(id, 'in');
      expect(manager.get(id).zoomPercent).toBe(100);
    });
  });

  describe('HTML fullscreen', () => {
    it('tracks the selected tab entering and leaving fullscreen', () => {
      const { manager, runtimeOf, webTab, fullscreenChanges } = setup();
      const id = webTab('https://video.example/');
      runtimeOf(id).events.fullscreenChanged(true);
      expect(manager.fullscreenTabId()).toBe(id);
      runtimeOf(id).events.fullscreenChanged(false);
      expect(manager.fullscreenTabId()).toBeNull();
      expect(fullscreenChanges).toEqual([id, null]);
    });

    it('makes a background tab leave fullscreen at once: only the selected tab may have it', () => {
      const { manager, runtimeOf, webTab, fullscreenChanges } = setup();
      const background = webTab('https://a.example/');
      webTab('https://b.example/');
      runtimeOf(background).events.fullscreenChanged(true);
      expect(runtimeOf(background).calls).toContain('exitFullscreen');
      expect(manager.fullscreenTabId()).toBeNull();
      expect(fullscreenChanges).toEqual([]);
    });

    it('leaves fullscreen when another tab is selected, closed, crashes or fails', () => {
      const { manager, runtimeOf, webTab } = setup();
      const a = webTab('https://a.example/');
      const b = webTab('https://b.example/');

      runtimeOf(b).events.fullscreenChanged(true);
      manager.select(a);
      expect(runtimeOf(b).calls).toContain('exitFullscreen');
      expect(manager.fullscreenTabId()).toBeNull();

      runtimeOf(a).events.fullscreenChanged(true);
      runtimeOf(a).events.crashed({ code: 1, name: 'crashed' });
      expect(manager.fullscreenTabId()).toBeNull();

      manager.select(b);
      runtimeOf(b).events.fullscreenChanged(true);
      runtimeOf(b).events.loadFailed({ code: -105, name: 'ERR_FAILED', url: 'https://b.example/' });
      expect(manager.fullscreenTabId()).toBeNull();

      runtimeOf(b).events.fullscreenChanged(true);
      manager.close(b);
      expect(manager.fullscreenTabId()).toBeNull();
    });

    it('can be ended from main (F11, Esc in the shell)', () => {
      const { manager, runtimeOf, webTab } = setup();
      const id = webTab('https://video.example/');
      runtimeOf(id).events.fullscreenChanged(true);
      manager.exitFullscreen();
      expect(runtimeOf(id).calls).toContain('exitFullscreen');
      expect(manager.fullscreenTabId()).toBeNull();
    });
  });

  describe('selection by shortcut, and focus', () => {
    it('moves through the strip with wrap-around, and by index', () => {
      const { manager } = setup();
      const ids = [manager.create(), manager.create(), manager.create()];
      manager.selectIndex(0);
      manager.selectRelative(1);
      expect(manager.selectedTabId()).toBe(ids[1]);
      manager.selectRelative(-2);
      expect(manager.selectedTabId()).toBe(ids[2]);
      manager.selectRelative(1);
      expect(manager.selectedTabId()).toBe(ids[0]);
      manager.selectLast();
      expect(manager.selectedTabId()).toBe(ids[2]);
      manager.selectIndex(7);
      expect(manager.selectedTabId()).toBe(ids[2]);
    });

    it('focuses the newly selected page unless asked not to', () => {
      const { manager, runtimeOf, webTab } = setup();
      const a = webTab('https://a.example/');
      const b = webTab('https://b.example/');
      const before = runtimeOf(a).focused;
      manager.select(a, { focus: false });
      expect(runtimeOf(a).focused).toBe(before);
      manager.select(b);
      manager.select(a);
      expect(runtimeOf(a).focused).toBe(before + 1);

      // Closing keeps focus where it was when asked to (Delete in the sidebar).
      const focusedB = runtimeOf(b).focused;
      manager.close(a, { focus: false });
      expect(manager.selectedTabId()).toBe(b);
      expect(runtimeOf(b).focused).toBe(focusedB);
      expect(manager.focusPage(b)).toBe(true);
      expect(manager.focusPage(manager.create())).toBe(false);
    });
  });

  describe('reopening closed tabs', () => {
    it('brings back the last closed tab where it was, pinned if it was, with its id and stack', () => {
      const { manager, runtimeOf, webTab } = setup();
      const a = webTab('https://a.example/');
      const b = webTab('https://b.example/');
      webTab('https://c.example/');
      runtimeOf(a).historyValue = {
        index: 1,
        entries: [
          { url: 'https://a.example/', title: 'A' },
          { url: 'https://a.example/next', title: 'A next' },
        ],
      };
      manager.setPinned(b, true);
      manager.close(b);
      manager.close(a);

      const reopenedA = manager.reopenClosed();
      expect(reopenedA).toBe(a);
      expect(manager.selectedTabId()).toBe(a);
      // Restored into a new runtime, attached first (S2), with the stack it had.
      expect(runtimeOf(a).loads).toEqual([]);
      expect(runtimeOf(a).restores).toEqual([
        {
          history: {
            index: 1,
            entries: [
              { url: 'https://a.example/', title: 'A' },
              { url: 'https://a.example/next', title: 'A next' },
            ],
          },
          shownFirst: true,
        },
      ]);
      const reopenedB = manager.reopenClosed();
      expect(manager.tabs()[0]?.id).toBe(reopenedB);
      expect(manager.get(reopenedB ?? '').pinned).toBe(true);
      expect(manager.reopenClosed()).toBeNull();
    });

    it('forgets new-tab pages, which have nothing to reopen', () => {
      const { manager } = setup();
      manager.create();
      manager.close(manager.create());
      expect(manager.reopenClosed()).toBeNull();
    });

    it('keeps at most 100 closed tabs in a run', () => {
      const { manager, webTab } = setup();
      for (let i = 0; i < 105; i += 1) {
        manager.close(webTab('https://site' + String(i) + '.example/'));
      }
      let reopened = 0;
      while (manager.reopenClosed() !== null) {
        reopened += 1;
      }
      expect(reopened).toBe(100);
    });
  });

  it('toggles DevTools for a web page only', () => {
    const { manager, runtimeOf, webTab } = setup();
    const id = webTab('https://a.example/');
    manager.toggleDevTools(id);
    expect(runtimeOf(id).calls).toEqual(['devtools']);
    manager.toggleDevTools(manager.create());
  });

  it('reloads ignoring the cache when asked (Ctrl+Shift+R)', () => {
    const { manager, runtimeOf, webTab } = setup();
    const id = webTab('https://a.example/');
    manager.reload(id, { ignoreCache: true });
    manager.reload(id);
    expect(runtimeOf(id).calls).toEqual(['reload:ignoreCache', 'reload']);
  });
});
