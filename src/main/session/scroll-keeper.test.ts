import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type { DataMethod } from '../../shared/contracts/data-rpc';
import {
  MAX_SCROLL_TABS,
  parseScrollDocument,
  READ_SCROLL,
  SCROLL_DOCUMENT,
  SCROLL_WRITE_DELAY_MS,
  ScrollKeeper,
} from './scroll-keeper';
import type { ScrollContents } from './scroll-keeper';

const WORLD = 1001;
const PAGE = 'https://example.com/article';

/** A tab's contents whose page answers the scroll script with `reading`. */
function contentsAt(url: string, reading: unknown = [0, 1500]) {
  const scripts: string[] = [];
  const contents: ScrollContents & { scripts: string[]; destroyed: boolean } = {
    scripts,
    destroyed: false,
    getURL: () => url,
    isDestroyed() {
      return this.destroyed;
    },
    executeJavaScriptInIsolatedWorld: vi.fn((world: number, sources: { code: string }[]) => {
      expect(world).toBe(WORLD);
      const code = sources[0]?.code ?? '';
      scripts.push(code);
      return code === READ_SCROLL ? Promise.resolve(reading) : Promise.resolve(true);
    }),
  };
  return contents;
}

function setup(stored: unknown = null, live: readonly string[] = ['a', 'b']) {
  const writes: unknown[] = [];
  const call = vi.fn((method: DataMethod, input: unknown) => {
    DATA_METHODS[method].input.parse(input);
    writes.push(input);
    return Promise.resolve({});
  });
  const keeper = new ScrollKeeper({
    data: { call: call as never },
    logger: { warn: vi.fn(), error: vi.fn() },
    worldId: WORLD,
    stored,
    liveTabIds: () => new Set(live),
  });
  return { keeper, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ScrollKeeper (M5.3)', () => {
  it('reads where a page is scrolled, and writes it a few seconds later', async () => {
    const { keeper, writes } = setup();

    await keeper.capture('a', contentsAt(PAGE, [0, 1500]));

    expect(keeper.position('a')).toEqual({ url: PAGE, x: 0, y: 1500 });
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(SCROLL_WRITE_DELAY_MS);
    expect(writes).toEqual([
      { key: SCROLL_DOCUMENT, value: { tabs: { a: { url: PAGE, x: 0, y: 1500 } } } },
    ]);
  });

  it('keeps nothing for a sensitive page or one at the top, and forgets what it had', async () => {
    const { keeper } = setup();
    await keeper.capture('a', contentsAt(PAGE, [0, 900]));

    // The script answers null for a page with a password or payment field, and at the top.
    await keeper.capture('a', contentsAt(PAGE, null));

    expect(keeper.position('a')).toBeUndefined();
  });

  it.each([
    'https://example.com/app#/cb?code=CODE-SECRET&state=STATE-SECRET',
    'https://example.com/app#access_token=ACCESS-SECRET&token_type=bearer',
    'https://example.com/app#id_token=ID-SECRET',
    'https://alice:PASS-SECRET@example.com/article',
  ])('never keeps %s, an address the session cuts, and forgets what it had', async (url) => {
    const { keeper, writes } = setup();
    await keeper.capture('a', contentsAt(PAGE, [0, 900]));
    await vi.advanceTimersByTimeAsync(SCROLL_WRITE_DELAY_MS);

    const page = contentsAt(url, [0, 1200]);
    await keeper.capture('a', page);
    await vi.advanceTimersByTimeAsync(SCROLL_WRITE_DELAY_MS);

    expect(keeper.position('a')).toBeUndefined();
    // Not even asked: nothing is read from such a page.
    expect(page.scripts).toEqual([]);
    expect(writes.at(-1)).toEqual({ key: SCROLL_DOCUMENT, value: { tabs: {} } });
    expect(JSON.stringify(writes)).not.toMatch(/SECRET/u);
  });

  it('reads only web pages, and leaves what it had when the page cannot answer', async () => {
    const { keeper } = setup();
    await keeper.capture('a', contentsAt(PAGE, [0, 300]));
    const failing = contentsAt(PAGE);
    failing.executeJavaScriptInIsolatedWorld = vi.fn(() => Promise.reject(new Error('gone')));

    await keeper.capture('a', failing);
    await keeper.capture('b', contentsAt('file:///C:/doc.html', [0, 10]));
    await keeper.capture('b', undefined);

    expect(keeper.position('a')).toEqual({ url: PAGE, x: 0, y: 300 });
    expect(keeper.position('b')).toBeUndefined();
  });

  it('puts a restored tab back once, on its first load, and only on the same address', () => {
    const { keeper } = setup({
      tabs: { a: { url: PAGE, x: 0, y: 1500 }, b: { url: PAGE, x: 5, y: 9 } },
    });
    const a = contentsAt(PAGE);
    const elsewhere = contentsAt('https://example.com/other');

    keeper.loaded('a', a);
    keeper.loaded('a', a);
    keeper.loaded('b', elsewhere);
    keeper.loaded('b', contentsAt(PAGE));

    expect(a.scripts).toEqual(['window.scrollTo(0, 1500); true']);
    // b's first load was elsewhere: it is not put back later.
    expect(elsewhere.scripts).toEqual([]);
  });

  it('writes only tabs that still exist, and forgets a closed one', async () => {
    const { keeper, writes } = setup(null, ['a']);
    await keeper.capture('a', contentsAt(PAGE, [0, 10]));
    await keeper.capture('gone', contentsAt(PAGE, [0, 20]));
    await keeper.flush();

    expect(writes.at(-1)).toEqual({
      key: SCROLL_DOCUMENT,
      value: { tabs: { a: { url: PAGE, x: 0, y: 10 } } },
    });

    keeper.forget('a');
    await keeper.flush();
    expect(writes.at(-1)).toEqual({ key: SCROLL_DOCUMENT, value: { tabs: {} } });
  });

  it('at quit, reads the selected tab before it writes', async () => {
    const { keeper, writes } = setup();

    await keeper.flush({ tabId: 'b', contents: contentsAt(PAGE, [0, 42]) });

    expect(writes).toEqual([
      { key: SCROLL_DOCUMENT, value: { tabs: { b: { url: PAGE, x: 0, y: 42 } } } },
    ]);
  });

  it('writes nothing when nothing changed', async () => {
    const { keeper, writes } = setup({ tabs: { a: { url: PAGE, x: 0, y: 1 } } });

    await keeper.flush();

    expect(writes).toEqual([]);
  });
});

describe('parseScrollDocument', () => {
  it('keeps the usable entries and drops the rest alone', () => {
    const positions = parseScrollDocument({
      tabs: {
        good: { url: PAGE, x: 0, y: 10 },
        fraction: { url: PAGE, x: 0, y: 1.5 },
        negative: { url: PAGE, x: -1, y: 0 },
        noUrl: { x: 0, y: 0 },
        text: 'nope',
        // A document from before the rule, or a damaged one: an address the session would cut.
        token: { url: 'https://example.com/app#access_token=SECRET', x: 0, y: 10 },
        credentials: { url: 'https://alice:pw@example.com/', x: 0, y: 10 },
      },
    });

    expect([...positions.keys()]).toEqual(['good']);
  });

  it.each([null, 'x', [], { tabs: [] }, { tabs: null }])('is empty for %j', (stored) => {
    expect(parseScrollDocument(stored).size).toBe(0);
  });

  it(`keeps at most ${String(MAX_SCROLL_TABS)}`, () => {
    const tabs = Object.fromEntries(
      Array.from({ length: MAX_SCROLL_TABS + 5 }, (_, n) => [
        `t${String(n)}`,
        { url: PAGE, x: 0, y: n },
      ]),
    );
    expect(parseScrollDocument({ tabs }).size).toBe(MAX_SCROLL_TABS);
  });
});
