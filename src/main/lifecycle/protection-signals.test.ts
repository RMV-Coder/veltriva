// The protections automation reads from each tab's web contents (assessment §4.10): audio (and the
// 2 minutes after it), capture, DevTools and an open popup. The web contents are fakes that
// implement the five members the module uses, and throw when touched after being destroyed, as
// Electron's do.
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';

import { protectionFor } from '../../core/lifecycle/protections';
import type { Protection } from '../../core/lifecycle/protections';
import type { TabId } from '../tabs/tab-manager';
import { AUDIO_GRACE_MS, ProtectionSignals } from './protection-signals';

/** A tab's web contents: the signals are fields a test sets; events fire on demand. */
class FakeContents {
  destroyed = false;
  audible = false;
  captured = false;
  devTools = false;
  /** Every `on(event)` call, in order. */
  readonly registered: string[] = [];
  readonly #listeners = new Map<string, (() => void)[]>();

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isCurrentlyAudible(): boolean {
    return this.#alive(this.audible);
  }
  isBeingCaptured(): boolean {
    return this.#alive(this.captured);
  }
  isDevToolsOpened(): boolean {
    return this.#alive(this.devTools);
  }
  on(event: string, listener: () => void): this {
    this.registered.push(event);
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener();
    }
  }

  /** What Electron does for a destroyed object: it throws. */
  #alive(value: boolean): boolean {
    if (this.destroyed) {
      throw new TypeError('Object has been destroyed');
    }
    return value;
  }
}

const asContents = (contents: FakeContents): WebContents => contents as unknown as WebContents;

const reasons = (protections: readonly Protection[]): string[] =>
  protections.map((protection) => protection.reason);

function build() {
  const clock = { now: 1_000_000 };
  const contents = new Map<TabId, FakeContents>();
  const popups = new Set<TabId>();
  const signals = new ProtectionSignals({
    contentsOf: (tabId) => {
      const found = contents.get(tabId);
      return found === undefined ? undefined : asContents(found);
    },
    hasOpenPopup: (tabId) => popups.has(tabId),
    now: () => clock.now,
  });
  /** A tab with fresh web contents. */
  const open = (tabId: TabId): FakeContents => {
    const fresh = new FakeContents();
    contents.set(tabId, fresh);
    return fresh;
  };
  return { signals, clock, contents, popups, open };
}

describe('ProtectionSignals: nothing to protect', () => {
  it('has none for a quiet tab', () => {
    const h = build();
    h.open('a');
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('has none for a tab without web contents', () => {
    const h = build();
    expect(h.signals.protectionsOf('unloaded')).toEqual([]);
  });

  it('has none for destroyed web contents, and does not touch them', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    tab.captured = true;
    tab.devTools = true;
    tab.destroyed = true;
    expect(h.signals.protectionsOf('a')).toEqual([]);
    expect(tab.registered).toEqual([]); // not even watched
  });

  it('has none once the contents is destroyed, even inside the audio grace period', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
    h.clock.now += 1_000;
    tab.destroyed = true;
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });
});

describe('ProtectionSignals: audio', () => {
  it('protects a tab while it is audible', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    expect(h.signals.protectionsOf('a')).toEqual([protectionFor('audio')]);
    h.clock.now += 10 * AUDIO_GRACE_MS;
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']); // still audible: always fresh
  });

  it('returns the shared protection objects: hard, and blocking freeze, discard and shelve', () => {
    const h = build();
    h.open('a').audible = true;
    const [audio] = h.signals.protectionsOf('a');
    expect(audio).toBe(protectionFor('audio'));
    expect(audio).toMatchObject({ hard: true, blocks: ['freeze', 'discard', 'shelve'] });
  });

  it('keeps protecting for AUDIO_GRACE_MS after an evaluation last heard it, and not a millisecond longer', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    h.signals.protectionsOf('a'); // heard now
    tab.audible = false;

    h.clock.now += AUDIO_GRACE_MS - 1;
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
    h.clock.now += 1;
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('starts the grace period when the audio-state-changed event says it stopped, not at the next evaluation', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']); // heard, and watched from now

    // 30 s later the page goes quiet; main hears it at once.
    h.clock.now += 30_000;
    tab.audible = false;
    tab.emit('audio-state-changed');

    // The next evaluation comes long after the last one, but not after the grace period of the stop.
    h.clock.now += AUDIO_GRACE_MS - 1;
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
    h.clock.now += 1;
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('would have let go earlier without the event (the point of listening)', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    h.signals.protectionsOf('a');
    h.clock.now += 30_000;
    tab.audible = false; // no event
    h.clock.now += AUDIO_GRACE_MS - 30_000;
    expect(h.signals.protectionsOf('a')).toEqual([]); // 2 minutes since it was last heard
  });

  it('also notes audio that starts: the event counts as heard', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.protectionsOf('a'); // watched
    h.clock.now += 5_000;
    tab.emit('audio-state-changed'); // the page started and stopped between evaluations
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
  });

  it('ignores an event from web contents that is destroyed', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.protectionsOf('a'); // watched
    tab.destroyed = true;
    tab.emit('audio-state-changed'); // must not read anything, or note anything
    tab.destroyed = false; // (the fake can be revived; the real one cannot)
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('does not protect on a clock that went backwards', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    h.signals.protectionsOf('a'); // heard at 1,000,000
    tab.audible = false;
    h.clock.now -= 60_000;
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('keeps what was heard per web contents: a tab that got new contents starts clean', () => {
    const h = build();
    const first = h.open('a');
    first.audible = true;
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);

    h.clock.now += 1_000;
    h.open('a'); // the tab was discarded and restored: a new web contents
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('keeps what was heard per tab: another tab is unaffected', () => {
    const h = build();
    h.open('a').audible = true;
    h.open('b');
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
    expect(h.signals.protectionsOf('b')).toEqual([]);
  });
});

describe('ProtectionSignals: capture, DevTools and popups', () => {
  it('protects a tab whose page is being captured', () => {
    const h = build();
    h.open('a').captured = true;
    expect(h.signals.protectionsOf('a')).toEqual([protectionFor('capture')]);
    expect(protectionFor('capture').blocks).toEqual(['freeze', 'discard', 'shelve', 'archive']);
  });

  it('protects a tab whose DevTools are open, for as long as they are', () => {
    const h = build();
    const tab = h.open('a');
    tab.devTools = true;
    expect(h.signals.protectionsOf('a')).toEqual([protectionFor('devtools')]);
    tab.devTools = false;
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('protects a tab that has an open popup, and only that tab', () => {
    const h = build();
    h.open('a');
    h.open('b');
    h.popups.add('a');
    expect(h.signals.protectionsOf('a')).toEqual([protectionFor('open-popup')]);
    expect(h.signals.protectionsOf('b')).toEqual([]);
    h.popups.delete('a');
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('protects a tab with an open popup even when it has no web contents or a destroyed one', () => {
    const h = build();
    h.popups.add('unloaded');
    expect(reasons(h.signals.protectionsOf('unloaded'))).toEqual(['open-popup']);

    const tab = h.open('gone');
    tab.destroyed = true;
    h.popups.add('gone');
    expect(reasons(h.signals.protectionsOf('gone'))).toEqual(['open-popup']);
  });

  it('lists every protection a tab has, in a fixed order', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    tab.captured = true;
    tab.devTools = true;
    h.popups.add('a');
    expect(reasons(h.signals.protectionsOf('a'))).toEqual([
      'audio',
      'capture',
      'devtools',
      'open-popup',
    ]);
  });

  it('answers with a new list each time', () => {
    const h = build();
    h.open('a').devTools = true;
    const first = h.signals.protectionsOf('a');
    first.length = 0;
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['devtools']);
  });
});

describe('ProtectionSignals: the listener', () => {
  it('registers audio-state-changed once per web contents, however often it is read', () => {
    const h = build();
    const tab = h.open('a');
    for (let i = 0; i < 5; i += 1) {
      h.signals.protectionsOf('a');
    }
    expect(tab.registered).toEqual(['audio-state-changed']);
  });

  it('registers on each web contents a tab gets, and on each tab', () => {
    const h = build();
    const first = h.open('a');
    const second = h.open('b');
    h.signals.protectionsOf('a');
    h.signals.protectionsOf('b');
    h.signals.protectionsOf('a');
    expect(first.registered).toEqual(['audio-state-changed']);
    expect(second.registered).toEqual(['audio-state-changed']);

    const replacement = h.open('a');
    h.signals.protectionsOf('a');
    h.signals.protectionsOf('a');
    expect(replacement.registered).toEqual(['audio-state-changed']);
    expect(first.registered).toEqual(['audio-state-changed']);
  });
});
