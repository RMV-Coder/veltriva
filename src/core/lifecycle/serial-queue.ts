// A per-tab serial operation queue (assessment §4.11 item 1): lifecycle operations on one tab
// never interleave, which is invariant I7 ("at most one lifecycle operation in flight"). Each
// operation re-validates what it acts on when its turn comes, since the tab may have changed
// while it waited.

export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #running = 0;

  /** Runs `operation` after every operation queued before it has settled. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const result = this.#tail.then(async () => {
      this.#running += 1;
      try {
        return await operation();
      } finally {
        this.#running -= 1;
        this.#pending -= 1;
      }
    });
    // The next operation waits for this one whether it succeeded or not.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Operations queued or running. */
  get pending(): number {
    return this.#pending;
  }

  /** Operations running right now: never more than one (I7). */
  get running(): number {
    return this.#running;
  }
}
