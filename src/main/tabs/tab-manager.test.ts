import { describe, expect, it } from 'vitest';

import { sanitizeTitle, TabManager, TabNotFoundError } from './tab-manager';
import type { TabId, TabRuntime, TabRuntimeEvents } from './tab-manager';

/** A runtime that records what TabManager asked of it. */
class FakeRuntime implements TabRuntime {
  shown = false;
  destroyed = false;
  focused = 0;
  readonly loads: string[] = [];
  readonly calls: string[] = [];

  constructor(
    readonly tabId: TabId,
    readonly events: TabRuntimeEvents,
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
  reload(): void {
    this.calls.push('reload');
  }
  stop(): void {
    this.calls.push('stop');
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
  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`runtime of ${this.tabId} used after destroy()`);
    }
  }
}

function setup() {
  const runtimes: FakeRuntime[] = [];
  let changes = 0;
  let nextId = 0;
  const manager = new TabManager({
    createRuntime: (tabId, events) => {
      const runtime = new FakeRuntime(tabId, events);
      runtimes.push(runtime);
      return runtime;
    },
    newId: () => `tab-${String((nextId += 1))}`,
    onChange: () => {
      changes += 1;
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
  return { manager, runtimes, runtimeOf, changes: () => changes };
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
    expect(runtimeOf(a).shown).toBe(false);
    expect(runtimeOf(b).shown).toBe(true);
    expect(manager.get(b)).toMatchObject({
      runtime: 'creating',
      page: { kind: 'web' },
      loading: true,
    });

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
    expect(manager.get(id)).toMatchObject({ url: 'https://b.example/', runtime: 'creating' });
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
