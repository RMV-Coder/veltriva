import { describe, expect, it } from 'vitest';

import { SerialQueue } from './serial-queue';

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/** A promise the test settles when it chooses, so it decides in what order operations finish. */
function deferred<T = void>(): Deferred<T> {
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

const counts = (queue: SerialQueue) => ({ pending: queue.pending, running: queue.running });

const threeGates = (): [Deferred, Deferred, Deferred] => [deferred(), deferred(), deferred()];

describe('SerialQueue', () => {
  describe('an operation', () => {
    it('runs, and its caller gets the value', async () => {
      const queue = new SerialQueue();

      await expect(queue.run(() => Promise.resolve(42))).resolves.toBe(42);
    });

    it('hands back exactly the value it resolved with', async () => {
      const queue = new SerialQueue();
      const value = { id: 'tab-1' };

      await expect(queue.run(() => Promise.resolve(value))).resolves.toBe(value);
      await expect(queue.run(() => Promise.resolve(undefined))).resolves.toBeUndefined();
    });

    it('is not called before run() returns', async () => {
      const queue = new SerialQueue();
      const calls: string[] = [];

      const result = queue.run(() => {
        calls.push('ran');
        return Promise.resolve();
      });
      expect(calls).toEqual([]);

      await result;
      expect(calls).toEqual(['ran']);
    });

    it('is called once, without arguments', async () => {
      const queue = new SerialQueue();
      const seen: unknown[][] = [];

      await queue.run((...args: unknown[]) => {
        seen.push(args);
        return Promise.resolve();
      });

      expect(seen).toEqual([[]]);
    });

    it('may be queued again once the queue is empty', async () => {
      const queue = new SerialQueue();

      await queue.run(() => Promise.resolve());
      await settle();

      await expect(queue.run(() => Promise.resolve('again'))).resolves.toBe('again');
    });
  });

  describe('the order of operations', () => {
    it('is the order they were queued in', async () => {
      const queue = new SerialQueue();
      const order: number[] = [];

      await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          queue.run(() => {
            order.push(n);
            return Promise.resolve(n);
          }),
        ),
      );

      expect(order).toEqual([1, 2, 3, 4, 5]);
    });

    it('lets an operation start only after the one before it has finished, even if it could finish first', async () => {
      const queue = new SerialQueue();
      const log: string[] = [];
      const gates = { a: deferred<string>(), b: deferred<string>(), c: deferred<string>() };
      const operation = (name: 'a' | 'b' | 'c') => async () => {
        log.push(`start ${name}`);
        const value = await gates[name].promise;
        log.push(`end ${name}`);
        return value;
      };

      const results = [
        queue.run(operation('a')),
        queue.run(operation('b')),
        queue.run(operation('c')),
      ];
      await settle();
      expect(log).toEqual(['start a']);

      // The later operations are ready first, and still wait.
      gates.c.resolve('C');
      gates.b.resolve('B');
      await settle();
      expect(log).toEqual(['start a']);

      gates.a.resolve('A');
      await expect(Promise.all(results)).resolves.toEqual(['A', 'B', 'C']);
      expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    });

    it('stays strictly one after another when twenty operations resolve in the opposite order', async () => {
      const queue = new SerialQueue();
      const gates = Array.from({ length: 20 }, () => deferred<number>());
      const started: number[] = [];
      const finished: number[] = [];
      let active = 0;
      let mostActive = 0;

      const results = gates.map((gate, n) =>
        queue.run(async () => {
          started.push(n);
          active += 1;
          mostActive = Math.max(mostActive, active);
          const value = await gate.promise;
          active -= 1;
          finished.push(n);
          return value;
        }),
      );
      for (const { gate, n } of gates.map((gate, n) => ({ gate, n })).reverse()) {
        gate.resolve(n);
        await settle();
      }

      await expect(Promise.all(results)).resolves.toEqual(Array.from({ length: 20 }, (_, n) => n));
      expect(started).toEqual(Array.from({ length: 20 }, (_, n) => n));
      expect(finished).toEqual(Array.from({ length: 20 }, (_, n) => n));
      expect(mostActive).toBe(1);
    });

    it('never has two operations in flight when each one yields several times', async () => {
      const queue = new SerialQueue();
      let active = 0;
      let mostActive = 0;

      await Promise.all(
        Array.from({ length: 10 }, () =>
          queue.run(async () => {
            active += 1;
            mostActive = Math.max(mostActive, active);
            for (let i = 0; i < 5; i += 1) {
              await Promise.resolve();
            }
            await settle();
            active -= 1;
          }),
        ),
      );

      expect(mostActive).toBe(1);
      expect(active).toBe(0);
    });

    it('runs an operation queued by another after the one that queued it has finished', async () => {
      const queue = new SerialQueue();
      const log: string[] = [];
      const inner: Promise<string>[] = [];

      await queue.run(async () => {
        log.push('outer starts');
        inner.push(
          queue.run(() => {
            log.push('inner runs');
            return Promise.resolve('inner');
          }),
        );
        await settle();
        log.push('outer ends');
      });

      await expect(inner[0]).resolves.toBe('inner');
      expect(log).toEqual(['outer starts', 'outer ends', 'inner runs']);
    });

    it('keeps the order across five hundred operations that are all ready at once', async () => {
      const queue = new SerialQueue();
      const order: number[] = [];

      const results = Array.from({ length: 500 }, (_, n) =>
        queue.run(() => {
          order.push(n);
          return Promise.resolve(n);
        }),
      );

      await expect(Promise.all(results)).resolves.toEqual(Array.from({ length: 500 }, (_, n) => n));
      expect(order).toEqual(Array.from({ length: 500 }, (_, n) => n));
    });
  });

  describe('an operation that fails', () => {
    it('rejects its own caller with the reason it gave', async () => {
      const queue = new SerialQueue();
      const boom = new Error('boom');

      await expect(queue.run(() => Promise.reject(boom))).rejects.toBe(boom);
    });

    it('rejects its own caller with a reason that is not an Error', async () => {
      const queue = new SerialQueue();
      const gate = deferred<never>();
      const reason: unknown = 'plain text';

      const result = queue.run(() => gate.promise);
      const outcome = expect(result).rejects.toBe(reason);
      gate.reject(reason);

      await outcome;
    });

    it('does not stop the next operation, which runs and gets its own value', async () => {
      const queue = new SerialQueue();
      const log: string[] = [];

      const first = queue.run(() => {
        log.push('first');
        return Promise.reject(new Error('first failed'));
      });
      const second = queue.run(() => {
        log.push('second');
        return Promise.resolve('second value');
      });

      await expect(first).rejects.toThrow('first failed');
      await expect(second).resolves.toBe('second value');
      expect(log).toEqual(['first', 'second']);
    });

    it('does not pass its error to the operations queued after it', async () => {
      const queue = new SerialQueue();

      const results = await Promise.allSettled([
        queue.run(() => Promise.resolve('one')),
        queue.run(() => Promise.reject(new Error('two failed'))),
        queue.run(() => Promise.resolve('three')),
        queue.run(() => Promise.resolve('four')),
      ]);

      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
        'fulfilled',
      ]);
      expect(results[2]).toEqual({ status: 'fulfilled', value: 'three' });
      expect(results[3]).toEqual({ status: 'fulfilled', value: 'four' });
    });

    it('keeps the queue going when failures and successes alternate', async () => {
      const queue = new SerialQueue();
      const order: number[] = [];

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, n) =>
          queue.run(() => {
            order.push(n);
            return n % 2 === 0 ? Promise.resolve(n) : Promise.reject(new Error(String(n)));
          }),
        ),
      );

      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(results.map((result) => result.status)).toEqual(
        Array.from({ length: 10 }, (_, n) => (n % 2 === 0 ? 'fulfilled' : 'rejected')),
      );
    });

    it('lets the next operation start only after a slow failure has settled', async () => {
      const queue = new SerialQueue();
      const gate = deferred<never>();
      const log: string[] = [];

      const first = queue.run(async () => {
        log.push('first starts');
        return await gate.promise;
      });
      const outcome = expect(first).rejects.toThrow('late failure');
      const second = queue.run(() => {
        log.push('second starts');
        return Promise.resolve('ok');
      });
      await settle();
      expect(log).toEqual(['first starts']);

      gate.reject(new Error('late failure'));

      await outcome;
      await expect(second).resolves.toBe('ok');
      expect(log).toEqual(['first starts', 'second starts']);
    });

    it('does not leave a rejection unhandled that the caller handled', async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', listener);
      try {
        const queue = new SerialQueue();

        const failing = queue.run(() => Promise.reject(new Error('handled by the caller')));
        failing.catch(() => undefined);
        void queue.run(() => Promise.resolve('next'));
        await settle();
        await settle();
      } finally {
        process.off('unhandledRejection', listener);
      }

      expect(unhandled).toEqual([]);
    });
  });

  describe('an operation that throws synchronously', () => {
    it('rejects its caller instead of throwing out of run()', async () => {
      const queue = new SerialQueue();

      const result = queue.run((): Promise<never> => {
        throw new Error('thrown at once');
      });

      await expect(result).rejects.toThrow('thrown at once');
    });

    it('rejects its caller when its async function throws before the first await', async () => {
      const queue = new SerialQueue();

      // eslint-disable-next-line @typescript-eslint/require-await
      const result = queue.run(async (): Promise<never> => {
        throw new Error('thrown first thing');
      });

      await expect(result).rejects.toThrow('thrown first thing');
    });

    it('does not stop the next operation', async () => {
      const queue = new SerialQueue();

      const failing = queue.run((): Promise<never> => {
        throw new Error('thrown at once');
      });
      const next = queue.run(() => Promise.resolve('next'));

      await expect(failing).rejects.toThrow('thrown at once');
      await expect(next).resolves.toBe('next');
    });

    it('is not counted as pending or running afterwards', async () => {
      const queue = new SerialQueue();

      const failing = queue.run((): Promise<never> => {
        throw new Error('thrown at once');
      });
      await expect(failing).rejects.toThrow();

      expect(counts(queue)).toEqual({ pending: 0, running: 0 });
    });
  });

  describe('pending and running', () => {
    it('are zero for a queue that has never run anything', () => {
      expect(counts(new SerialQueue())).toEqual({ pending: 0, running: 0 });
    });

    it('count an operation as pending as soon as it is queued, and running once it starts', async () => {
      const queue = new SerialQueue();
      const gate = deferred();

      const result = queue.run(() => gate.promise);
      expect(counts(queue)).toEqual({ pending: 1, running: 0 });

      await settle();
      expect(counts(queue)).toEqual({ pending: 1, running: 1 });

      gate.resolve();
      await result;
      expect(counts(queue)).toEqual({ pending: 0, running: 0 });
    });

    it('show every stage of three operations, with running never above one', async () => {
      const queue = new SerialQueue();
      const [a, b, c] = threeGates();

      const ra = queue.run(() => a.promise);
      const rb = queue.run(() => b.promise);
      const rc = queue.run(() => c.promise);
      expect(counts(queue)).toEqual({ pending: 3, running: 0 });

      await settle();
      expect(counts(queue)).toEqual({ pending: 3, running: 1 });

      // Finishing the later ones first changes nothing while the first still runs.
      c.resolve();
      b.resolve();
      await settle();
      expect(counts(queue)).toEqual({ pending: 3, running: 1 });

      a.resolve();
      await ra;
      await settle();
      expect(counts(queue)).toEqual({ pending: 0, running: 0 });
      await Promise.all([rb, rc]);
    });

    it('step down one operation at a time', async () => {
      const queue = new SerialQueue();
      const [a, b, c] = threeGates();
      const ra = queue.run(() => a.promise);
      const rb = queue.run(() => b.promise);
      const rc = queue.run(() => c.promise);
      await settle();

      a.resolve();
      await ra;
      await settle();
      expect(counts(queue)).toEqual({ pending: 2, running: 1 });

      b.resolve();
      await rb;
      await settle();
      expect(counts(queue)).toEqual({ pending: 1, running: 1 });

      c.resolve();
      await rc;
      await settle();
      expect(counts(queue)).toEqual({ pending: 0, running: 0 });
    });

    it('are seen from inside each operation as exactly one running and the rest pending', async () => {
      const queue = new SerialQueue();
      const seen: { pending: number; running: number }[] = [];

      await Promise.all(
        [1, 2, 3, 4].map(() =>
          queue.run(async () => {
            seen.push(counts(queue));
            await settle();
          }),
        ),
      );

      expect(seen).toEqual([
        { pending: 4, running: 1 },
        { pending: 3, running: 1 },
        { pending: 2, running: 1 },
        { pending: 1, running: 1 },
      ]);
    });

    it('never show more than one running, however the operations are timed', async () => {
      const queue = new SerialQueue();
      const gates = Array.from({ length: 8 }, () => deferred());
      const observed = new Set<number>();
      const watch = () => {
        observed.add(queue.running);
      };

      const results = gates.map((gate) => {
        const result = queue.run(() => gate.promise);
        watch();
        return result;
      });
      for (const gate of [...gates].reverse()) {
        await settle();
        watch();
        gate.resolve();
      }
      await Promise.all(results);
      watch();

      expect(Math.max(...observed)).toBe(1);
      expect([...observed].every((n) => n === 0 || n === 1)).toBe(true);
    });

    it('drop for a failed operation as they do for a successful one', async () => {
      const queue = new SerialQueue();
      const gate = deferred<never>();

      const result = queue.run(() => gate.promise);
      const outcome = expect(result).rejects.toThrow('nope');
      await settle();
      expect(counts(queue)).toEqual({ pending: 1, running: 1 });

      gate.reject(new Error('nope'));
      await outcome;

      expect(counts(queue)).toEqual({ pending: 0, running: 0 });
    });

    it('are already back to zero when the caller sees the result', async () => {
      const queue = new SerialQueue();
      const afterSettling: { pending: number; running: number }[] = [];

      const first = queue.run(() => Promise.resolve(1));
      void first.then(() => afterSettling.push(counts(queue)));
      await first;

      expect(afterSettling).toEqual([{ pending: 0, running: 0 }]);
    });
  });

  describe('separate queues', () => {
    it('do not wait for each other', async () => {
      const slow = new SerialQueue();
      const quick = new SerialQueue();
      const gate = deferred();

      const blocked = slow.run(() => gate.promise);
      await settle();
      const result = await quick.run(() => Promise.resolve('quick'));

      expect(result).toBe('quick');
      expect(counts(slow)).toEqual({ pending: 1, running: 1 });
      expect(counts(quick)).toEqual({ pending: 0, running: 0 });

      gate.resolve();
      await blocked;
    });

    it('keep their own counts', async () => {
      const a = new SerialQueue();
      const b = new SerialQueue();
      const gate = deferred();

      const ra = a.run(() => gate.promise);
      const rb = b.run(() => gate.promise);
      void b.run(() => Promise.resolve());
      await settle();

      expect(counts(a)).toEqual({ pending: 1, running: 1 });
      expect(counts(b)).toEqual({ pending: 2, running: 1 });

      gate.resolve();
      await Promise.all([ra, rb]);
      await settle();
      expect(counts(a)).toEqual({ pending: 0, running: 0 });
      expect(counts(b)).toEqual({ pending: 0, running: 0 });
    });
  });
});
