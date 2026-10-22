import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../core/id/uuidv7';
import { VISIT_TRANSITIONS } from '../../core/search/frecency';
import type { VisitTransition } from '../../core/search/frecency';
import { historyUrl } from '../../core/url/hygiene';
import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type { DataErrorCode, DataMethod } from '../../shared/contracts/data-rpc';
import { DataClientError } from '../persistence/data-client';
import { FAVICON_CACHE_SIZE, HistoryRecorder, TITLE_DEBOUNCE_MS } from './history-recorder';

const T0 = 1_700_000_000_000;
const TAB_A = uuidv7(T0, new Uint8Array(10).fill(1));
const TAB_B = uuidv7(T0, new Uint8Array(10).fill(2));

interface Call {
  readonly method: string;
  readonly input: unknown;
}

type Responder = (method: DataMethod, input: unknown) => unknown;

/**
 * A recorder over a fake data client that, like the real one, refuses input its method's schema
 * refuses. `respond` answers a call with a value, a promise, or throws what the client rejects with.
 */
function setup(respond: Responder = () => undefined) {
  const calls: Call[] = [];
  const memory = { recording: true };
  let nextPageId = 1;
  const faviconIds = new Map<string, number>();
  const clock = { now: T0 };
  const call = vi.fn((method: DataMethod, input: unknown) => {
    DATA_METHODS[method].input.parse(input);
    calls.push({ method, input });
    try {
      const answer = respond(method, input);
      if (answer !== undefined) {
        return Promise.resolve(answer);
      }
      if (method === 'history.recordVisit') {
        const pageId = nextPageId;
        nextPageId += 1;
        return Promise.resolve({ pageId });
      }
      if (method === 'favicons.put') {
        // The worker stores each distinct icon once, by its bytes, and answers with its row.
        const { bytes } = input as { bytes: string };
        let id = faviconIds.get(bytes);
        if (id === undefined) {
          id = faviconIds.size + 1;
          faviconIds.set(bytes, id);
        }
        return Promise.resolve({ id });
      }
      return Promise.resolve({ count: 1 });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('failed'));
    }
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  const recorder = new HistoryRecorder({
    data: { call: call as never },
    logger,
    now: () => clock.now,
    recording: () => memory.recording,
  });
  const of = (method: string) =>
    calls.filter((entry) => entry.method === method).map((e) => e.input);
  return {
    recorder,
    calls,
    call,
    logger,
    clock,
    /** "Pause memory" (M5.1): what the settings say now. */
    memory,
    visits: () =>
      of('history.recordVisit') as { page: Record<string, string>; [key: string]: unknown }[],
    updates: () => of('history.updatePage') as { pageId: number; title?: string }[],
    puts: () => of('favicons.put') as { bytes: string; mime: string; at: number }[],
    iconUpdates: () =>
      (of('history.updatePage') as { pageId: number; faviconId?: number }[]).filter(
        (update) => update.faviconId !== undefined,
      ),
  };
}

const commit = (
  url: string,
  options: { sameDocument?: boolean; transition?: VisitTransition } = {},
) => ({
  url,
  sameDocument: options.sameDocument ?? false,
  transition: options.transition ?? 'link',
});

/** Lets every promise the recorder started settle, without moving the clock. */
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HistoryRecorder: a commit', () => {
  it('records a visit for a cross-document commit, with the page, transition, tab and time', async () => {
    const { recorder, visits, clock } = setup();
    clock.now = T0 + 123;

    recorder.committed(TAB_A, commit('https://www.example.com/a?x=1#top', { transition: 'typed' }));
    await settle();

    expect(visits()).toEqual([
      {
        page: {
          urlKey: 'https://www.example.com/a?x=1',
          url: 'https://www.example.com/a?x=1#top',
          host: 'www.example.com',
          site: 'example.com',
          title: '',
        },
        transition: 'typed',
        visitedAt: T0 + 123,
        tabId: TAB_A,
      },
    ]);
  });

  it('builds the page from URL hygiene, with an empty title whatever the page is called', async () => {
    const { recorder, visits } = setup();
    const url = 'https://shop.example.co.uk/p?id=7&utm_source=mail&token=secret#reviews';

    recorder.committed(TAB_A, commit(url));
    await settle();

    expect(visits()[0]?.page).toEqual({ ...historyUrl(url), title: '' });
    expect(visits()[0]?.page).toMatchObject({
      urlKey: 'https://shop.example.co.uk/p?id=7',
      url: 'https://shop.example.co.uk/p?id=7&utm_source=mail#reviews',
      site: 'example.co.uk',
    });
    expect(JSON.stringify(visits())).not.toContain('secret');
  });

  it.each(VISIT_TRANSITIONS)('passes the %s transition through', async (transition) => {
    const { recorder, visits } = setup();

    recorder.committed(TAB_A, commit('https://example.com/', { transition }));
    await settle();

    expect(visits()[0]).toMatchObject({ transition });
  });

  it('reads the clock at the commit, not when the write goes out', async () => {
    const { recorder, visits, clock } = setup();

    clock.now = T0 + 10;
    recorder.committed(TAB_A, commit('https://example.com/one'));
    clock.now = T0 + 5000;
    recorder.committed(TAB_A, commit('https://example.com/two'));
    await settle();

    expect(visits().map((visit) => visit.visitedAt)).toEqual([T0 + 10, T0 + 5000]);
  });

  it('records each commit of a tab: a reload and a revisit of the same address too', async () => {
    const { recorder, visits } = setup();

    recorder.committed(TAB_A, commit('https://example.com/a'));
    recorder.committed(TAB_A, commit('https://example.com/a', { transition: 'reload' }));
    recorder.committed(TAB_A, commit('https://example.com/a#section'));
    await settle();

    expect(visits()).toHaveLength(3);
  });

  it('keeps tabs apart: each commit carries its own tab', async () => {
    const { recorder, visits } = setup();

    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.committed(TAB_B, commit('https://b.example/'));
    await settle();

    expect(visits().map((visit) => visit.tabId)).toEqual([TAB_A, TAB_B]);
  });

  it('sends the visit before anything else, in one call', async () => {
    const { recorder, calls } = setup();

    recorder.committed(TAB_A, commit('https://example.com/'));
    await settle();

    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });
});

describe('HistoryRecorder: a same-document commit', () => {
  it('is not a visit when only the fragment changed', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('https://example.com/a#one'));

    recorder.committed(TAB_A, commit('https://example.com/a#two', { sameDocument: true }));
    recorder.committed(TAB_A, commit('https://example.com/a', { sameDocument: true }));
    await settle();

    expect(visits()).toHaveLength(1);
  });

  it('is not a visit when only a tracking parameter changed', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('https://example.com/a?id=1&utm_source=a'));

    recorder.committed(
      TAB_A,
      commit('https://example.com/a?id=1&utm_source=b&fbclid=x', { sameDocument: true }),
    );
    await settle();

    expect(visits()).toHaveLength(1);
  });

  it('is a visit when the path changed, as a single-page app navigates', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('https://app.example/inbox'));

    recorder.committed(TAB_A, commit('https://app.example/sent', { sameDocument: true }));
    await settle();

    expect(visits().map((visit) => visit.page.urlKey)).toEqual([
      'https://app.example/inbox',
      'https://app.example/sent',
    ]);
  });

  it('is a visit when the query changed', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('https://app.example/list?page=1'));

    recorder.committed(TAB_A, commit('https://app.example/list?page=2', { sameDocument: true }));
    await settle();

    expect(visits()).toHaveLength(2);
  });

  it('carries its own transition', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('https://app.example/a'));

    recorder.committed(
      TAB_A,
      commit('https://app.example/b', { sameDocument: true, transition: 'back_forward' }),
    );
    await settle();

    expect(visits()[1]).toMatchObject({ transition: 'back_forward' });
  });

  it('compares with the page of the latest commit, not the first one', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('https://app.example/a'));
    recorder.committed(TAB_A, commit('https://app.example/b', { sameDocument: true }));

    recorder.committed(TAB_A, commit('https://app.example/b#x', { sameDocument: true }));
    recorder.committed(TAB_A, commit('https://app.example/a', { sameDocument: true }));
    await settle();

    expect(visits().map((visit) => visit.page.urlKey)).toEqual([
      'https://app.example/a',
      'https://app.example/b',
      'https://app.example/a',
    ]);
  });

  it('is a visit for a tab with no earlier commit', async () => {
    const { recorder, visits } = setup();

    recorder.committed(TAB_A, commit('https://app.example/a', { sameDocument: true }));
    await settle();

    expect(visits()).toHaveLength(1);
  });

  it('is judged per tab: another tab at the same address does not hide it', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('https://app.example/a'));

    recorder.committed(TAB_B, commit('https://app.example/a', { sameDocument: true }));
    await settle();

    expect(visits()).toHaveLength(2);
  });

  it('is a visit when the tab was somewhere unrecordable before', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('file:///C:/page.html'));

    recorder.committed(TAB_A, commit('https://app.example/a', { sameDocument: true }));
    await settle();

    expect(visits()).toHaveLength(1);
  });
});

describe('HistoryRecorder: addresses that are not recorded', () => {
  it.each([
    ['an OAuth callback with a code', 'https://app.example/cb?code=abc&state=xyz'],
    ['an OAuth token in the fragment', 'https://app.example/cb#access_token=abc&token_type=bearer'],
    ['a file: page', 'file:///C:/Users/me/page.html'],
    ['a data: page', 'data:text/html,<title>x</title>'],
    ['about:blank', 'about:blank'],
    ['a javascript: address', 'javascript:alert(1)'],
    ['an address with credentials', 'https://user:secret@example.com/'],
    ['an address that is not one', 'not a url'],
  ])('sends nothing for %s', async (_what, url) => {
    const { recorder, calls } = setup();

    recorder.committed(TAB_A, commit(url));
    await settle();

    expect(calls).toEqual([]);
  });

  it('sends no title for it, however long the page stays', async () => {
    const { recorder, calls } = setup();
    recorder.committed(TAB_A, commit('https://app.example/cb?code=abc&state=xyz'));

    recorder.titleChanged(TAB_A, 'Signing you in');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 3);
    recorder.closed(TAB_A);
    await settle();

    expect(calls).toEqual([]);
  });

  it('sends no icon change for it either', async () => {
    const { recorder, calls } = setup();
    recorder.committed(TAB_A, commit('file:///C:/page.html'));

    recorder.faviconChanged(TAB_A, 'data:image/png;base64,AAAA');
    await settle();

    expect(calls).toEqual([]);
  });

  it('forgets the page it was on: titles of the page left go to it, and none go to the callback', async () => {
    const { recorder, visits, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/start'));
    recorder.titleChanged(TAB_A, 'Start page');

    recorder.committed(TAB_A, commit('https://app.example/cb?code=abc&state=xyz'));
    recorder.titleChanged(TAB_A, 'Callback');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 2);

    expect(visits()).toHaveLength(1);
    expect(updates()).toEqual([{ pageId: 1, title: 'Start page' }]);
  });

  it('records the next page after one that was refused', async () => {
    const { recorder, visits, updates } = setup();
    recorder.committed(TAB_A, commit('file:///C:/page.html'));

    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.titleChanged(TAB_A, 'Example');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(visits()).toHaveLength(1);
    expect(updates()).toEqual([{ pageId: 1, title: 'Example' }]);
  });

  it('is judged on the cleaned address: a page that only looks like a callback is recorded', async () => {
    const { recorder, visits } = setup();

    recorder.committed(TAB_A, commit('https://shop.example/p?code=SAVE10'));
    await settle();

    expect(visits()).toHaveLength(1);
  });
});

describe('HistoryRecorder: Pause memory (M5.1)', () => {
  it('records no visit, title or icon while the memory is paused', async () => {
    const { recorder, calls, memory } = setup();
    memory.recording = false;

    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.titleChanged(TAB_A, 'Example');
    recorder.faviconChanged(TAB_A, 'data:image/png;base64,iVBORw0KGgo=');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 3);

    expect(calls).toEqual([]);
  });

  it('records the next commit once the memory is resumed, and nothing of the page seen while paused', async () => {
    const { recorder, memory, visits, updates } = setup();
    memory.recording = false;
    recorder.committed(TAB_A, commit('https://paused.example/'));
    memory.recording = true;
    recorder.titleChanged(TAB_A, 'Seen while paused');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 2);

    recorder.committed(TAB_A, commit('https://resumed.example/'));
    await settle();

    expect(visits().map((visit) => visit.page.url)).toEqual(['https://resumed.example/']);
    expect(updates()).toEqual([]);
  });

  it('still writes the title of the page left, recorded before the pause', async () => {
    const { recorder, memory, updates } = setup();
    recorder.committed(TAB_A, commit('https://before.example/'));
    await settle();
    recorder.titleChanged(TAB_A, 'Before the pause');
    memory.recording = false;

    recorder.committed(TAB_A, commit('https://paused.example/'));
    await settle();

    expect(updates()).toEqual([{ pageId: 1, title: 'Before the pause' }]);
  });
});

describe('HistoryRecorder: titles', () => {
  it('writes a title once it has been stable for 2 s, to the page the tab is on', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));
    await settle();

    recorder.titleChanged(TAB_A, 'Example Domain');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS - 1);
    expect(updates()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(updates()).toEqual([{ pageId: 1, title: 'Example Domain' }]);
  });

  it('waits 2 s, as the contract says', () => {
    expect(TITLE_DEBOUNCE_MS).toBe(2000);
  });

  it('writes a title that changes again and again once, and the last one', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));

    for (let count = 1; count <= 10; count += 1) {
      recorder.titleChanged(TAB_A, `(${String(count)}) Inbox`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(updates()).toEqual([]);
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(updates()).toEqual([{ pageId: 1, title: '(10) Inbox' }]);
  });

  it('restarts the wait with each change', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));

    recorder.titleChanged(TAB_A, 'First');
    await vi.advanceTimersByTimeAsync(1500);
    recorder.titleChanged(TAB_A, 'Second');
    await vi.advanceTimersByTimeAsync(1999);
    expect(updates()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(updates()).toEqual([{ pageId: 1, title: 'Second' }]);
  });

  it('writes again for a title that settles after a write', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));

    recorder.titleChanged(TAB_A, 'One');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);
    recorder.titleChanged(TAB_A, 'Two');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(updates()).toEqual([
      { pageId: 1, title: 'One' },
      { pageId: 1, title: 'Two' },
    ]);
  });

  it('writes nothing more once the title is written, however long the page stays', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.titleChanged(TAB_A, 'Once');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(updates()).toHaveLength(1);
  });

  it('ignores an empty title, and keeps the one waiting', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));

    recorder.titleChanged(TAB_A, 'Waiting');
    await vi.advanceTimersByTimeAsync(1000);
    recorder.titleChanged(TAB_A, '');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(updates()).toEqual([{ pageId: 1, title: 'Waiting' }]);
  });

  it('writes nothing for a title that is only empty', async () => {
    const { recorder, calls } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));
    await settle();
    calls.length = 0;

    recorder.titleChanged(TAB_A, '');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 2);

    expect(calls).toEqual([]);
  });

  it('keeps a title that is only spaces, as it is the page’s own (the shell already cleaned it)', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));

    recorder.titleChanged(TAB_A, ' ');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(updates()).toEqual([{ pageId: 1, title: ' ' }]);
  });

  it('ignores a title for a tab that has not committed anything', async () => {
    const { recorder, calls } = setup();

    recorder.titleChanged(TAB_A, 'Nothing yet');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 2);

    expect(calls).toEqual([]);
  });

  it('keeps tabs apart: each title goes to its own tab’s page', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.committed(TAB_B, commit('https://b.example/'));

    recorder.titleChanged(TAB_B, 'Title B');
    recorder.titleChanged(TAB_A, 'Title A');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(updates()).toEqual(
      expect.arrayContaining([
        { pageId: 2, title: 'Title B' },
        { pageId: 1, title: 'Title A' },
      ]),
    );
    expect(updates()).toHaveLength(2);
  });

  it('does not let one tab’s changes restart another tab’s wait', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.committed(TAB_B, commit('https://b.example/'));

    recorder.titleChanged(TAB_A, 'Title A');
    await vi.advanceTimersByTimeAsync(1500);
    recorder.titleChanged(TAB_B, 'Title B');
    await vi.advanceTimersByTimeAsync(500);

    expect(updates()).toEqual([{ pageId: 1, title: 'Title A' }]);
  });

  it('waits for the visit to come back with its page id before it writes the title', async () => {
    let answer: (value: { pageId: number }) => void = () => undefined;
    const { recorder, updates } = setup((method) =>
      method === 'history.recordVisit'
        ? new Promise<{ pageId: number }>((resolve) => {
            answer = resolve;
          })
        : undefined,
    );
    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.titleChanged(TAB_A, 'Slow database');

    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);
    expect(updates()).toEqual([]);

    answer({ pageId: 42 });
    await settle();
    expect(updates()).toEqual([{ pageId: 42, title: 'Slow database' }]);
  });

  it('writes no title for a page the memory refused: an excluded site has no page id', async () => {
    const { recorder, updates, calls } = setup((method) =>
      method === 'history.recordVisit' ? { pageId: null } : undefined,
    );
    recorder.committed(TAB_A, commit('https://private.example/'));

    recorder.titleChanged(TAB_A, 'Secret');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);
    recorder.closed(TAB_A);
    await settle();

    expect(updates()).toEqual([]);
    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });

  it('writes no title for a page whose visit failed', async () => {
    const { recorder, updates } = setup((method) => {
      if (method === 'history.recordVisit') {
        throw new DataClientError('sqlite', 'SQLITE_FULL');
      }
      return undefined;
    });
    recorder.committed(TAB_A, commit('https://example.com/'));

    recorder.titleChanged(TAB_A, 'Lost');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(updates()).toEqual([]);
  });
});

describe('HistoryRecorder: a title waiting when the page is left', () => {
  it('is written to the page it belongs to, at the next commit, not 2 s later', async () => {
    const { recorder, updates, visits } = setup();
    recorder.committed(TAB_A, commit('https://example.com/one'));
    recorder.titleChanged(TAB_A, 'Title of one');
    await vi.advanceTimersByTimeAsync(500);

    recorder.committed(TAB_A, commit('https://example.com/two'));
    await settle();

    expect(updates()).toEqual([{ pageId: 1, title: 'Title of one' }]);
    expect(visits()).toHaveLength(2);
  });

  it('is not written a second time when the wait would have ended', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/one'));
    recorder.titleChanged(TAB_A, 'Title of one');
    recorder.committed(TAB_A, commit('https://example.com/two'));

    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 3);

    expect(updates()).toEqual([{ pageId: 1, title: 'Title of one' }]);
  });

  it('is never given to the page that was arrived at', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/one'));
    recorder.titleChanged(TAB_A, 'Title of one');

    recorder.committed(TAB_A, commit('https://example.com/two'));
    recorder.titleChanged(TAB_A, 'Title of two');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(updates()).toEqual([
      { pageId: 1, title: 'Title of one' },
      { pageId: 2, title: 'Title of two' },
    ]);
  });

  it('goes to the page that was left when a single-page app navigates, too', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://app.example/inbox'));
    recorder.titleChanged(TAB_A, 'Inbox');

    recorder.committed(TAB_A, commit('https://app.example/sent', { sameDocument: true }));
    await settle();

    expect(updates()).toEqual([{ pageId: 1, title: 'Inbox' }]);
  });

  it('stays waiting through a same-document commit that is not a new page', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://app.example/inbox'));
    recorder.titleChanged(TAB_A, 'Inbox');
    await vi.advanceTimersByTimeAsync(1000);

    recorder.committed(TAB_A, commit('https://app.example/inbox#x', { sameDocument: true }));
    await vi.advanceTimersByTimeAsync(999);
    expect(updates()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(updates()).toEqual([{ pageId: 1, title: 'Inbox' }]);
  });

  it('is written when the tab is closed, to its page, at once', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.titleChanged(TAB_A, 'Closing soon');

    recorder.closed(TAB_A);
    await settle();

    expect(updates()).toEqual([{ pageId: 1, title: 'Closing soon' }]);
  });

  it('is not written twice for a tab that was closed', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.titleChanged(TAB_A, 'Closing soon');
    recorder.closed(TAB_A);

    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 3);

    expect(updates()).toHaveLength(1);
  });

  it('is only the title that is waiting: a closed tab with none sends nothing', async () => {
    const { recorder, calls } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.titleChanged(TAB_A, 'Written');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);
    calls.length = 0;

    recorder.closed(TAB_A);
    await settle();

    expect(calls).toEqual([]);
  });

  it('is only for the tab that closed: another tab keeps waiting', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.committed(TAB_B, commit('https://b.example/'));
    recorder.titleChanged(TAB_A, 'A');
    recorder.titleChanged(TAB_B, 'B');

    recorder.closed(TAB_A);
    await settle();
    expect(updates()).toEqual([{ pageId: 1, title: 'A' }]);

    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);
    expect(updates()).toEqual([
      { pageId: 1, title: 'A' },
      { pageId: 2, title: 'B' },
    ]);
  });
});

describe('HistoryRecorder: a tab that closed', () => {
  it('ignores its later titles', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.closed(TAB_A);

    recorder.titleChanged(TAB_A, 'Too late');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 2);

    expect(updates()).toEqual([]);
  });

  it('takes closing a tab it never heard of, and one that is closed twice', async () => {
    const { recorder, calls } = setup();

    expect(() => {
      recorder.closed(TAB_A);
      recorder.committed(TAB_B, commit('https://b.example/'));
      recorder.closed(TAB_B);
      recorder.closed(TAB_B);
    }).not.toThrow();
    await settle();

    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });

  it('starts from nothing if the same tab id commits again: no key to compare a same-document commit with', async () => {
    const { recorder, visits } = setup();
    recorder.committed(TAB_A, commit('https://example.com/a'));
    recorder.closed(TAB_A);

    recorder.committed(TAB_A, commit('https://example.com/a', { sameDocument: true }));
    await settle();

    expect(visits()).toHaveLength(2);
  });
});

describe('HistoryRecorder: flush', () => {
  it('writes the titles still waiting, for every tab', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.committed(TAB_B, commit('https://b.example/'));
    recorder.titleChanged(TAB_A, 'Title A');
    recorder.titleChanged(TAB_B, 'Title B');

    await recorder.flush();

    expect(updates()).toEqual(
      expect.arrayContaining([
        { pageId: 1, title: 'Title A' },
        { pageId: 2, title: 'Title B' },
      ]),
    );
    expect(updates()).toHaveLength(2);
  });

  it('does not write a title twice: the timers are cleared', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.titleChanged(TAB_A, 'Title A');

    await recorder.flush();
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 3);

    expect(updates()).toHaveLength(1);
  });

  it('waits for the calls in flight, which a quitting app needs to land', async () => {
    const releases: (() => void)[] = [];
    const { recorder, updates } = setup((method) =>
      method === 'history.recordVisit'
        ? new Promise<{ pageId: number }>((resolve) => {
            releases.push(() => {
              resolve({ pageId: 7 });
            });
          })
        : new Promise<{ count: number }>((resolve) => {
            releases.push(() => {
              resolve({ count: 1 });
            });
          }),
    );
    recorder.committed(TAB_A, commit('https://example.com/'));
    recorder.titleChanged(TAB_A, 'Pending');

    let done = false;
    const flushing = recorder.flush().then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);

    // The visit lands, and the title write it was waiting for goes out; flush waits for that too.
    releases[0]?.();
    await settle();
    expect(done).toBe(false);
    expect(updates()).toEqual([{ pageId: 7, title: 'Pending' }]);

    releases[1]?.();
    await flushing;
    expect(done).toBe(true);
  });

  it('records nothing more once it has been called', async () => {
    const { recorder, calls } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    await recorder.flush();
    calls.length = 0;

    recorder.committed(TAB_A, commit('https://a.example/next'));
    recorder.committed(TAB_B, commit('https://b.example/'));
    recorder.titleChanged(TAB_A, 'After quit');
    recorder.faviconChanged(TAB_A, 'data:image/png;base64,AAAA');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS * 2);

    expect(calls).toEqual([]);
  });

  it('returns at once when there is nothing to write', async () => {
    const { recorder, calls } = setup();

    await expect(recorder.flush()).resolves.toBeUndefined();

    expect(calls).toEqual([]);
  });

  it('can be called twice', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.titleChanged(TAB_A, 'Once');

    await recorder.flush();
    await recorder.flush();

    expect(updates()).toHaveLength(1);
  });

  it('returns even when the calls it waits for fail, and says nothing for a database that is gone', async () => {
    const { recorder, logger } = setup(() => {
      throw new DataClientError('closed');
    });
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.titleChanged(TAB_A, 'Title');

    await expect(recorder.flush()).resolves.toBeUndefined();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('writes the title of a tab that closed before it, and not again', async () => {
    const { recorder, updates } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.titleChanged(TAB_A, 'Title');
    recorder.closed(TAB_A);

    await recorder.flush();

    expect(updates()).toEqual([{ pageId: 1, title: 'Title' }]);
  });
});

describe('HistoryRecorder: when a write fails', () => {
  const UNAVAILABLE: DataErrorCode[] = [
    'closed',
    'worker_gone',
    'open_failed',
    'db_newer',
    'db_foreign',
    'migration_failed',
  ];
  const LOGGED: DataErrorCode[] = [
    'sqlite',
    'timeout',
    'busy',
    'invalid_input',
    'internal',
    'invalid_output',
  ];

  const failing = (method: DataMethod, code: DataErrorCode) => (called: DataMethod) => {
    if (called === method) {
      throw new DataClientError(code, 'SQLITE_FULL');
    }
    return undefined;
  };

  it.each(UNAVAILABLE)(
    'says nothing about a visit when the database is not there (%s)',
    async (code) => {
      const { recorder, logger } = setup(failing('history.recordVisit', code));

      recorder.committed(TAB_A, commit('https://example.com/'));
      await settle();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it.each(UNAVAILABLE)(
    'says nothing about a title when the database is not there (%s)',
    async (code) => {
      const { recorder, logger } = setup(failing('history.updatePage', code));
      recorder.committed(TAB_A, commit('https://example.com/'));

      recorder.titleChanged(TAB_A, 'Title');
      await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each(LOGGED)('logs a failed visit by its method and code (%s)', async (code) => {
    const { recorder, logger } = setup(failing('history.recordVisit', code));

    recorder.committed(TAB_A, commit('https://example.com/'));
    await settle();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('history.writeFailed', {
      method: 'history.recordVisit',
      code,
    });
  });

  it.each(LOGGED)('logs a failed title write by its method and code (%s)', async (code) => {
    const { recorder, logger } = setup(failing('history.updatePage', code));
    recorder.committed(TAB_A, commit('https://example.com/'));

    recorder.titleChanged(TAB_A, 'Title');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('history.writeFailed', {
      method: 'history.updatePage',
      code,
    });
  });

  it('logs an error that is not the client’s as internal', async () => {
    const { recorder, logger } = setup(() => {
      throw new Error('boom: https://example.com/?token=secret');
    });

    recorder.committed(TAB_A, commit('https://example.com/'));
    await settle();

    expect(logger.warn).toHaveBeenCalledWith('history.writeFailed', {
      method: 'history.recordVisit',
      code: 'internal',
    });
  });

  it('never puts an address, a title, or the error’s message or detail in the log', async () => {
    const { recorder, logger } = setup(() => {
      throw new DataClientError('sqlite', 'SQLITE_FULL https://example.com/secret-path');
    });

    recorder.committed(TAB_A, commit('https://example.com/secret-path'));
    recorder.titleChanged(TAB_A, 'A Very Private Title');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain('secret-path');
    expect(logged).not.toContain('Private');
    expect(logged).not.toContain('SQLITE_FULL');
    expect(logged).not.toContain('example.com');
  });

  it('never throws into the caller, from a commit, a title, a close or a flush', async () => {
    const { recorder } = setup(() => {
      throw new DataClientError('sqlite');
    });

    expect(() => {
      recorder.committed(TAB_A, commit('https://example.com/'));
      recorder.titleChanged(TAB_A, 'Title');
      recorder.committed(TAB_A, commit('https://example.com/two'));
      recorder.closed(TAB_A);
    }).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
    await settle();
  });

  it('goes on recording after a failure: the next visit is sent', async () => {
    let failures = 1;
    const { recorder, visits } = setup((method) => {
      if (method === 'history.recordVisit' && failures > 0) {
        failures -= 1;
        throw new DataClientError('timeout');
      }
      return undefined;
    });

    recorder.committed(TAB_A, commit('https://example.com/one'));
    recorder.committed(TAB_A, commit('https://example.com/two'));
    await settle();

    expect(visits()).toHaveLength(2);
  });

  it('logs one line for each failed write, and none for those that went through', async () => {
    const { recorder, logger } = setup(failing('history.updatePage', 'sqlite'));

    recorder.committed(TAB_A, commit('https://example.com/one'));
    recorder.titleChanged(TAB_A, 'One');
    recorder.committed(TAB_A, commit('https://example.com/two'));
    recorder.titleChanged(TAB_A, 'Two');
    await vi.advanceTimersByTimeAsync(TITLE_DEBOUNCE_MS);

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('HistoryRecorder: icons', () => {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  /** A `data:` URL of an image that is a PNG as far as its bytes say; `n` makes it a different one. */
  const pngUrl = (n = 0): string =>
    `data:image/png;base64,${Buffer.from([...PNG_SIGNATURE, n >> 8, n & 255]).toString('base64')}`;
  const base64Of = (bytes: number[]): string => Buffer.from(bytes).toString('base64');
  const urlOf = (type: string, bytes: number[]): string => `data:${type};base64,${base64Of(bytes)}`;

  const withPage = async (respond?: Responder) => {
    const world = setup(respond);
    world.recorder.committed(TAB_A, commit('https://example.com/'));
    await settle();
    return world;
  };

  it('stores the icon once, and points the page at it', async () => {
    const { recorder, puts, iconUpdates, clock } = await withPage();
    clock.now = T0 + 77;

    recorder.faviconChanged(TAB_A, pngUrl(1));
    await settle();

    expect(puts()).toEqual([
      {
        bytes: base64Of([...PNG_SIGNATURE, 0, 1]),
        mime: 'image/png',
        at: T0 + 77,
      },
    ]);
    expect(iconUpdates()).toEqual([{ pageId: 1, faviconId: 1 }]);
  });

  it('sends the bytes of the image and the type they say they are, not what the URL declares', async () => {
    const { recorder, puts } = await withPage();

    recorder.faviconChanged(TAB_A, urlOf('image/png', [...Buffer.from('GIF89a'), 1, 2, 3]));
    await settle();

    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ mime: 'image/gif' });
  });

  it.each([
    ['a PNG', 'image/png', PNG_SIGNATURE],
    ['a GIF', 'image/gif', [...Buffer.from('GIF87a'), 1]],
    ['a JPEG', 'image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 1, 2]],
    ['an ICO', 'image/x-icon', [0, 0, 1, 0, 1, 0, 16, 16]],
    ['a WebP', 'image/webp', [...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBP')]],
  ])('stores %s as %s', async (_what, mime, bytes) => {
    const { recorder, puts, iconUpdates } = await withPage();

    recorder.faviconChanged(TAB_A, urlOf(mime, bytes));
    await settle();

    expect(puts()).toEqual([{ bytes: base64Of(bytes), mime, at: T0 }]);
    expect(iconUpdates()).toHaveLength(1);
  });

  it('stores an icon once however often it is seen, and points the page at it each time', async () => {
    const { recorder, puts, iconUpdates } = await withPage();

    recorder.faviconChanged(TAB_A, pngUrl(1));
    recorder.faviconChanged(TAB_A, pngUrl(1));
    await settle();
    recorder.faviconChanged(TAB_A, pngUrl(1));
    await settle();

    expect(puts()).toHaveLength(1);
    expect(iconUpdates()).toEqual([
      { pageId: 1, faviconId: 1 },
      { pageId: 1, faviconId: 1 },
      { pageId: 1, faviconId: 1 },
    ]);
  });

  it('stores an icon of two tabs once, and points both pages at it', async () => {
    const { recorder, puts, iconUpdates } = setup();
    recorder.committed(TAB_A, commit('https://a.example/'));
    recorder.committed(TAB_B, commit('https://b.example/'));

    recorder.faviconChanged(TAB_A, pngUrl(1));
    recorder.faviconChanged(TAB_B, pngUrl(1));
    await settle();

    expect(puts()).toHaveLength(1);
    expect(iconUpdates()).toEqual([
      { pageId: 1, faviconId: 1 },
      { pageId: 2, faviconId: 1 },
    ]);
  });

  it('stores different icons as different rows', async () => {
    const { recorder, puts, iconUpdates } = await withPage();

    recorder.faviconChanged(TAB_A, pngUrl(1));
    recorder.faviconChanged(TAB_A, pngUrl(2));
    await settle();

    expect(puts()).toHaveLength(2);
    expect(iconUpdates().map((update) => update.faviconId)).toEqual([1, 2]);
  });

  it('gives an icon to the page the tab is on when it arrives, not the page it was on before', async () => {
    const { recorder, iconUpdates } = await withPage();
    recorder.committed(TAB_A, commit('https://example.com/two'));

    recorder.faviconChanged(TAB_A, pngUrl(1));
    await settle();

    expect(iconUpdates()).toEqual([{ pageId: 2, faviconId: 1 }]);
  });

  it('waits for the visit to come back with its page id', async () => {
    let answer: (value: { pageId: number }) => void = () => undefined;
    const { recorder, puts, iconUpdates } = setup((method) =>
      method === 'history.recordVisit'
        ? new Promise<{ pageId: number }>((resolve) => {
            answer = resolve;
          })
        : undefined,
    );
    recorder.committed(TAB_A, commit('https://example.com/'));

    recorder.faviconChanged(TAB_A, pngUrl(1));
    await settle();
    expect(puts()).toEqual([]);

    answer({ pageId: 31 });
    await settle();
    expect(puts()).toHaveLength(1);
    expect(iconUpdates()).toEqual([{ pageId: 31, faviconId: 1 }]);
  });

  it('stores nothing for a page the memory refused: an excluded site has no page id', async () => {
    const { recorder, calls } = await withPage((method) =>
      method === 'history.recordVisit' ? { pageId: null } : undefined,
    );

    recorder.faviconChanged(TAB_A, pngUrl(1));
    await settle();

    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });

  it('stores nothing for a page whose visit failed', async () => {
    const { recorder, calls } = await withPage((method) => {
      if (method === 'history.recordVisit') {
        throw new DataClientError('sqlite');
      }
      return undefined;
    });

    recorder.faviconChanged(TAB_A, pngUrl(1));
    await settle();

    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });

  it('stores nothing for a tab that has not committed, or one that closed', async () => {
    const { recorder, calls } = setup();

    recorder.faviconChanged(TAB_A, pngUrl(1));
    recorder.committed(TAB_B, commit('https://b.example/'));
    recorder.closed(TAB_B);
    recorder.faviconChanged(TAB_B, pngUrl(1));
    await settle();

    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });

  it.each([
    [
      'an SVG',
      `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    ],
    [
      'an SVG that is percent-encoded',
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
    ],
    ['an HTML page', `data:text/html;base64,${Buffer.from('<html></html>').toString('base64')}`],
    ['text that says it is a PNG', urlOf('image/png', [...Buffer.from('not a png at all')])],
    ['a PNG signature one byte short', urlOf('image/png', PNG_SIGNATURE.slice(0, 7))],
    ['no bytes', 'data:image/png;base64,'],
    ['no data: URL', 'https://example.com/favicon.ico'],
    ['an empty string', ''],
    ['a script', 'javascript:alert(1)'],
  ])('stores nothing for %s', async (_what, url) => {
    const { recorder, calls } = await withPage();

    recorder.faviconChanged(TAB_A, url);
    await settle();

    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });

  it('stores nothing for an icon over 64 KiB, whatever it claims to be', async () => {
    const { recorder, calls } = await withPage();
    const big = [...PNG_SIGNATURE, ...new Array<number>(64 * 1024).fill(7)];

    recorder.faviconChanged(TAB_A, urlOf('image/png', big));
    await settle();

    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });

  it('stores an icon of exactly 64 KiB', async () => {
    const { recorder, puts } = await withPage();
    const exact = [
      ...PNG_SIGNATURE,
      ...new Array<number>(64 * 1024 - PNG_SIGNATURE.length).fill(7),
    ];

    recorder.faviconChanged(TAB_A, urlOf('image/png', exact));
    await settle();

    expect(puts()).toHaveLength(1);
  });

  it('does not ask the worker again about an icon it could not use', async () => {
    const { recorder, calls } = await withPage();

    recorder.faviconChanged(TAB_A, 'data:image/svg+xml,%3Csvg%2F%3E');
    recorder.faviconChanged(TAB_A, 'data:image/svg+xml,%3Csvg%2F%3E');
    await settle();

    expect(calls.map((entry) => entry.method)).toEqual(['history.recordVisit']);
  });

  describe('when storing an icon fails', () => {
    const failFirstPut = (code: DataErrorCode = 'sqlite') => {
      let failures = 1;
      return (method: DataMethod) => {
        if (method === 'favicons.put' && failures > 0) {
          failures -= 1;
          throw new DataClientError(code);
        }
        return undefined;
      };
    };

    it('points the page at nothing, and logs it by its method and code', async () => {
      const { recorder, iconUpdates, logger } = await withPage(failFirstPut('sqlite'));

      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      expect(iconUpdates()).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('history.writeFailed', {
        method: 'favicons.put',
        code: 'sqlite',
      });
    });

    it('tries again the next time the icon is seen', async () => {
      const { recorder, puts, iconUpdates } = await withPage(failFirstPut());
      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      expect(puts()).toHaveLength(2);
      expect(iconUpdates()).toEqual([{ pageId: 1, faviconId: 1 }]);
    });

    it('then remembers it, so a third sight stores nothing more', async () => {
      const { recorder, puts } = await withPage(failFirstPut());
      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();
      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      expect(puts()).toHaveLength(2);
    });

    it('does not stop other icons being stored', async () => {
      const { recorder, iconUpdates } = await withPage(failFirstPut());

      recorder.faviconChanged(TAB_A, pngUrl(1));
      recorder.faviconChanged(TAB_A, pngUrl(2));
      await settle();

      expect(iconUpdates()).toHaveLength(1);
    });

    it.each([
      'closed',
      'worker_gone',
      'open_failed',
      'db_newer',
      'db_foreign',
      'migration_failed',
    ] as const)('says nothing when the database is not there (%s)', async (code) => {
      const { recorder, logger } = await withPage(failFirstPut(code));

      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs a failure to point the page at the icon, by its method and code', async () => {
      const { recorder, logger } = await withPage((method, input) => {
        if (
          method === 'history.updatePage' &&
          (input as { faviconId?: number }).faviconId !== undefined
        ) {
          throw new DataClientError('busy');
        }
        return undefined;
      });

      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      expect(logger.warn).toHaveBeenCalledWith('history.writeFailed', {
        method: 'history.updatePage',
        code: 'busy',
      });
    });

    it('never throws into the caller, and never puts the icon in the log', async () => {
      const { recorder, logger } = await withPage(() => {
        throw new DataClientError('sqlite', pngUrl(1));
      });

      expect(() => {
        recorder.faviconChanged(TAB_A, pngUrl(1));
      }).not.toThrow();
      await settle();

      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('base64');
    });
  });

  describe('the cache of stored icons', () => {
    it('holds 256 icons', () => {
      expect(FAVICON_CACHE_SIZE).toBe(256);
    });

    it('forgets the oldest icon once more than the limit have been stored', async () => {
      const { recorder, puts } = await withPage();
      for (let n = 0; n <= FAVICON_CACHE_SIZE; n += 1) {
        recorder.faviconChanged(TAB_A, pngUrl(n));
      }
      await settle();
      expect(puts()).toHaveLength(FAVICON_CACHE_SIZE + 1);

      // The first icon was the oldest: it is stored (asked about) again. The newest is still known.
      recorder.faviconChanged(TAB_A, pngUrl(FAVICON_CACHE_SIZE));
      await settle();
      expect(puts()).toHaveLength(FAVICON_CACHE_SIZE + 1);

      recorder.faviconChanged(TAB_A, pngUrl(0));
      await settle();
      expect(puts()).toHaveLength(FAVICON_CACHE_SIZE + 2);
    });

    it('still knows every icon up to the limit', async () => {
      const { recorder, puts } = await withPage();
      for (let n = 0; n < FAVICON_CACHE_SIZE; n += 1) {
        recorder.faviconChanged(TAB_A, pngUrl(n));
      }
      await settle();

      for (let n = 0; n < FAVICON_CACHE_SIZE; n += 1) {
        recorder.faviconChanged(TAB_A, pngUrl(n));
      }
      await settle();

      expect(puts()).toHaveLength(FAVICON_CACHE_SIZE);
    });

    it('forgets one icon at a time, as each new one comes in beyond the limit', async () => {
      const { recorder, puts } = await withPage();
      for (let n = 0; n < FAVICON_CACHE_SIZE + 2; n += 1) {
        recorder.faviconChanged(TAB_A, pngUrl(n));
      }
      await settle();
      const stored = puts().length;

      // 0 and 1 are forgotten, 2 is not.
      recorder.faviconChanged(TAB_A, pngUrl(2));
      await settle();
      expect(puts()).toHaveLength(stored);
      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();
      expect(puts()).toHaveLength(stored + 1);
    });

    it('does not count what could not be stored as unknown: an icon that failed is not kept', async () => {
      let fail = true;
      const { recorder, puts } = await withPage((method) => {
        if (method === 'favicons.put' && fail) {
          fail = false;
          throw new DataClientError('sqlite');
        }
        return undefined;
      });

      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();
      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      expect(puts()).toHaveLength(2);
    });
  });

  describe('flush and icons', () => {
    it('waits for an icon being stored', async () => {
      let release: (value: unknown) => void = () => undefined;
      const { recorder, iconUpdates } = await withPage((method) =>
        method === 'favicons.put'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : undefined,
      );
      recorder.faviconChanged(TAB_A, pngUrl(1));
      let done = false;

      const flushing = recorder.flush().then(() => {
        done = true;
      });
      await settle();
      expect(done).toBe(false);

      release({ id: 5 });
      await flushing;
      expect(done).toBe(true);
      expect(iconUpdates()).toEqual([{ pageId: 1, faviconId: 5 }]);
    });

    it('stores no icon seen after it', async () => {
      const { recorder, puts } = await withPage();
      await recorder.flush();

      recorder.faviconChanged(TAB_A, pngUrl(1));
      await settle();

      expect(puts()).toEqual([]);
    });
  });
});
