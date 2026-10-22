// The activity log (assessment §4.13, M3.3): what automation did to a tab, with the rule that decided
// it. It is kept in memory (the newest MAX_ACTIVITY_ENTRIES), written to the `activity` document
// in app_state at most every ACTIVITY_WRITE_DELAY_MS and on quit, and an ephemeral tab's entries
// are never written (I6). The timers are a clock a test moves, `persist` is a fake whose writes a
// test can hold, fail or let through, and the data client is a fake `call`.
//
// Nothing here waits on real time: `advance` moves the manual clock and `flush` lets the promise
// continuations a write sets off run, so "after 10 s one write has started" can be checked exactly.
import { describe, expect, it } from 'vitest';

import type { Timers } from '../../core/lifecycle/discard';
import {
  MAX_ACTIVITY_ADDRESS,
  MAX_ACTIVITY_ENTRIES,
  MAX_ACTIVITY_TITLE,
} from '../../shared/contracts/activity';
import type { ActivityEntry } from '../../shared/contracts/activity';
import { DataClientError } from '../persistence/data-client';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import {
  ACTIVITY_DOCUMENT,
  ACTIVITY_WRITE_DELAY_MS,
  ActivityLog,
  activityWriter,
  parseActivity,
  readStoredActivity,
} from './activity-log';
import type { NewActivityEntry } from './activity-log';

/** Lets every pending microtask run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** The item at `index`, or a failure that says what was missing. */
function pick<T>(list: readonly T[], index: number, what: string): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no ${what} at ${String(index)} (there are ${String(list.length)})`);
  }
  return item;
}

/** Timers on a clock a test moves. */
class ManualTimers implements Timers {
  /** Milliseconds since the test began. */
  now = 0;
  #next = 1;
  readonly #pending = new Map<
    number,
    { readonly callback: () => void; readonly ms: number; readonly due: number }
  >();

  setTimeout(callback: () => void, ms: number): number {
    const handle = this.#next;
    this.#next += 1;
    this.#pending.set(handle, { callback, ms, due: this.now + ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.#pending.delete(handle);
    }
  }

  /** The delays of the timers still pending, the soonest first. */
  get pending(): number[] {
    return [...this.#pending.values()].sort((a, b) => a.due - b.due).map((timer) => timer.ms);
  }

  /** Moves time forward by `ms`, firing the timers that fall due, in order, each at its own time. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await flush();
      const next = [...this.#pending]
        .filter(([, timer]) => timer.due <= target)
        .sort(([handleA, a], [handleB, b]) => a.due - b.due || handleA - handleB)[0];
      if (next === undefined) {
        break;
      }
      const [handle, timer] = next;
      this.#pending.delete(handle);
      this.now = Math.max(this.now, timer.due);
      timer.callback();
    }
    this.now = target;
    await flush();
  }
}

function recordingLogger() {
  const events: { level: 'warn' | 'error'; event: string; fields?: unknown }[] = [];
  const logger: Logger = {
    warn: (event, fields) => {
      events.push({ level: 'warn', event, fields });
    },
    error: (event, fields) => {
      events.push({ level: 'error', event, fields });
    },
  };
  return { logger, events };
}

/** What automation says about a tab, before the log gives it an id. */
function entry(overrides: Partial<NewActivityEntry> = {}): NewActivityEntry {
  return {
    at: 1_000,
    action: 'discard',
    rule: 'discard-hidden',
    pressure: null,
    tabId: 'tab-1',
    title: 'A page',
    address: 'example.com/page',
    batchId: 'batch-1',
    ...overrides,
  };
}

/** An entry as the log stored it. */
const stored = (id: number, overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ...entry({ tabId: `tab-${String(id)}` }),
  id,
  ...overrides,
});

/** Stored entries with ids `from` to `to`, oldest first. */
const storedRange = (from: number, to: number): ActivityEntry[] =>
  Array.from({ length: to - from + 1 }, (_, index) => stored(from + index));

const ids = (entries: readonly ActivityEntry[]): number[] => entries.map((kept) => kept.id);

interface Write {
  /** The list `persist` was given. */
  readonly entries: readonly ActivityEntry[];
  readonly settle: PromiseWithResolvers<undefined>;
}

interface BuildOptions {
  readonly stored?: readonly ActivityEntry[];
  /** True leaves each write for the test to settle. */
  readonly hold?: boolean;
}

function build(options: BuildOptions = {}) {
  const timers = new ManualTimers();
  const { logger, events } = recordingLogger();
  const writes: Write[] = [];
  const state = {
    hold: options.hold ?? false,
    /** How the next writes fail: by rejecting or by throwing at once (a count of each). */
    rejects: 0,
    throws: 0,
  };
  const changes = { count: 0 };
  const log = new ActivityLog({
    stored: options.stored ?? [],
    persist: (entries) => {
      const settle = Promise.withResolvers<undefined>();
      writes.push({ entries: [...entries], settle });
      if (state.throws > 0) {
        state.throws -= 1;
        throw new Error('persist threw at once');
      }
      if (state.rejects > 0) {
        state.rejects -= 1;
        return Promise.reject(new Error('the disk is full'));
      }
      if (!state.hold) {
        settle.resolve(undefined);
      }
      return settle.promise;
    },
    timers,
    logger,
    onChange: () => {
      changes.count += 1;
    },
  });
  return { log, timers, writes, state, events, changes };
}

describe('ActivityLog: ids and entries', () => {
  it('numbers entries from 1, each one more than the last', () => {
    const h = build();
    expect(h.log.add(entry()).id).toBe(1);
    expect(h.log.add(entry()).id).toBe(2);
    expect(h.log.add(entry()).id).toBe(3);
  });

  it('continues after the highest stored id, wherever it is in the list', () => {
    const h = build({ stored: [stored(2), stored(7), stored(5)] });
    expect(h.log.add(entry()).id).toBe(8);
  });

  it('continues after the newest stored id when more than the cap was stored', () => {
    const h = build({ stored: storedRange(1, MAX_ACTIVITY_ENTRIES + 5) });
    expect(h.log.add(entry()).id).toBe(MAX_ACTIVITY_ENTRIES + 6);
  });

  it('gives back the entry as kept, which is the one entries() lists', () => {
    const h = build();
    const kept = h.log.add(entry({ tabId: 'tab-9', action: 'shelve', rule: 'shelve-beyond-cap' }));
    expect(kept).toEqual({
      ...entry({ tabId: 'tab-9', action: 'shelve', rule: 'shelve-beyond-cap' }),
      id: 1,
    });
    expect(h.log.entries()).toEqual([kept]);
  });

  it('lists entries newest first, the stored ones after the new', () => {
    const h = build({ stored: storedRange(1, 2) });
    h.log.add(entry());
    h.log.add(entry());
    expect(ids(h.log.entries())).toEqual([4, 3, 2, 1]);
  });

  it('lists at most `limit` of the newest', () => {
    const h = build({ stored: storedRange(1, 5) });
    expect(ids(h.log.entries(2))).toEqual([5, 4]);
    expect(ids(h.log.entries(5))).toEqual([5, 4, 3, 2, 1]);
    expect(ids(h.log.entries(50))).toEqual([5, 4, 3, 2, 1]);
  });

  it('lists an empty log as empty', () => {
    expect(build().log.entries()).toEqual([]);
  });

  it('returns a new array each time: the caller cannot change the log', () => {
    const h = build({ stored: storedRange(1, 2) });
    const first = h.log.entries();
    first.length = 0;
    expect(ids(h.log.entries())).toEqual([2, 1]);
  });

  it('keeps only the newest MAX_ACTIVITY_ENTRIES of what was stored', () => {
    const h = build({ stored: storedRange(1, MAX_ACTIVITY_ENTRIES + 5) });
    const listed = h.log.entries();
    expect(listed).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(pick(listed, 0, 'entry').id).toBe(MAX_ACTIVITY_ENTRIES + 5);
    expect(pick(listed, MAX_ACTIVITY_ENTRIES - 1, 'entry').id).toBe(6);
  });

  it('drops the oldest entry for each one over MAX_ACTIVITY_ENTRIES', () => {
    const h = build({ stored: storedRange(1, MAX_ACTIVITY_ENTRIES) });
    h.log.add(entry());
    h.log.add(entry());

    const listed = h.log.entries();
    expect(listed).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(ids(listed.slice(0, 2))).toEqual([MAX_ACTIVITY_ENTRIES + 2, MAX_ACTIVITY_ENTRIES + 1]);
    expect(pick(listed, MAX_ACTIVITY_ENTRIES - 1, 'entry').id).toBe(3);
  });

  it('cuts a long title and address, and leaves the rest and a short one alone', () => {
    const h = build();
    const kept = h.log.add(
      entry({
        title: 't'.repeat(MAX_ACTIVITY_TITLE + 50),
        address: 'a'.repeat(MAX_ACTIVITY_ADDRESS + 50),
      }),
    );
    expect(kept.title).toBe('t'.repeat(MAX_ACTIVITY_TITLE));
    expect(kept.address).toBe('a'.repeat(MAX_ACTIVITY_ADDRESS));
    expect(kept).toMatchObject({ tabId: 'tab-1', batchId: 'batch-1', rule: 'discard-hidden' });

    const exact = h.log.add(
      entry({
        title: 't'.repeat(MAX_ACTIVITY_TITLE),
        address: 'a'.repeat(MAX_ACTIVITY_ADDRESS),
      }),
    );
    expect(exact.title).toHaveLength(MAX_ACTIVITY_TITLE);
    expect(exact.address).toHaveLength(MAX_ACTIVITY_ADDRESS);
  });

  it('does not change the entry it was given', () => {
    const h = build();
    const given = entry({ title: 't'.repeat(MAX_ACTIVITY_TITLE + 1) });
    h.log.add(given);
    expect(given.title).toHaveLength(MAX_ACTIVITY_TITLE + 1);
    expect(given).not.toHaveProperty('id');
  });

  it('tells onChange for every entry added, an ephemeral one too, and for nothing else', async () => {
    const h = build();
    h.log.add(entry());
    h.log.add(entry(), { ephemeral: true });
    expect(h.changes.count).toBe(2);

    await h.log.flush();
    h.log.stop();
    h.log.entries();
    expect(h.changes.count).toBe(2);
  });

  it('works without an onChange', () => {
    const { logger } = recordingLogger();
    const log = new ActivityLog({
      stored: [],
      persist: () => Promise.resolve(),
      timers: new ManualTimers(),
      logger,
    });
    expect(log.add(entry()).id).toBe(1);
  });

  it('lists nothing for a limit of 0 or less (slice(-0) would be everything)', () => {
    const { log } = build({ stored: storedRange(1, 5) });
    expect(log.entries(0)).toEqual([]);
    expect(log.entries(-3)).toEqual([]);
    expect(log.entries(2).map((entry) => entry.id)).toEqual([5, 4]);
  });
});

describe('ActivityLog: ephemeral entries', () => {
  it('lists them but never writes them', async () => {
    const h = build();
    h.log.add(entry({ tabId: 'normal-1' }));
    h.log.add(entry({ tabId: 'private' }), { ephemeral: true });
    h.log.add(entry({ tabId: 'normal-2' }));

    expect(h.log.entries().map((kept) => kept.tabId)).toEqual(['normal-2', 'private', 'normal-1']);
    await h.log.flush();
    expect(h.writes).toHaveLength(1);
    expect(pick(h.writes, 0, 'write').entries.map((kept) => kept.tabId)).toEqual([
      'normal-1',
      'normal-2',
    ]);
  });

  it('gives them ids from the same count, so the written ids have a gap', async () => {
    const h = build();
    h.log.add(entry());
    h.log.add(entry(), { ephemeral: true });
    h.log.add(entry());
    await h.log.flush();
    expect(ids(pick(h.writes, 0, 'write').entries)).toEqual([1, 3]);
  });

  it('arms no write for a log that has only ephemeral entries', async () => {
    const h = build();
    h.log.add(entry(), { ephemeral: true });
    h.log.add(entry(), { ephemeral: true });
    expect(h.timers.pending).toEqual([]);

    await h.log.flush();
    await h.timers.advance(10 * ACTIVITY_WRITE_DELAY_MS);
    expect(h.writes).toEqual([]);
  });

  it('keeps them out of every later write, not only the first', async () => {
    const h = build();
    h.log.add(entry({ tabId: 'one' }));
    h.log.add(entry({ tabId: 'private' }), { ephemeral: true });
    await h.log.flush();
    h.log.add(entry({ tabId: 'two' }));
    await h.log.flush();

    expect(pick(h.writes, 1, 'write').entries.map((kept) => kept.tabId)).toEqual(['one', 'two']);
  });

  it('counts them in the cap of what is kept', () => {
    const h = build({ stored: storedRange(1, MAX_ACTIVITY_ENTRIES) });
    h.log.add(entry(), { ephemeral: true });
    const listed = h.log.entries();
    expect(listed).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(pick(listed, 0, 'entry').id).toBe(MAX_ACTIVITY_ENTRIES + 1);
    expect(pick(listed, MAX_ACTIVITY_ENTRIES - 1, 'entry').id).toBe(2);
  });
});

describe('ActivityLog: writing', () => {
  it('writes once, ACTIVITY_WRITE_DELAY_MS after the first entry of a burst, with the whole burst', async () => {
    const h = build();
    h.log.add(entry());
    expect(h.timers.pending).toEqual([ACTIVITY_WRITE_DELAY_MS]);
    await h.timers.advance(3_000);
    h.log.add(entry());
    await h.timers.advance(3_000);
    h.log.add(entry());
    expect(h.timers.pending).toEqual([ACTIVITY_WRITE_DELAY_MS]); // still the first entry's timer

    await h.timers.advance(ACTIVITY_WRITE_DELAY_MS - 6_000 - 1);
    expect(h.writes).toEqual([]);
    await h.timers.advance(1);
    expect(h.writes).toHaveLength(1);
    expect(ids(pick(h.writes, 0, 'write').entries)).toEqual([1, 2, 3]);
    expect(h.timers.pending).toEqual([]);

    await h.timers.advance(10 * ACTIVITY_WRITE_DELAY_MS);
    expect(h.writes).toHaveLength(1);
  });

  it('writes the stored entries with the new ones', async () => {
    const h = build({ stored: storedRange(1, 2) });
    h.log.add(entry());
    await h.log.flush();
    expect(ids(pick(h.writes, 0, 'write').entries)).toEqual([1, 2, 3]);
  });

  it('writes at most the newest MAX_ACTIVITY_ENTRIES', async () => {
    const h = build({ stored: storedRange(1, MAX_ACTIVITY_ENTRIES) });
    h.log.add(entry());
    await h.log.flush();
    const written = pick(h.writes, 0, 'write').entries;
    expect(written).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(pick(written, 0, 'entry').id).toBe(2);
    expect(pick(written, MAX_ACTIVITY_ENTRIES - 1, 'entry').id).toBe(MAX_ACTIVITY_ENTRIES + 1);
  });

  it('starts a new burst, with its own timer, after the last one was written', async () => {
    const h = build();
    h.log.add(entry());
    await h.timers.advance(ACTIVITY_WRITE_DELAY_MS);
    expect(h.writes).toHaveLength(1);

    h.log.add(entry());
    expect(h.timers.pending).toEqual([ACTIVITY_WRITE_DELAY_MS]);
    await h.timers.advance(ACTIVITY_WRITE_DELAY_MS);
    expect(h.writes.map((write) => ids(write.entries))).toEqual([[1], [1, 2]]);
  });

  describe('flush()', () => {
    it('writes at once, cancels the timer, and resolves when the write has finished', async () => {
      const h = build({ hold: true });
      h.log.add(entry());
      const done = h.log.flush();
      expect(h.timers.pending).toEqual([]);
      await flush();
      expect(h.writes).toHaveLength(1);

      let finished = false;
      void done.then(() => {
        finished = true;
      });
      await flush();
      expect(finished).toBe(false);
      pick(h.writes, 0, 'write').settle.resolve(undefined);
      await flush();
      expect(finished).toBe(true);

      await h.timers.advance(10 * ACTIVITY_WRITE_DELAY_MS);
      expect(h.writes).toHaveLength(1); // the timer that was cancelled does not write again
    });

    it('writes nothing when nothing changed: a new log, one already written, or only ephemeral entries', async () => {
      const h = build({ stored: storedRange(1, 2) });
      await h.log.flush();
      expect(h.writes).toEqual([]);

      h.log.add(entry());
      await h.log.flush();
      await h.log.flush();
      expect(h.writes).toHaveLength(1);

      h.log.add(entry(), { ephemeral: true });
      await h.log.flush();
      expect(h.writes).toHaveLength(1);
    });

    it('writes nothing when the timer has written everything already', async () => {
      const h = build();
      h.log.add(entry());
      await h.timers.advance(ACTIVITY_WRITE_DELAY_MS);
      await h.log.flush();
      expect(h.writes).toHaveLength(1);
    });

    it('waits for a write still out even when it has nothing new to write', async () => {
      const h = build({ hold: true });
      h.log.add(entry());
      void h.log.flush();
      await flush();

      let finished = false;
      void h.log.flush().then(() => {
        finished = true;
      });
      await flush();
      expect(h.writes).toHaveLength(1);
      expect(finished).toBe(false); // quitting waits for the write under way

      pick(h.writes, 0, 'write').settle.resolve(undefined);
      await flush();
      expect(finished).toBe(true);
    });

    it('arms a new timer for an entry added after it', async () => {
      const h = build();
      h.log.add(entry());
      await h.log.flush();
      h.log.add(entry());
      expect(h.timers.pending).toEqual([ACTIVITY_WRITE_DELAY_MS]);
      await h.timers.advance(ACTIVITY_WRITE_DELAY_MS);
      expect(h.writes.map((write) => ids(write.entries))).toEqual([[1], [1, 2]]);
    });
  });

  describe('one write at a time', () => {
    it('starts a write only when the one before it has finished, and the later one carries the newer list', async () => {
      const h = build({ hold: true });
      h.log.add(entry());
      void h.log.flush();
      await flush();
      expect(h.writes).toHaveLength(1);

      h.log.add(entry());
      void h.log.flush();
      await flush();
      expect(h.writes).toHaveLength(1); // the second waits for the first

      pick(h.writes, 0, 'write').settle.resolve(undefined);
      await flush();
      expect(h.writes.map((write) => ids(write.entries))).toEqual([[1], [1, 2]]);
    });

    it('writes an entry added during a write in a write of its own, ACTIVITY_WRITE_DELAY_MS later', async () => {
      const h = build({ hold: true });
      h.log.add(entry());
      await h.timers.advance(ACTIVITY_WRITE_DELAY_MS); // the write starts and stays out
      expect(h.writes).toHaveLength(1);

      h.log.add(entry());
      expect(h.timers.pending).toEqual([ACTIVITY_WRITE_DELAY_MS]);
      await h.timers.advance(ACTIVITY_WRITE_DELAY_MS);
      expect(h.writes).toHaveLength(1); // due, but the first write has not finished

      pick(h.writes, 0, 'write').settle.resolve(undefined);
      await flush();
      expect(h.writes.map((write) => ids(write.entries))).toEqual([[1], [1, 2]]);
    });
  });

  describe('when a write fails', () => {
    it('logs it by code, and flush() still resolves', async () => {
      const h = build();
      h.state.rejects = 1;
      h.log.add(entry({ title: 'a private page title' }));

      await expect(h.log.flush()).resolves.toBeUndefined();
      expect(h.events).toEqual([{ level: 'warn', event: 'activity.writeFailed' }]);
    });

    it('survives a persist that throws at once', async () => {
      const h = build();
      h.state.throws = 1;
      h.log.add(entry());
      await expect(h.log.flush()).resolves.toBeUndefined();
      expect(h.events).toEqual([{ level: 'warn', event: 'activity.writeFailed' }]);
    });

    it('survives a failure of the write the timer started', async () => {
      const h = build();
      h.state.rejects = 1;
      h.log.add(entry());
      await h.timers.advance(ACTIVITY_WRITE_DELAY_MS);
      expect(h.events).toEqual([{ level: 'warn', event: 'activity.writeFailed' }]);
      expect(h.log.entries()).toHaveLength(1); // the entry is still there
    });

    it('goes on writing: the next entry brings the whole list, the failed one with it', async () => {
      const h = build();
      h.state.rejects = 1;
      h.log.add(entry());
      await h.log.flush();
      h.log.add(entry());
      await h.log.flush();

      expect(h.writes.map((write) => ids(write.entries))).toEqual([[1], [1, 2]]);
      expect(h.events).toHaveLength(1);
    });

    it('does not break a write queued behind the one that failed', async () => {
      const h = build({ hold: true });
      h.log.add(entry());
      void h.log.flush();
      await flush();
      h.log.add(entry());
      const second = h.log.flush();
      pick(h.writes, 0, 'write').settle.reject(new Error('the disk is full'));
      await flush();
      expect(h.writes.map((write) => ids(write.entries))).toEqual([[1], [1, 2]]);

      pick(h.writes, 1, 'write').settle.resolve(undefined);
      await expect(second).resolves.toBeUndefined();
      expect(h.events).toEqual([{ level: 'warn', event: 'activity.writeFailed' }]);
    });
  });

  describe('stop()', () => {
    it('cancels the timer, and what is unwritten waits for flush()', async () => {
      const h = build();
      h.log.add(entry());
      h.log.stop();
      expect(h.timers.pending).toEqual([]);
      await h.timers.advance(10 * ACTIVITY_WRITE_DELAY_MS);
      expect(h.writes).toEqual([]);

      await h.log.flush();
      expect(h.writes.map((write) => ids(write.entries))).toEqual([[1]]);
    });

    it('is harmless with no timer, and keeps the entries', () => {
      const h = build({ stored: storedRange(1, 2) });
      h.log.stop();
      h.log.stop();
      expect(ids(h.log.entries())).toEqual([2, 1]);
    });
  });
});

describe('parseActivity', () => {
  const good = (id: number): ActivityEntry => stored(id);

  it('reads a document of entries, oldest first', () => {
    expect(parseActivity({ entries: [good(3), good(1), good(2)] })).toEqual([
      good(1),
      good(2),
      good(3),
    ]);
  });

  it('reads an empty log', () => {
    expect(parseActivity({ entries: [] })).toEqual([]);
  });

  it('reads every kind of entry the log writes', () => {
    const kinds: ActivityEntry[] = [
      stored(1, { action: 'shelve', rule: 'shelve-beyond-cap' }),
      stored(2, { action: 'archive', rule: 'archive-dormant' }),
      stored(3, { action: 'discard', rule: 'pressure-discard', pressure: 'moderate' }),
      stored(4, { action: 'discard', rule: 'pressure-discard', pressure: 'critical' }),
      stored(5, { action: 'freeze', rule: 'freeze-hidden' }),
      stored(6, { action: 'undo', rule: null, batchId: null }),
    ];
    expect(parseActivity({ entries: kinds })).toEqual(kinds);
  });

  it('keeps an entry without a title or address, which are text and may be empty', () => {
    const empty = stored(1, { title: '', address: '' });
    expect(parseActivity({ entries: [empty] })).toEqual([empty]);
  });

  const withoutBatch = Object.fromEntries(
    Object.entries(good(2)).filter(([key]) => key !== 'batchId'),
  );

  it.each<[string, unknown]>([
    ['an unknown action', { ...good(2), action: 'explode' }],
    ['an unknown rule', { ...good(2), rule: 'no-such-rule' }],
    ['a pressure of "none" (null says that)', { ...good(2), pressure: 'none' }],
    ['an id of 0', { ...good(2), id: 0 }],
    ['a negative id', { ...good(2), id: -3 }],
    ['an id with a fraction', { ...good(2), id: 1.5 }],
    ['a negative time', { ...good(2), at: -1 }],
    ['an empty tab id', { ...good(2), tabId: '' }],
    ['a title over MAX_ACTIVITY_TITLE', { ...good(2), title: 't'.repeat(MAX_ACTIVITY_TITLE + 1) }],
    [
      'an address over MAX_ACTIVITY_ADDRESS',
      { ...good(2), address: 'a'.repeat(MAX_ACTIVITY_ADDRESS + 1) },
    ],
    ['a missing batch id', withoutBatch],
    ['null', null],
    ['text', 'an entry'],
    ['a number', 42],
    ['an array', [good(2)]],
  ])('drops an entry with %s and keeps the ones around it', (_name, bad) => {
    expect(parseActivity({ entries: [good(1), bad, good(3)] })).toEqual([good(1), good(3)]);
  });

  it('ignores a field a later version added to an entry, and keeps the entry', () => {
    expect(parseActivity({ entries: [good(1), { ...good(2), extra: true }] })).toEqual([
      good(1),
      good(2),
    ]);
  });

  it('ignores a field a later version added beside the entries', () => {
    expect(parseActivity({ entries: [good(1)], extra: 1 })).toEqual([good(1)]);
  });

  it('is empty when every entry is damaged', () => {
    expect(parseActivity({ entries: [null, 'x', { id: 1 }] })).toEqual([]);
  });

  it('keeps the newest MAX_ACTIVITY_ENTRIES of more than that', () => {
    const parsed = parseActivity({ entries: storedRange(1, MAX_ACTIVITY_ENTRIES + 100) });
    expect(parsed).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(pick(parsed, 0, 'entry').id).toBe(101);
    expect(pick(parsed, MAX_ACTIVITY_ENTRIES - 1, 'entry').id).toBe(MAX_ACTIVITY_ENTRIES + 100);
  });

  it('sorts before it cuts, so the newest survive whatever the order stored', () => {
    const shuffled = [...storedRange(1, MAX_ACTIVITY_ENTRIES + 3)].reverse();
    const parsed = parseActivity({ entries: shuffled });
    expect(pick(parsed, 0, 'entry').id).toBe(4);
    expect(pick(parsed, MAX_ACTIVITY_ENTRIES - 1, 'entry').id).toBe(MAX_ACTIVITY_ENTRIES + 3);
  });

  it('looks at the last 2 × MAX_ACTIVITY_ENTRIES stored, and keeps the newest of those', () => {
    expect(parseActivity({ entries: storedRange(1, 2 * MAX_ACTIVITY_ENTRIES) })).toHaveLength(
      MAX_ACTIVITY_ENTRIES,
    );
    const parsed = parseActivity({ entries: storedRange(1, 3 * MAX_ACTIVITY_ENTRIES) });
    expect(parsed).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(pick(parsed, 0, 'entry').id).toBe(2 * MAX_ACTIVITY_ENTRIES + 1);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['text', 'entries'],
    ['a number', 42],
    ['a boolean', true],
    ['an empty array', []],
    ['an array of entries', [good(1)]],
    ['an object with no entries', {}],
    ['entries that are null', { entries: null }],
    ['entries that are text', { entries: 'x' }],
    ['entries that are an object', { entries: { 1: good(1) } }],
  ])('is an empty log for %s', (_name, raw) => {
    expect(parseActivity(raw)).toEqual([]);
  });
});

/** The data client's `call`, recording each one; `answer` decides what it returns. */
function fakeData(answer: (method: string, input: unknown) => unknown) {
  const calls: { method: string; input: unknown; options: unknown }[] = [];
  const data = {
    call: (method: string, input: unknown, options?: unknown) => {
      calls.push({ method, input, options });
      return Promise.resolve(answer(method, input));
    },
  } as unknown as Pick<DataClient, 'call'>;
  return { data, calls };
}

describe('readStoredActivity', () => {
  it('reads the activity document, within a short timeout, oldest first', async () => {
    expect(ACTIVITY_DOCUMENT).toBe('activity');
    const { data, calls } = fakeData(() => ({ value: { entries: [stored(2), stored(1)] } }));
    const { logger, events } = recordingLogger();

    await expect(readStoredActivity(data, logger)).resolves.toEqual([stored(1), stored(2)]);
    expect(calls).toEqual([
      // ACTIVITY_READ_TIMEOUT_MS: reading the log must not hold the window back.
      { method: 'appState.get', input: { key: 'activity' }, options: { timeoutMs: 2000 } },
    ]);
    expect(events).toEqual([]);
  });

  it('is an empty log, without a warning, for a profile with no document', async () => {
    const { data } = fakeData(() => ({ value: null }));
    const { logger, events } = recordingLogger();
    await expect(readStoredActivity(data, logger)).resolves.toEqual([]);
    expect(events).toEqual([]);
  });

  it('drops a damaged entry and keeps the rest, without a warning', async () => {
    const { data } = fakeData(() => ({ value: { entries: [stored(1), { id: 'x' }, stored(3)] } }));
    const { logger, events } = recordingLogger();
    await expect(readStoredActivity(data, logger)).resolves.toEqual([stored(1), stored(3)]);
    expect(events).toEqual([]);
  });

  it('is an empty log for a document of the wrong shape', async () => {
    const { data } = fakeData(() => ({ value: ['not', 'a', 'log'] }));
    const { logger } = recordingLogger();
    await expect(readStoredActivity(data, logger)).resolves.toEqual([]);
  });

  it.each<[string, Error]>([
    ['a timeout', new DataClientError('timeout', 'appState.get')],
    ['the worker gone', new DataClientError('worker_gone')],
    ['an error of any other kind', new Error('something with a title in it')],
  ])('is an empty log, with a warning by code, when the call rejects: %s', async (_name, error) => {
    const data = { call: () => Promise.reject(error) } as unknown as Pick<DataClient, 'call'>;
    const { logger, events } = recordingLogger();

    await expect(readStoredActivity(data, logger)).resolves.toEqual([]);
    expect(events).toEqual([{ level: 'warn', event: 'activity.readFailed' }]);
  });

  it('is an empty log, with a warning, when the call throws at once', async () => {
    const data = {
      call: () => {
        throw new Error('the client is closed');
      },
    } as unknown as Pick<DataClient, 'call'>;
    const { logger, events } = recordingLogger();
    await expect(readStoredActivity(data, logger)).resolves.toEqual([]);
    expect(events).toEqual([{ level: 'warn', event: 'activity.readFailed' }]);
  });
});

describe('activityWriter', () => {
  it('sets the activity document to the entries', async () => {
    const { data, calls } = fakeData(() => ({}));
    const entries = [stored(1), stored(2)];

    await expect(activityWriter(data)(entries)).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        method: 'appState.set',
        input: { key: 'activity', value: { entries } },
        options: undefined,
      },
    ]);
  });

  it('writes copies of the entries, so a later change to the log cannot reach the call', async () => {
    const { data, calls } = fakeData(() => ({}));
    const entries = [stored(1)];
    await activityWriter(data)(entries);

    const sent = calls[0]?.input as { value: { entries: ActivityEntry[] } };
    expect(sent.value.entries[0]).toEqual(entries[0]);
    expect(sent.value.entries[0]).not.toBe(entries[0]);
  });

  it('writes an empty log as a document with no entries, not as nothing', async () => {
    const { data, calls } = fakeData(() => ({}));
    await activityWriter(data)([]);
    expect(calls[0]?.input).toEqual({ key: 'activity', value: { entries: [] } });
  });

  it('rejects when the call does, so the log can report the failed write', async () => {
    const data = {
      call: () => Promise.reject(new DataClientError('sqlite', 'SQLITE_FULL')),
    } as unknown as Pick<DataClient, 'call'>;
    await expect(activityWriter(data)([stored(1)])).rejects.toBeInstanceOf(DataClientError);
  });

  it('writes what readStoredActivity reads back', async () => {
    const documents = new Map<string, unknown>();
    const data = {
      call: (method: string, input: { key: string; value?: unknown }) => {
        if (method === 'appState.set') {
          documents.set(input.key, JSON.parse(JSON.stringify(input.value)));
          return Promise.resolve({});
        }
        return Promise.resolve({ value: documents.get(input.key) ?? null });
      },
    } as unknown as Pick<DataClient, 'call'>;
    const { logger, events } = recordingLogger();

    const timers = new ManualTimers();
    const log = new ActivityLog({
      stored: [],
      persist: activityWriter(data),
      timers,
      logger,
    });
    log.add(entry({ action: 'shelve', rule: 'shelve-beyond-cap', title: 'Kept' }));
    log.add(entry({ action: 'undo', rule: null, batchId: null }));
    log.add(entry({ tabId: 'private' }), { ephemeral: true });
    await log.flush();

    const read = await readStoredActivity(data, logger);
    expect(read.map((kept) => [kept.id, kept.action, kept.tabId])).toEqual([
      [1, 'shelve', 'tab-1'],
      [2, 'undo', 'tab-1'],
    ]);
    expect(events).toEqual([]);

    // A restarted log carries on after the highest stored id.
    const restarted = new ActivityLog({
      stored: read,
      persist: activityWriter(data),
      timers,
      logger,
    });
    expect(restarted.add(entry()).id).toBe(3);
  });
});
