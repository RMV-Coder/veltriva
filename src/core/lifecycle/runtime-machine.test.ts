import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  IllegalTransitionError,
  RUNTIME_STATES,
  canTransition,
  holdsWebContents,
  nextRuntime,
} from './runtime-machine';
import type { RuntimeEvent, RuntimeState } from './runtime-machine';

/**
 * Every legal transition, written out from the diagram at the top of runtime-machine.ts and from
 * assessment §4.3. It is a `Record` over the whole `RuntimeEvent` union, so adding an event to the
 * module makes `tsc -b` fail here until the new event is described.
 */
const LEGAL: Readonly<Record<RuntimeEvent, Partial<Record<RuntimeState, RuntimeState>>>> = {
  load: { unloaded: 'creating', creating: 'creating', crashed: 'creating' },
  ensureLive: { unloaded: 'creating', crashed: 'creating' },
  ready: { creating: 'live' },
  creationFailed: { creating: 'unloaded' },
  freeze: { live: 'frozen' },
  thaw: { frozen: 'live' },
  discard: { live: 'discarding', frozen: 'discarding' },
  discarded: { discarding: 'unloaded' },
  discardBlocked: { discarding: 'live' },
  revive: { discarding: 'creating' },
  rendererGone: { creating: 'crashed', live: 'crashed', frozen: 'crashed' },
  internalPage: {
    unloaded: 'unloaded',
    creating: 'unloaded',
    live: 'unloaded',
    frozen: 'unloaded',
    crashed: 'unloaded',
  },
  gone: { creating: 'unloaded', live: 'unloaded', frozen: 'unloaded', crashed: 'unloaded' },
};

const EVENTS = Object.keys(LEGAL) as RuntimeEvent[];

const legalPairs: [from: RuntimeState, event: RuntimeEvent, to: RuntimeState][] = [];
const illegalPairs: [from: RuntimeState, event: RuntimeEvent][] = [];
for (const from of RUNTIME_STATES) {
  for (const event of EVENTS) {
    const to = LEGAL[event][from];
    if (to === undefined) {
      illegalPairs.push([from, event]);
    } else {
      legalPairs.push([from, event, to]);
    }
  }
}

/** What `fn` throws, or undefined if it doesn't. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The state reached by sending `events` one after the other, starting at `start`. */
function walk(start: RuntimeState, ...events: RuntimeEvent[]): RuntimeState {
  return events.reduce<RuntimeState>((state, event) => nextRuntime(state, event), start);
}

/** The event names written in the `RuntimeEvent` union of runtime-machine.ts. */
function eventsInSource(): string[] {
  const source = readFileSync(new URL('./runtime-machine.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export type RuntimeEvent =');
  const end = source.indexOf('const TRANSITIONS');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/^\s*\|\s*'(\w+)'/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('the runtime states and events', () => {
  it('has the six states of assessment §4.3', () => {
    expect([...RUNTIME_STATES]).toEqual([
      'unloaded',
      'creating',
      'live',
      'frozen',
      'discarding',
      'crashed',
    ]);
  });

  it('is covered event for event: the tests know every event the module defines', () => {
    expect(eventsInSource().sort()).toEqual([...EVENTS].sort());
    expect(EVENTS).toHaveLength(13);
  });

  it('is covered pair for pair: every state meets every event exactly once below', () => {
    expect(legalPairs.length + illegalPairs.length).toBe(RUNTIME_STATES.length * EVENTS.length);
    expect(legalPairs).toHaveLength(26);
    expect(illegalPairs).toHaveLength(52);
  });
});

describe('nextRuntime, for a transition the diagram allows', () => {
  it.each(legalPairs)('%s, on %s, becomes %s', (from, event, to) => {
    expect(nextRuntime(from, event)).toBe(to);
  });
});

describe('nextRuntime, for a transition the diagram does not allow', () => {
  it.each(illegalPairs)('throws for %s on %s', (from, event) => {
    const error = thrownBy(() => nextRuntime(from, event));

    expect(error).toBeInstanceOf(IllegalTransitionError);
    expect(error).toMatchObject({ from, event });
  });
});

describe('canTransition', () => {
  it.each(legalPairs)('is true for %s on %s', (from, event) => {
    expect(canTransition(from, event)).toBe(true);
  });

  it.each(illegalPairs)('is false for %s on %s', (from, event) => {
    expect(canTransition(from, event)).toBe(false);
  });

  it('agrees with nextRuntime for every pair: it is true exactly when nextRuntime does not throw', () => {
    for (const from of RUNTIME_STATES) {
      for (const event of EVENTS) {
        const throws = thrownBy(() => nextRuntime(from, event)) !== undefined;

        expect(canTransition(from, event)).toBe(!throws);
      }
    }
  });
});

describe('IllegalTransitionError', () => {
  it('is an Error that names the state and the event', () => {
    const error = new IllegalTransitionError('live', 'ready');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(IllegalTransitionError);
    expect(error.name).toBe('IllegalTransitionError');
    expect(error.from).toBe('live');
    expect(error.event).toBe('ready');
    expect(error.message).toBe('Illegal runtime transition: ready from live');
  });

  it('is what nextRuntime throws, with the state and event it was given', () => {
    const error = thrownBy(() => nextRuntime('discarding', 'freeze'));

    expect(error).toBeInstanceOf(IllegalTransitionError);
    expect(error).toMatchObject({
      name: 'IllegalTransitionError',
      from: 'discarding',
      event: 'freeze',
      message: 'Illegal runtime transition: freeze from discarding',
    });
  });

  it('is not thrown by a legal transition, and nothing changes after a refused one', () => {
    expect(thrownBy(() => nextRuntime('live', 'freeze'))).toBeUndefined();
    expect(thrownBy(() => nextRuntime('live', 'ready'))).toBeInstanceOf(IllegalTransitionError);
    expect(nextRuntime('live', 'freeze')).toBe('frozen');
  });
});

describe('holdsWebContents (invariant I4: a view exists exactly in these runtimes)', () => {
  it.each([
    ['unloaded', false],
    ['creating', true],
    ['live', true],
    ['frozen', true],
    ['discarding', true],
    ['crashed', true],
  ] as const)('is %s -> %s', (state, holds) => {
    expect(holdsWebContents(state)).toBe(holds);
  });

  it('is false for unloaded and true for every other state', () => {
    for (const state of RUNTIME_STATES) {
      expect(holdsWebContents(state)).toBe(state !== 'unloaded');
    }
  });

  it('changes only when a transition creates or releases a web contents', () => {
    const creating: RuntimeEvent[] = ['load', 'ensureLive'];
    const releasing: RuntimeEvent[] = ['creationFailed', 'discarded', 'internalPage', 'gone'];

    for (const [from, event, to] of legalPairs) {
      if (!holdsWebContents(from) && holdsWebContents(to)) {
        expect(creating).toContain(event);
      }
      if (holdsWebContents(from) && !holdsWebContents(to)) {
        expect(releasing).toContain(event);
      }
    }
  });

  it('differs across a transition in exactly twelve cases: two creations and ten releases', () => {
    const changes = legalPairs.filter(
      ([from, , to]) => holdsWebContents(from) !== holdsWebContents(to),
    );

    expect(changes.map(([from, event]) => `${from}:${event}`).sort()).toEqual(
      [
        'unloaded:load',
        'unloaded:ensureLive',
        'crashed:internalPage',
        'creating:creationFailed',
        'creating:internalPage',
        'creating:gone',
        'live:internalPage',
        'live:gone',
        'frozen:internalPage',
        'frozen:gone',
        'discarding:discarded',
        'crashed:gone',
      ].sort(),
    );
  });
});

describe('what the diagram says in words', () => {
  it('lets a discard leave discarding only three ways: discarded, discardBlocked or revive', () => {
    const exits = EVENTS.filter((event) => canTransition('discarding', event));

    expect(exits.sort()).toEqual(['discardBlocked', 'discarded', 'revive']);
  });

  it('does not let internalPage or gone happen to a discarding tab', () => {
    expect(canTransition('discarding', 'internalPage')).toBe(false);
    expect(canTransition('discarding', 'gone')).toBe(false);
  });

  it('lets gone happen only to a tab that has a web contents (the diagram says "anything but discarding"; an unloaded tab has none to lose)', () => {
    expect(canTransition('unloaded', 'gone')).toBe(false);
    expect(canTransition('unloaded', 'internalPage')).toBe(true);
  });

  it('closes the web contents on internalPage, wherever the tab was (except while discarding)', () => {
    for (const from of RUNTIME_STATES.filter((state) => state !== 'discarding')) {
      expect(nextRuntime(from, 'internalPage')).toBe('unloaded');
    }
  });

  it('only freezes a live tab and only thaws a frozen one', () => {
    expect(RUNTIME_STATES.filter((state) => canTransition(state, 'freeze'))).toEqual(['live']);
    expect(RUNTIME_STATES.filter((state) => canTransition(state, 'thaw'))).toEqual(['frozen']);
  });

  it('only discards a live or frozen tab', () => {
    expect(RUNTIME_STATES.filter((state) => canTransition(state, 'discard'))).toEqual([
      'live',
      'frozen',
    ]);
  });

  it('only brings an unloaded or crashed tab back with ensureLive', () => {
    expect(RUNTIME_STATES.filter((state) => canTransition(state, 'ensureLive'))).toEqual([
      'unloaded',
      'crashed',
    ]);
  });

  it('lets load also reach a tab that is still creating, which stays creating', () => {
    expect(nextRuntime('creating', 'load')).toBe('creating');
    expect(canTransition('creating', 'ensureLive')).toBe(false);
  });

  it('crashes a tab that is creating, live or frozen, and never a discarding or unloaded one', () => {
    expect(RUNTIME_STATES.filter((state) => canTransition(state, 'rendererGone'))).toEqual([
      'creating',
      'live',
      'frozen',
    ]);
  });

  it('only reaches live through ready (from creating), thaw (from frozen) or discardBlocked', () => {
    const into = legalPairs.filter(([, , to]) => to === 'live');

    expect(into.map(([from, event]) => `${from}:${event}`).sort()).toEqual([
      'creating:ready',
      'discarding:discardBlocked',
      'frozen:thaw',
    ]);
  });
});

describe('assessment §4.3, row by row', () => {
  it.each([
    ['UNLOADED', 'ensureLive', 'unloaded', 'ensureLive', 'creating'],
    ['CREATING', 'view ready', 'creating', 'ready', 'live'],
    ['CREATING', 'creation threw', 'creating', 'creationFailed', 'unloaded'],
    ['LIVE', 'freeze', 'live', 'freeze', 'frozen'],
    ['FROZEN', 'thaw', 'frozen', 'thaw', 'live'],
    ['LIVE', 'discard', 'live', 'discard', 'discarding'],
    ['FROZEN', 'discard', 'frozen', 'discard', 'discarding'],
    ['DISCARDING', 'destroyed', 'discarding', 'discarded', 'unloaded'],
    [
      'DISCARDING',
      'will-prevent-unload, dirty probe or 5 s timeout',
      'discarding',
      'discardBlocked',
      'live',
    ],
    ['LIVE', 'render-process-gone', 'live', 'rendererGone', 'crashed'],
    ['FROZEN', 'render-process-gone', 'frozen', 'rendererGone', 'crashed'],
    ['CRASHED', 'ensureLive (Reload)', 'crashed', 'ensureLive', 'creating'],
  ] as const)('%s, on %s', (_row, _what, from, event, to) => {
    expect(nextRuntime(from, event)).toBe(to);
  });
});

describe('walks through the diagram', () => {
  it('opens a tab: unloaded, creating, live', () => {
    expect(walk('unloaded', 'ensureLive', 'ready')).toBe('live');
  });

  it('retries a failed creation from unloaded', () => {
    expect(walk('unloaded', 'ensureLive', 'creationFailed', 'ensureLive', 'ready')).toBe('live');
  });

  it('discards a live tab and brings it back', () => {
    expect(walk('live', 'discard', 'discarded')).toBe('unloaded');
    expect(walk('live', 'discard', 'discarded', 'ensureLive', 'ready')).toBe('live');
  });

  it('lets a blocked discard leave the tab live, and discards it again later', () => {
    expect(walk('live', 'discard', 'discardBlocked')).toBe('live');
    expect(walk('live', 'discard', 'discardBlocked', 'discard', 'discarded')).toBe('unloaded');
  });

  it('revives a tab that was selected while it was closing', () => {
    expect(walk('live', 'discard', 'revive')).toBe('creating');
    expect(walk('live', 'discard', 'revive', 'ready')).toBe('live');
  });

  it('discards a frozen tab', () => {
    expect(walk('live', 'freeze', 'discard', 'discarded')).toBe('unloaded');
  });

  it('freezes and thaws without losing the live state', () => {
    expect(walk('live', 'freeze', 'thaw')).toBe('live');
  });

  it('recovers a crashed tab through creating, by Reload or by selecting it', () => {
    expect(walk('live', 'rendererGone', 'ensureLive', 'ready')).toBe('live');
    expect(walk('live', 'rendererGone', 'load', 'ready')).toBe('live');
  });

  it('goes to a new-tab page from any state that has a web contents and comes back with load', () => {
    expect(walk('live', 'internalPage')).toBe('unloaded');
    expect(walk('crashed', 'internalPage', 'load', 'ready')).toBe('live');
  });

  it('refuses a ready that arrives for a tab that is no longer creating', () => {
    expect(() => walk('unloaded', 'ensureLive', 'gone', 'ready')).toThrow(IllegalTransitionError);
  });

  it('refuses a second discard while one is under way', () => {
    expect(() => walk('live', 'discard', 'discard')).toThrow(IllegalTransitionError);
  });
});

/** Every state a tab can reach from `start` (itself included) through legal transitions. */
function reachableFrom(start: RuntimeState): Set<RuntimeState> {
  const seen = new Set<RuntimeState>([start]);
  const queue: RuntimeState[] = [start];
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    for (const event of EVENTS) {
      if (canTransition(state, event)) {
        const to = nextRuntime(state, event);
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
  }
  return seen;
}

describe('reachability', () => {
  it('reaches every state from unloaded, so no state is dead code', () => {
    expect([...reachableFrom('unloaded')].sort()).toEqual([...RUNTIME_STATES].sort());
  });

  it('lets every state be left by at least one event, so a tab can never get stuck', () => {
    for (const state of RUNTIME_STATES) {
      expect(EVENTS.some((event) => canTransition(state, event))).toBe(true);
    }
  });

  it('can get from every state back to live', () => {
    for (const start of RUNTIME_STATES) {
      expect(reachableFrom(start).has('live')).toBe(true);
    }
  });
});
