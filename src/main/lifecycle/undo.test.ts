// Undo for moves (assessment §4.12–§4.13, M3.3): the tabs one evaluation moved (or the user's own
// move to Sleeping or the Archive) are a batch the sidebar offers to undo for a minute. The timers
// are a clock a test moves, and `undoMoves` (TabManager's) is a fake that records what it was asked
// and answers what a test says it undid.
//
// `onChange` is how the sidebar learns the offer changed, so every test that counts its calls also
// looks at what `current()` said at each one (`seen`): the sidebar reads the offer when told.
import { describe, expect, it } from 'vitest';

import type { Timers } from '../../core/lifecycle/discard';
import type { PlacementMove } from '../../core/lifecycle/placement';
import type { MoveBatch } from './scheduler';
import { UNDO_WINDOW_MS, UndoManager } from './undo';
import type { UndoOffer } from './undo';

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
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
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
  }
}

/** A move to Sleeping (`shelf`) or to the Archive. */
function move(tabId: string, to: PlacementMove['to'] = 'shelf'): PlacementMove {
  return { tabId, from: to === 'archive' ? 'shelf' : 'strip', to, index: 0 };
}

function batchOf(id: string, moves: readonly PlacementMove[]): MoveBatch {
  return { id, at: 1_000, moves };
}

/** The second argument of `offer`: who made the moves. */
interface OfferFlag {
  readonly automated: boolean;
}
const AUTOMATED: OfferFlag = { automated: true };
const BY_USER: OfferFlag = { automated: false };

function build() {
  const timers = new ManualTimers();
  const state = {
    /** What `undoMoves` says it undid; null is all of them. */
    undone: null as readonly PlacementMove[] | null,
  };
  const asked: (readonly PlacementMove[])[] = [];
  /** `current()` at each `onChange`, then at each `undoMoves`. */
  const seen: (UndoOffer | null)[] = [];
  const duringUndo: (UndoOffer | null)[] = [];
  const undo: UndoManager = new UndoManager({
    timers,
    undoMoves: (moves) => {
      asked.push(moves);
      duringUndo.push(undo.current());
      return state.undone ?? moves;
    },
    onChange: () => {
      seen.push(undo.current());
    },
  });
  return { undo, timers, state, asked, seen, duringUndo };
}

describe('UndoManager: offering', () => {
  it('has nothing to undo at first, and arms nothing', () => {
    const h = build();
    expect(h.undo.current()).toBeNull();
    expect(h.timers.pending).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  it('offers a batch for UNDO_WINDOW_MS and tells the sidebar once', () => {
    const h = build();
    h.undo.offer(batchOf('batch-3', [move('a')]), AUTOMATED);

    const offer = { batchId: 'batch-3', automated: true, shelved: 1, archived: 0 };
    expect(h.undo.current()).toEqual(offer);
    expect(h.timers.pending).toEqual([UNDO_WINDOW_MS]);
    expect(h.seen).toEqual([offer]); // told once, and the offer was already there to read
  });

  it('counts the tabs shelved and the tabs archived', () => {
    const h = build();
    h.undo.offer(
      batchOf('batch-1', [
        move('a'),
        move('b', 'archive'),
        move('c'),
        move('d', 'archive'),
        move('e', 'archive'),
      ]),
      AUTOMATED,
    );
    expect(h.undo.current()).toMatchObject({ shelved: 2, archived: 3 });
  });

  it.each<[string, OfferFlag, boolean]>([
    ['automation', AUTOMATED, true],
    ['the user', BY_USER, false],
  ])('reports that %s made the moves, as it was given', (_who, options, automated) => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), options);
    expect(h.undo.current()).toEqual({ batchId: 'batch-1', automated, shelved: 1, archived: 0 });
  });

  it('ignores a batch with no moves: no offer, no timer, no change', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', []), AUTOMATED);
    expect(h.undo.current()).toBeNull();
    expect(h.timers.pending).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  it('does not let a batch with no moves replace an offer that stands, nor change its flag', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.timers.advance(10_000);
    h.undo.offer(batchOf('batch-2', []), BY_USER);

    expect(h.undo.current()).toEqual({
      batchId: 'batch-1',
      automated: true,
      shelved: 1,
      archived: 0,
    });
    expect(h.seen).toHaveLength(1);
    h.timers.advance(UNDO_WINDOW_MS - 10_000); // and its own window is the one that runs out
    expect(h.undo.current()).toBeNull();
  });

  it.each<[string, OfferFlag, OfferFlag]>([
    ['an automated offer with the user’s', AUTOMATED, BY_USER],
    ['the user’s offer with an automated one', BY_USER, AUTOMATED],
  ])('replaces %s, flag and all', (_name, older, newer) => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), older);
    h.undo.offer(batchOf('batch-2', [move('b'), move('c', 'archive')]), newer);

    expect(h.undo.current()).toEqual({
      batchId: 'batch-2',
      automated: newer.automated,
      shelved: 1,
      archived: 1,
    });
    expect(h.seen.map((offer) => offer?.batchId)).toEqual(['batch-1', 'batch-2']);
  });

  it('counts the window from the newer offer, with the older one’s timer gone', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.timers.advance(30_000);
    h.undo.offer(batchOf('batch-2', [move('b')]), AUTOMATED);
    expect(h.timers.pending).toEqual([UNDO_WINDOW_MS]); // one timer: the older one was cleared

    h.timers.advance(UNDO_WINDOW_MS - 30_000); // where the older offer would have expired
    expect(h.undo.current()?.batchId).toBe('batch-2');
    expect(h.seen).toHaveLength(2); // no change was announced for the older timer

    h.timers.advance(30_000);
    expect(h.undo.current()).toBeNull();
    expect(h.seen).toHaveLength(3);
  });

  it('never undoes the newer batch for a late click on the older one', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.undo.offer(batchOf('batch-2', [move('b')]), AUTOMATED);

    expect(h.undo.undo('batch-1')).toBeNull();
    h.undo.dismiss('batch-1');
    expect(h.asked).toEqual([]);
    expect(h.seen).toHaveLength(2); // nothing announced
    expect(h.undo.current()?.batchId).toBe('batch-2');

    expect(h.undo.undo('batch-2')).toEqual([move('b')]);
  });
});

describe('UndoManager: expiry', () => {
  it('ends the offer after UNDO_WINDOW_MS, and tells the sidebar it is gone', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);

    h.timers.advance(UNDO_WINDOW_MS - 1);
    expect(h.undo.current()).not.toBeNull();
    expect(h.seen).toHaveLength(1);

    h.timers.advance(1);
    expect(h.undo.current()).toBeNull();
    expect(h.seen.map((offer) => offer?.batchId)).toEqual(['batch-1', undefined]);
    expect(h.timers.pending).toEqual([]);
  });

  it('answers a click after the window with null, and undoes nothing', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.timers.advance(UNDO_WINDOW_MS);

    expect(h.undo.undo('batch-1')).toBeNull();
    h.undo.dismiss('batch-1');
    expect(h.asked).toEqual([]);
    expect(h.seen).toHaveLength(2); // the offer, and its expiry: nothing since
  });

  it('offers again after an expiry, for a full window', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.timers.advance(UNDO_WINDOW_MS);
    h.undo.offer(batchOf('batch-2', [move('b')]), BY_USER);

    h.timers.advance(UNDO_WINDOW_MS - 1);
    expect(h.undo.current()?.batchId).toBe('batch-2');
    h.timers.advance(1);
    expect(h.undo.current()).toBeNull();
  });
});

describe('UndoManager: undo', () => {
  it('puts the tabs back, answers what TabManager undid, and ends the offer', () => {
    const h = build();
    const moves = [move('a'), move('b', 'archive'), move('c')];
    h.undo.offer(batchOf('batch-1', moves), AUTOMATED);

    expect(h.undo.undo('batch-1')).toEqual(moves);
    expect(h.asked).toEqual([moves]);
    expect(h.undo.current()).toBeNull();
    expect(h.timers.pending).toEqual([]);
    expect(h.seen.map((offer) => offer?.batchId)).toEqual(['batch-1', undefined]);
  });

  it('answers what undoMoves returned, not the batch: a tab the user moved meanwhile stays put', () => {
    const h = build();
    const moves = [move('a'), move('b'), move('c')];
    h.undo.offer(batchOf('batch-1', moves), AUTOMATED);
    const undone = [move('a'), move('c')];
    h.state.undone = undone;

    expect(h.undo.undo('batch-1')).toBe(undone);
    expect(h.asked).toEqual([moves]); // it was asked to undo all three
  });

  it('answers an empty list, not null, when nothing could be put back', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.state.undone = [];

    expect(h.undo.undo('batch-1')).toEqual([]);
    expect(h.undo.current()).toBeNull(); // the offer is spent all the same
  });

  it('has already ended the offer when TabManager is asked', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.undo.undo('batch-1');
    expect(h.duringUndo).toEqual([null]);
  });

  it('undoes a batch once: the second click finds nothing', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    expect(h.undo.undo('batch-1')).not.toBeNull();
    expect(h.undo.undo('batch-1')).toBeNull();
    expect(h.asked).toHaveLength(1);
    expect(h.seen).toHaveLength(2);
  });

  it('answers null and changes nothing when nothing is offered', () => {
    const h = build();
    expect(h.undo.undo('batch-1')).toBeNull();
    expect(h.asked).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  it('answers null for the wrong id and leaves the offer as it was, timer and all', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    expect(h.undo.undo('batch-9')).toBeNull();

    expect(h.asked).toEqual([]);
    expect(h.undo.current()?.batchId).toBe('batch-1');
    expect(h.timers.pending).toEqual([UNDO_WINDOW_MS]);
    expect(h.seen).toHaveLength(1);
  });

  it('does not announce an expiry for an offer that was taken', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.undo.undo('batch-1');
    h.timers.advance(2 * UNDO_WINDOW_MS);
    expect(h.seen).toHaveLength(2);
  });

  it('offers the next batch after one was undone', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.undo.undo('batch-1');
    h.undo.offer(batchOf('batch-2', [move('b')]), BY_USER);
    expect(h.undo.current()).toEqual({
      batchId: 'batch-2',
      automated: false,
      shelved: 1,
      archived: 0,
    });
    expect(h.timers.pending).toEqual([UNDO_WINDOW_MS]);
  });
});

describe('UndoManager: dismiss', () => {
  it('ends the offer without undoing anything, and tells the sidebar', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.undo.dismiss('batch-1');

    expect(h.undo.current()).toBeNull();
    expect(h.asked).toEqual([]);
    expect(h.timers.pending).toEqual([]);
    expect(h.seen.map((offer) => offer?.batchId)).toEqual(['batch-1', undefined]);
    expect(h.undo.undo('batch-1')).toBeNull(); // dismissed means gone
  });

  it('does nothing for a stale id, or with nothing offered', () => {
    const h = build();
    h.undo.dismiss('batch-1');
    expect(h.seen).toEqual([]);

    h.undo.offer(batchOf('batch-2', [move('a')]), AUTOMATED);
    h.undo.dismiss('batch-1');
    expect(h.undo.current()?.batchId).toBe('batch-2');
    expect(h.timers.pending).toEqual([UNDO_WINDOW_MS]);
    expect(h.seen).toHaveLength(1);
  });

  it('announces once, however often it is clicked', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.undo.dismiss('batch-1');
    h.undo.dismiss('batch-1');
    expect(h.seen).toHaveLength(2);
  });
});

describe('UndoManager: stop()', () => {
  it('drops the offer and its timer without telling the sidebar', () => {
    const h = build();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    h.undo.stop();

    expect(h.undo.current()).toBeNull();
    expect(h.timers.pending).toEqual([]);
    h.timers.advance(2 * UNDO_WINDOW_MS);
    expect(h.seen).toHaveLength(1); // only the offer itself
    expect(h.undo.undo('batch-1')).toBeNull();
    expect(h.asked).toEqual([]);
  });

  it('is harmless with nothing offered, and twice', () => {
    const h = build();
    h.undo.stop();
    h.undo.stop();
    expect(h.undo.current()).toBeNull();
    expect(h.seen).toEqual([]);
  });

  it('ignores an offer that comes after it: a discard that settles during shutdown', () => {
    const h = build();
    h.undo.stop();
    h.undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    expect(h.undo.current()).toBeNull();
    expect(h.timers.pending).toEqual([]);
    expect(h.seen).toEqual([]);
  });
});

describe('UndoManager: a failing undo', () => {
  it('still takes the offer down and tells the sidebar, and lets the error through', () => {
    const timers = new ManualTimers();
    const seen: (UndoOffer | null)[] = [];
    const undo: UndoManager = new UndoManager({
      timers,
      undoMoves: () => {
        throw new Error('TabManager failed');
      },
      onChange: () => {
        seen.push(undo.current());
      },
    });
    undo.offer(batchOf('batch-1', [move('a')]), AUTOMATED);
    expect(() => undo.undo('batch-1')).toThrow('TabManager failed');
    expect(undo.current()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(timers.pending).toEqual([]);
  });
});
