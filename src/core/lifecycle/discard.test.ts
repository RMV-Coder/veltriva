import { describe, expect, it } from 'vitest';

import { CLOSE_TIMEOUT_MS, FREEZE_TIMEOUT_MS, LEARNED_RECHECK_MS, withDeadline } from './discard';
import type { Timers } from './discard';
import { PROBE_TIMEOUT_MS } from './probe';

/** Timers the test runs by hand: `fire()` is the moment every pending deadline passes. */
class FakeTimers implements Timers {
  /** The `ms` of every timer ever set, in order. */
  readonly delays: number[] = [];
  /** The handle of every `clearTimeout` call, in order. */
  readonly cleared: unknown[] = [];
  readonly #scheduled = new Map<number, () => void>();
  #next = 1;

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.#next;
    this.#next += 1;
    this.#scheduled.set(handle, callback);
    this.delays.push(ms);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.cleared.push(handle);
    if (typeof handle === 'number') {
      this.#scheduled.delete(handle);
    }
  }

  /** Timers set and neither fired nor cleared. */
  get active(): number {
    return this.#scheduled.size;
  }

  /** Runs every timer that is still set. */
  fire(): void {
    const due = [...this.#scheduled.values()];
    this.#scheduled.clear();
    for (const callback of due) {
      callback();
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every promise reaction that can run, run: a macrotask comes after all the microtasks. */
const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe('the discard deadlines', () => {
  it('give a close 5 seconds (assessment §4.9 step 5)', () => {
    expect(CLOSE_TIMEOUT_MS).toBe(5000);
  });

  it('remember a learned protection for 30 minutes', () => {
    expect(LEARNED_RECHECK_MS).toBe(30 * 60 * 1000);
    expect(LEARNED_RECHECK_MS).toBe(1_800_000);
  });

  it('give freezing 1 second', () => {
    expect(FREEZE_TIMEOUT_MS).toBe(1000);
  });

  it('give the probe 100 ms (assessment §4.9 step 3), defined next to the probe', () => {
    expect(PROBE_TIMEOUT_MS).toBe(100);
  });

  it('are whole, positive numbers of milliseconds, from the shortest wait to the longest', () => {
    const all = [PROBE_TIMEOUT_MS, FREEZE_TIMEOUT_MS, CLOSE_TIMEOUT_MS, LEARNED_RECHECK_MS];

    for (const ms of all) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
    expect([...all].sort((a, b) => a - b)).toEqual(all);
  });
});

describe('withDeadline', () => {
  describe('when the value comes before the deadline', () => {
    it('is the value', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();

      const result = withDeadline(gate.promise, CLOSE_TIMEOUT_MS, timers);
      gate.resolve('closed');

      await expect(result).resolves.toStrictEqual({ kind: 'value', value: 'closed' });
    });

    it('sets one timer for the time it was given, and clears it', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();

      const result = withDeadline(gate.promise, 5000, timers);
      expect(timers.delays).toEqual([5000]);
      expect(timers.active).toBe(1);
      expect(timers.cleared).toEqual([]);

      gate.resolve('closed');
      await result;

      expect(timers.active).toBe(0);
      expect(timers.cleared).toEqual([1]);
    });

    it('clears the very timer it set', async () => {
      const timers = new FakeTimers();

      await withDeadline(Promise.resolve('x'), 10, timers);
      await withDeadline(Promise.resolve('y'), 10, timers);

      // Handles 1 and 2 were handed out by setTimeout, and each was cleared by its own call.
      expect(timers.cleared).toEqual([1, 2]);
      expect(timers.active).toBe(0);
    });

    it('is the value of a promise that was already resolved, with its timer set first', async () => {
      const timers = new FakeTimers();

      const result = withDeadline(Promise.resolve(7), 100, timers);
      expect(timers.delays).toEqual([100]);

      await expect(result).resolves.toStrictEqual({ kind: 'value', value: 7 });
      expect(timers.active).toBe(0);
    });

    it.each([
      ['zero', 0],
      ['an empty string', ''],
      ['false', false],
      ['null', null],
      ['undefined', undefined],
    ])('passes %s on as a value, which is not a failure', async (_name, value) => {
      const timers = new FakeTimers();

      await expect(withDeadline(Promise.resolve(value), 10, timers)).resolves.toStrictEqual({
        kind: 'value',
        value,
      });
    });

    it('passes on the very object, not a copy', async () => {
      const timers = new FakeTimers();
      const value = { destroyed: true };

      const result = await withDeadline(Promise.resolve(value), 10, timers);

      expect(result.kind === 'value' && result.value).toBe(value);
    });

    it('stays the value when the deadline would have passed afterwards', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();
      const outcomes: unknown[] = [];

      const settled = withDeadline(gate.promise, 10, timers).then((outcome) => {
        outcomes.push(outcome);
      });
      gate.resolve('early');
      await settled;
      timers.fire();
      await settle();

      expect(outcomes).toEqual([{ kind: 'value', value: 'early' }]);
    });
  });

  describe('when the deadline passes before the value', () => {
    it('is timedOut', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();

      const result = withDeadline(gate.promise, CLOSE_TIMEOUT_MS, timers);
      timers.fire();

      await expect(result).resolves.toStrictEqual({ kind: 'timedOut' });
    });

    it('does not wait for the promise, which goes on', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();
      let outcome: unknown;

      const settled = withDeadline(gate.promise, 10, timers).then((result) => {
        outcome = result;
      });
      timers.fire();
      await settled;

      expect(outcome).toStrictEqual({ kind: 'timedOut' });
    });

    it('ignores a value that comes later', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();
      const outcomes: unknown[] = [];

      const settled = withDeadline(gate.promise, 10, timers).then((outcome) => {
        outcomes.push(outcome);
      });
      timers.fire();
      await settled;

      gate.resolve('too late');
      await settle();

      expect(outcomes).toEqual([{ kind: 'timedOut' }]);
    });

    it('is not delivered twice when the timer fires twice', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();
      const outcomes: unknown[] = [];

      const settled = withDeadline(gate.promise, 10, timers).then((outcome) => {
        outcomes.push(outcome);
      });
      timers.fire();
      timers.fire();
      await settled;
      await settle();

      expect(outcomes).toEqual([{ kind: 'timedOut' }]);
    });
  });

  describe('when the promise rejects', () => {
    it('is failed, and the timer is cleared', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();

      const result = withDeadline(gate.promise, 10, timers);
      gate.reject(new Error('close threw'));

      await expect(result).resolves.toStrictEqual({ kind: 'failed' });
      expect(timers.active).toBe(0);
      expect(timers.cleared).toEqual([1]);
    });

    it.each([
      ['an Error', new Error('boom')],
      ['a string', 'boom'],
      ['undefined', undefined],
      ['null', null],
      ['an object', { code: 'ERR_ABORTED' }],
    ])('is failed whatever is thrown, such as %s', async (_name, reason) => {
      const timers = new FakeTimers();
      const gate = deferred<string>();

      const result = withDeadline(gate.promise, 10, timers);
      gate.reject(reason);

      await expect(result).resolves.toStrictEqual({ kind: 'failed' });
    });

    it('is failed for a promise that was already rejected', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();
      gate.reject(new Error('already'));

      const result = withDeadline(gate.promise, 10, timers);

      await expect(result).resolves.toStrictEqual({ kind: 'failed' });
      expect(timers.active).toBe(0);
    });

    it('never rejects itself', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();

      const result = withDeadline(gate.promise, 10, timers);
      gate.reject(new Error('close threw'));

      await expect(result).resolves.toBeDefined();
    });

    it('does not fire its deadline afterwards', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();
      const outcomes: unknown[] = [];

      const settled = withDeadline(gate.promise, 10, timers).then((outcome) => {
        outcomes.push(outcome);
      });
      gate.reject(new Error('close threw'));
      await settled;
      timers.fire();
      await settle();

      expect(outcomes).toEqual([{ kind: 'failed' }]);
    });
  });

  describe('when the promise rejects after the deadline', () => {
    it('keeps timedOut and ignores the rejection', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();
      const outcomes: unknown[] = [];

      const settled = withDeadline(gate.promise, 10, timers).then((outcome) => {
        outcomes.push(outcome);
      });
      timers.fire();
      await settled;

      gate.reject(new Error('rejected late'));
      await settle();

      expect(outcomes).toEqual([{ kind: 'timedOut' }]);
    });

    it('causes no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', listener);
      try {
        const timers = new FakeTimers();
        const gate = deferred<string>();

        const result = withDeadline(gate.promise, 10, timers);
        timers.fire();
        await expect(result).resolves.toStrictEqual({ kind: 'timedOut' });

        gate.reject(new Error('rejected late'));
        await settle();
        await settle();
      } finally {
        process.off('unhandledRejection', listener);
      }

      expect(unhandled).toEqual([]);
    });

    it('causes no unhandled rejection when the promise was already rejected before the deadline was set', async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', listener);
      try {
        const timers = new FakeTimers();
        const gate = deferred<string>();
        gate.reject(new Error('rejected before'));

        const result = await withDeadline(gate.promise, 10, timers);
        await settle();

        expect(result).toStrictEqual({ kind: 'failed' });
      } finally {
        process.off('unhandledRejection', listener);
      }

      expect(unhandled).toEqual([]);
    });
  });

  describe('the time it is given', () => {
    it.each([0, 1, 100, FREEZE_TIMEOUT_MS, CLOSE_TIMEOUT_MS, LEARNED_RECHECK_MS])(
      'is passed to setTimeout as %i',
      async (ms) => {
        const timers = new FakeTimers();

        await withDeadline(Promise.resolve(), ms, timers);

        expect(timers.delays).toEqual([ms]);
      },
    );

    it('still sets a timer for a deadline of zero, and leaves it to the timers to say when it passes', async () => {
      const timers = new FakeTimers();
      const gate = deferred<string>();

      const result = withDeadline(gate.promise, 0, timers);
      expect(timers.active).toBe(1);

      timers.fire();
      await expect(result).resolves.toStrictEqual({ kind: 'timedOut' });
    });
  });

  describe('several deadlines at once', () => {
    it('are independent: a value for one leaves the other timer set', async () => {
      const timers = new FakeTimers();
      const first = deferred<string>();
      const second = deferred<string>();

      const resultOne = withDeadline(first.promise, 100, timers);
      const resultTwo = withDeadline(second.promise, 200, timers);
      expect(timers.delays).toEqual([100, 200]);

      first.resolve('one');
      await expect(resultOne).resolves.toStrictEqual({ kind: 'value', value: 'one' });
      expect(timers.active).toBe(1);
      expect(timers.cleared).toEqual([1]);

      timers.fire();
      await expect(resultTwo).resolves.toStrictEqual({ kind: 'timedOut' });
    });

    it('time out together when the timers fire together', async () => {
      const timers = new FakeTimers();

      const results = [
        withDeadline(deferred<string>().promise, 10, timers),
        withDeadline(deferred<number>().promise, 20, timers),
      ];
      timers.fire();

      await expect(Promise.all(results)).resolves.toStrictEqual([
        { kind: 'timedOut' },
        { kind: 'timedOut' },
      ]);
    });

    it('settle each to its own outcome: a value, a failure and a timeout', async () => {
      const timers = new FakeTimers();
      const slow = deferred<string>();
      const results = [
        withDeadline(Promise.resolve('fast'), 10, timers),
        withDeadline(Promise.reject(new Error('broken')), 10, timers),
        withDeadline(slow.promise, 10, timers),
      ];
      await settle();
      timers.fire();

      await expect(Promise.all(results)).resolves.toStrictEqual([
        { kind: 'value', value: 'fast' },
        { kind: 'failed' },
        { kind: 'timedOut' },
      ]);
    });
  });
});
