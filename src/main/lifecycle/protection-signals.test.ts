// The protections automation reads from each tab's web contents (assessment §4.10): audio (and the
// 2 minutes after it), capture (and the camera or microphone granted to the page), DevTools and an
// open popup. Notifications and a protected site come from the tab's address as TabManager has it
// (`urlOf`), so they hold for a tab with no web contents too. Playing media is not read here: the
// discard's probe asks the page, so the monitor never reports 'video' and does not listen to
// Chromium's `media-started-playing` and `media-paused` (they have no end for a Web Audio context
// a page keeps open). The web contents are fakes that implement the members the module uses, emit
// the events it listens to, and throw when touched after being destroyed, as Electron's do. They
// have no `getURL`: the monitor must not read the page's address from them.
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';

import type { Timers } from '../../core/lifecycle/discard';
import { protectionFor } from '../../core/lifecycle/protections';
import type { Protection } from '../../core/lifecycle/protections';
import type { TabId } from '../tabs/tab-manager';
import { AUDIO_GRACE_MS, ProtectionSignals } from './protection-signals';
import type { ProtectionSignalsOptions } from './protection-signals';

interface Listener {
  readonly callback: () => void;
  readonly once: boolean;
}

/** A tab's web contents: the signals are fields a test sets; events fire on demand. */
class FakeContents {
  destroyed = false;
  audible = false;
  captured = false;
  devTools = false;
  /** Every `on(event)` and `once(event)` call, in order. */
  readonly registered: string[] = [];
  readonly #listeners = new Map<string, Listener[]>();

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
  on(event: string, callback: () => void): this {
    this.registered.push(event);
    this.#add(event, { callback, once: false });
    return this;
  }
  once(event: string, callback: () => void): this {
    this.registered.push(event);
    this.#add(event, { callback, once: true });
    return this;
  }

  emit(event: string): void {
    const listeners = this.#listeners.get(event) ?? [];
    this.#listeners.set(
      event,
      listeners.filter((listener) => !listener.once),
    );
    for (const listener of listeners) {
      listener.callback();
    }
  }

  /** How many listeners are attached for this event now (a once listener counts until it fires). */
  listenerCount(event: string): number {
    return (this.#listeners.get(event) ?? []).length;
  }

  #add(event: string, listener: Listener): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  /** What Electron does for a destroyed object: it throws. */
  #alive<T>(value: T): T {
    if (this.destroyed) {
      throw new TypeError('Object has been destroyed');
    }
    return value;
  }
}

/** Timers a test fires by hand. */
class ManualTimers implements Timers {
  #next = 1;
  readonly #pending = new Map<number, { readonly callback: () => void; readonly ms: number }>();

  setTimeout(callback: () => void, ms: number): number {
    const handle = this.#next;
    this.#next += 1;
    this.#pending.set(handle, { callback, ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.#pending.delete(handle);
    }
  }

  /** The delays of the timers still pending, oldest first. */
  get pending(): number[] {
    return [...this.#pending.values()].map((timer) => timer.ms);
  }

  /** Fires every pending timer. */
  fireAll(): void {
    for (const [handle, timer] of [...this.#pending]) {
      this.#pending.delete(handle);
      timer.callback();
    }
  }
}

const asContents = (contents: FakeContents): WebContents => contents as unknown as WebContents;

const reasons = (protections: readonly Protection[]): string[] =>
  protections.map((protection) => protection.reason);

/** Options a test sets; one given as `undefined` is left out altogether (no `urlOf`, no timers). */
type Overrides = {
  readonly [K in keyof ProtectionSignalsOptions]?: ProtectionSignalsOptions[K] | undefined;
};

function build(overrides: Overrides = {}) {
  const clock = { now: 1_000_000 };
  const contents = new Map<TabId, FakeContents>();
  const popups = new Set<TabId>();
  /** The address of each tab's page as TabManager has it; '' for a tab that has none. */
  const urls = new Map<TabId, string>();
  const state = { changes: 0 };
  const timers = new ManualTimers();
  const merged: Record<string, unknown> = {
    contentsOf: (tabId: TabId) => {
      const found = contents.get(tabId);
      return found === undefined ? undefined : asContents(found);
    },
    hasOpenPopup: (tabId: TabId) => popups.has(tabId),
    urlOf: (tabId: TabId) => urls.get(tabId) ?? '',
    now: () => clock.now,
    onChange: () => {
      state.changes += 1;
    },
    timers,
    ...overrides,
  };
  const signals = new ProtectionSignals(
    Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    ) as unknown as ProtectionSignalsOptions,
  );
  /** A tab with fresh web contents. */
  const open = (tabId: TabId): FakeContents => {
    const fresh = new FakeContents();
    contents.set(tabId, fresh);
    return fresh;
  };
  /** A tab with fresh web contents the monitor already watches, as TabManager does at creation. */
  const openWatched = (tabId: TabId): FakeContents => {
    const fresh = open(tabId);
    signals.attach(asContents(fresh));
    return fresh;
  };
  return { signals, clock, contents, popups, urls, open, openWatched, state, timers };
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

  it('has none for a destroyed contents that was granted the camera and heard', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.audible = true;
    h.signals.mediaGranted(asContents(tab));
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio', 'capture']);
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

describe('ProtectionSignals: video is not read here (the discard probe asks the page)', () => {
  const MEDIA_EVENTS = ['media-started-playing', 'media-paused'] as const;

  it('never reports video for a quiet tab, whatever media events Chromium sends', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('media-started-playing');
    tab.emit('media-started-playing');
    expect(h.signals.protectionsOf('a')).toEqual([]);
    tab.emit('media-paused');
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('never reports video for a tab that never gets a media-paused (a Web Audio context left open)', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('media-started-playing'); // and the page never pauses: this is what stuck the old counter
    h.clock.now += 10 * AUDIO_GRACE_MS;
    expect(h.signals.protectionsOf('a')).toEqual([]);
    expect(reasons(h.signals.protectionsOf('a'))).not.toContain('video');
  });

  it('never reports video, as the sole protection or beside the others', () => {
    const h = build({ notificationsAllowed: () => true, siteProtected: () => true });
    const tab = h.openWatched('a');
    h.urls.set('a', 'https://chat.example/room');
    tab.audible = true;
    tab.captured = true;
    tab.devTools = true;
    h.popups.add('a');
    for (const event of MEDIA_EVENTS) {
      tab.emit(event);
    }
    expect(reasons(h.signals.protectionsOf('a'))).toEqual([
      'audio',
      'capture',
      'devtools',
      'open-popup',
      'notifications',
      'protected-site',
    ]);
  });

  it('does not listen to media-started-playing or media-paused: no listener, however the tab is reached', () => {
    const h = build();
    const attached = h.open('a');
    h.signals.attach(asContents(attached));
    const read = h.open('b');
    h.signals.protectionsOf('b'); // reading a tab watches it
    const granted = h.open('c');
    h.signals.mediaGranted(asContents(granted)); // so does a grant
    for (const tab of [attached, read, granted]) {
      for (const event of MEDIA_EVENTS) {
        expect(tab.listenerCount(event), event).toBe(0);
        expect(tab.registered, event).not.toContain(event);
      }
    }
  });

  it('is not told by a media event: nothing the sidebar shows changed', () => {
    const h = build();
    const tab = h.openWatched('a');
    for (const event of MEDIA_EVENTS) {
      tab.emit(event);
    }
    tab.emit('media-started-playing');
    expect(h.state.changes).toBe(0);
    expect(h.timers.pending).toEqual([]);
  });

  it('does not take a media event for sound: it neither starts the audio grace nor refreshes it', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('media-started-playing');
    expect(h.signals.protectionsOf('a')).toEqual([]);

    tab.audible = true;
    h.signals.protectionsOf('a'); // heard now
    tab.audible = false;
    h.clock.now += AUDIO_GRACE_MS - 1;
    tab.emit('media-paused'); // would extend the grace if it counted as audio
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
    h.clock.now += 1;
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('does not take a media event for a capture or a new document', () => {
    const h = build();
    const tab = h.openWatched('a');
    h.signals.mediaGranted(asContents(tab));
    h.state.changes = 0;
    for (const event of MEDIA_EVENTS) {
      tab.emit(event);
    }
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']); // the grant stays
    expect(h.state.changes).toBe(0);
  });

  it('reports a muted tab that plays only through audio, which Chromium still calls audible', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('media-started-playing');
    tab.audible = true; // a muted tab that plays still reports audible (S1)
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
  });
});

describe('ProtectionSignals: capture', () => {
  it('protects a tab whose page is being captured', () => {
    const h = build();
    h.open('a').captured = true;
    expect(h.signals.protectionsOf('a')).toEqual([protectionFor('capture')]);
    expect(protectionFor('capture').blocks).toEqual(['freeze', 'discard', 'shelve', 'archive']);
  });

  it('protects a tab the permission broker granted the camera or the microphone', () => {
    const h = build();
    const tab = h.open('a');
    expect(h.signals.protectionsOf('a')).toEqual([]);

    h.signals.mediaGranted(asContents(tab));
    expect(h.signals.protectionsOf('a')).toEqual([protectionFor('capture')]);
  });

  it('keeps protecting after the grant, however many evaluations come, though isBeingCaptured says no', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.mediaGranted(asContents(tab));
    tab.captured = false;
    for (let i = 0; i < 3; i += 1) {
      h.clock.now += AUDIO_GRACE_MS;
      expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);
    }
  });

  it('lets go when the next document commits (did-navigate): chromium does not say when capture stops', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.mediaGranted(asContents(tab));
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);

    tab.emit('did-navigate');
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('protects again from a new grant on the next document', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.mediaGranted(asContents(tab));
    tab.emit('did-navigate');
    h.signals.mediaGranted(asContents(tab));
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);
  });

  it('still protects after the navigation if the page is captured by what isBeingCaptured says', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.mediaGranted(asContents(tab));
    tab.captured = true;
    tab.emit('did-navigate');
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);
  });

  it('is protected once for a grant and a capture together', () => {
    const h = build();
    const tab = h.open('a');
    tab.captured = true;
    h.signals.mediaGranted(asContents(tab));
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);
  });

  it('starts watching web contents it is told about before any evaluation', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.mediaGranted(asContents(tab));
    expect(tab.registered).toEqual(['audio-state-changed', 'did-navigate', 'destroyed']);
  });

  it('ignores a grant to web contents that is destroyed: nothing is watched, nothing announced', () => {
    const h = build();
    const tab = h.open('a');
    tab.destroyed = true;
    h.signals.mediaGranted(asContents(tab));
    expect(tab.registered).toEqual([]);
    expect(h.state.changes).toBe(0);
    tab.destroyed = false;
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  it('keeps a grant per web contents: a tab that got new contents starts clean', () => {
    const h = build();
    h.signals.mediaGranted(asContents(h.open('a')));
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);

    h.open('a');
    expect(h.signals.protectionsOf('a')).toEqual([]);
  });

  describe('with a reader of its own (test builds, where focus emulation reports every page captured)', () => {
    it('reads its answer instead of isBeingCaptured', () => {
      const asked: FakeContents[] = [];
      const h = build({
        isCaptured: (contents) => {
          asked.push(contents as unknown as FakeContents);
          return false;
        },
      });
      const tab = h.open('a');
      tab.captured = true; // what the real one would (wrongly) say

      expect(h.signals.protectionsOf('a')).toEqual([]);
      expect(asked).toEqual([tab]);
    });

    it('protects when its reader says captured, whatever isBeingCaptured says', () => {
      const h = build({ isCaptured: () => true });
      h.open('a');
      expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);
    });

    it('still protects a grant, which no reader overrules', () => {
      const h = build({ isCaptured: () => false });
      const tab = h.open('a');
      h.signals.mediaGranted(asContents(tab));
      expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);
    });

    it('is not asked for a tab without web contents or with destroyed contents', () => {
      let asks = 0;
      const h = build({
        isCaptured: () => {
          asks += 1;
          return false;
        },
      });
      h.open('gone').destroyed = true;
      h.signals.protectionsOf('missing');
      h.signals.protectionsOf('gone');
      expect(asks).toBe(0);
    });
  });
});

describe('ProtectionSignals: DevTools and popups', () => {
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
    const h = build({
      notificationsAllowed: () => true,
      siteProtected: () => true,
    });
    const tab = h.openWatched('a');
    h.urls.set('a', 'https://chat.example/room');
    tab.audible = true;
    tab.captured = true;
    tab.devTools = true;
    h.popups.add('a');
    expect(reasons(h.signals.protectionsOf('a'))).toEqual([
      'audio',
      'capture',
      'devtools',
      'open-popup',
      'notifications',
      'protected-site',
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

describe('ProtectionSignals: notifications and a protected site (the tab address from TabManager)', () => {
  const CHAT = 'https://chat.example/room/1';
  const OTHER = 'https://other.example/';

  describe('notifications', () => {
    it('protects a tab whose page the user allowed to show notifications', () => {
      const h = build({ notificationsAllowed: (url) => url === CHAT });
      h.open('a');
      h.urls.set('a', CHAT);
      expect(h.signals.protectionsOf('a')).toEqual([protectionFor('notifications')]);
    });

    it('returns the shared protection: soft, so critical pressure may override it', () => {
      const h = build({ notificationsAllowed: () => true });
      h.open('a');
      h.urls.set('a', CHAT);
      const [notifications] = h.signals.protectionsOf('a');
      expect(notifications).toBe(protectionFor('notifications'));
      expect(notifications).toMatchObject({ hard: false, blocks: ['freeze', 'discard'] });
    });

    it('does not protect a page the user did not allow', () => {
      const h = build({ notificationsAllowed: (url) => url === CHAT });
      h.open('a');
      h.urls.set('a', OTHER);
      expect(h.signals.protectionsOf('a')).toEqual([]);
    });

    it('asks about the address the tab has now, every time', () => {
      const asked: string[] = [];
      const h = build({
        notificationsAllowed: (url) => {
          asked.push(url);
          return url === CHAT;
        },
      });
      h.open('a');
      h.urls.set('a', OTHER);
      expect(h.signals.protectionsOf('a')).toEqual([]);
      h.urls.set('a', CHAT);
      expect(reasons(h.signals.protectionsOf('a'))).toEqual(['notifications']);
      h.urls.set('a', OTHER);
      expect(h.signals.protectionsOf('a')).toEqual([]);
      expect(asked).toEqual([OTHER, CHAT, OTHER]);
    });

    it('asks urlOf about the tab it is evaluating', () => {
      const asked: string[] = [];
      const h = build({
        urlOf: (tabId) => {
          asked.push(tabId);
          return CHAT;
        },
        notificationsAllowed: () => true,
      });
      h.open('a');
      h.open('b');
      h.signals.protectionsOf('a');
      h.signals.protectionsOf('b');
      expect(asked).toEqual(['a', 'b']);
    });

    it('protects a tab with no web contents (an unloaded one) as well', () => {
      const h = build({ notificationsAllowed: (url) => url === CHAT });
      h.urls.set('unloaded', CHAT);
      expect(h.signals.protectionsOf('unloaded')).toEqual([protectionFor('notifications')]);
    });

    it('protects a tab whose web contents is destroyed, by its address', () => {
      const h = build({ notificationsAllowed: () => true });
      h.open('gone').destroyed = true;
      h.urls.set('gone', CHAT);
      expect(reasons(h.signals.protectionsOf('gone'))).toEqual(['notifications']);
    });

    it('is not asked, and does not protect, for a tab with no address', () => {
      let asks = 0;
      const h = build({
        notificationsAllowed: () => {
          asks += 1;
          return true;
        },
      });
      h.open('a'); // no address yet
      h.urls.set('b', '');
      expect(h.signals.protectionsOf('a')).toEqual([]);
      expect(h.signals.protectionsOf('b')).toEqual([]);
      expect(h.signals.protectionsOf('missing')).toEqual([]);
      expect(asks).toBe(0);
    });

    it('protects nothing when no reader is given', () => {
      const h = build();
      h.open('a');
      h.urls.set('a', CHAT);
      expect(h.signals.protectionsOf('a')).toEqual([]);
    });

    it('counts only an answer of true', () => {
      const h = build({ notificationsAllowed: () => false });
      h.open('a');
      h.urls.set('a', CHAT);
      expect(h.signals.protectionsOf('a')).toEqual([]);
    });
  });

  describe('protected site', () => {
    it('protects a tab whose page is on a site the user protects', () => {
      const h = build({ siteProtected: (url) => url.startsWith('https://chat.example/') });
      h.open('a');
      h.urls.set('a', CHAT);
      expect(h.signals.protectionsOf('a')).toEqual([protectionFor('protected-site')]);
    });

    it('returns the shared protection: hard, and blocking all four actions', () => {
      const h = build({ siteProtected: () => true });
      h.open('a');
      h.urls.set('a', CHAT);
      const [site] = h.signals.protectionsOf('a');
      expect(site).toBe(protectionFor('protected-site'));
      expect(site).toMatchObject({
        hard: true,
        blocks: ['freeze', 'discard', 'shelve', 'archive'],
      });
    });

    it('does not protect a page on another site', () => {
      const h = build({ siteProtected: (url) => url.startsWith('https://chat.example/') });
      h.open('a');
      h.urls.set('a', OTHER);
      expect(h.signals.protectionsOf('a')).toEqual([]);
    });

    it('follows the tab to a site that is protected, and away from it', () => {
      const protectedUrls = new Set([CHAT]);
      const h = build({ siteProtected: (url) => protectedUrls.has(url) });
      h.open('a');
      h.urls.set('a', OTHER);
      expect(h.signals.protectionsOf('a')).toEqual([]);
      h.urls.set('a', CHAT);
      expect(reasons(h.signals.protectionsOf('a'))).toEqual(['protected-site']);
      protectedUrls.delete(CHAT); // the user stopped protecting it
      expect(h.signals.protectionsOf('a')).toEqual([]);
    });

    it('protects a tab with no web contents (an unloaded one of a protected site)', () => {
      const h = build({ siteProtected: (url) => url === CHAT });
      h.urls.set('unloaded', CHAT);
      expect(h.signals.protectionsOf('unloaded')).toEqual([protectionFor('protected-site')]);
    });

    it('protects a tab whose web contents is destroyed, by its address', () => {
      const h = build({ siteProtected: () => true });
      h.open('gone').destroyed = true;
      h.urls.set('gone', CHAT);
      expect(reasons(h.signals.protectionsOf('gone'))).toEqual(['protected-site']);
    });

    it('does not read anything of destroyed web contents to protect a site', () => {
      const h = build({ siteProtected: () => true });
      const gone = h.open('gone');
      gone.audible = true;
      gone.destroyed = true;
      h.urls.set('gone', CHAT);
      // Only the address is read: audio, capture and DevTools are not, so none throws.
      expect(reasons(h.signals.protectionsOf('gone'))).toEqual(['protected-site']);
    });

    it('is not asked, and does not protect, for a tab with no address', () => {
      let asks = 0;
      const h = build({
        siteProtected: () => {
          asks += 1;
          return true;
        },
      });
      h.open('a');
      h.urls.set('b', '');
      expect(h.signals.protectionsOf('a')).toEqual([]);
      expect(h.signals.protectionsOf('b')).toEqual([]);
      expect(h.signals.protectionsOf('missing')).toEqual([]);
      expect(asks).toBe(0);
    });

    it('protects nothing when no reader is given', () => {
      const h = build();
      h.open('a');
      h.urls.set('a', CHAT);
      expect(h.signals.protectionsOf('a')).toEqual([]);
    });
  });

  describe('without urlOf', () => {
    it('applies neither, even when both readers say yes', () => {
      let asks = 0;
      const answer = (): boolean => {
        asks += 1;
        return true;
      };
      const h = build({
        urlOf: undefined,
        notificationsAllowed: answer,
        siteProtected: answer,
      });
      h.open('a');
      h.urls.set('a', CHAT); // known to the test, not to the monitor
      expect(h.signals.protectionsOf('a')).toEqual([]);
      expect(h.signals.protectionsOf('unloaded')).toEqual([]);
      expect(asks).toBe(0);
    });
  });

  it('gives a tab both protections when both readers say yes, notifications first', () => {
    const h = build({ notificationsAllowed: () => true, siteProtected: () => true });
    h.open('a');
    h.urls.set('a', CHAT);
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['notifications', 'protected-site']);
  });

  it('gives a tab with no web contents both, and its open popup first', () => {
    const h = build({ notificationsAllowed: () => true, siteProtected: () => true });
    h.urls.set('unloaded', CHAT);
    h.popups.add('unloaded');
    expect(reasons(h.signals.protectionsOf('unloaded'))).toEqual([
      'open-popup',
      'notifications',
      'protected-site',
    ]);
  });

  it('keeps an address per tab: another tab is unaffected', () => {
    const h = build({ siteProtected: (url) => url === CHAT });
    h.open('a');
    h.open('b');
    h.urls.set('a', CHAT);
    h.urls.set('b', OTHER);
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['protected-site']);
    expect(h.signals.protectionsOf('b')).toEqual([]);
  });

  it('keeps the address when the tab gets new web contents: it is the tab own, not the page', () => {
    const h = build({ siteProtected: () => true });
    h.open('a');
    h.urls.set('a', CHAT);
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['protected-site']);
    h.open('a'); // discarded and restored
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['protected-site']);
  });
});

describe('ProtectionSignals: onChange', () => {
  it('is told when audio starts or stops', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('audio-state-changed');
    expect(h.state.changes).toBe(1);
    tab.emit('audio-state-changed');
    expect(h.state.changes).toBe(2);
  });

  it('is not told by an audio event from web contents that is destroyed', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.destroyed = true;
    tab.emit('audio-state-changed');
    expect(h.state.changes).toBe(0);
    expect(h.timers.pending).toEqual([]);
  });

  it('is not told by a media element starting or pausing: the monitor does not read them', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('media-started-playing');
    tab.emit('media-paused');
    expect(h.state.changes).toBe(0);
  });

  it('is not told of a navigation that dropped nothing: the page was quiet', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('did-navigate');
    tab.emit('did-navigate');
    expect(h.state.changes).toBe(0);
  });

  it('is not told of a navigation after media events or audio: only a dropped capture grant is news', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('media-started-playing');
    tab.emit('audio-state-changed');
    h.state.changes = 0;
    tab.emit('did-navigate');
    expect(h.state.changes).toBe(0);
  });

  it('is told of a navigation only when it dropped a capture grant', () => {
    const h = build();
    const tab = h.openWatched('a');
    h.signals.mediaGranted(asContents(tab));
    h.state.changes = 0;
    tab.emit('did-navigate');
    expect(h.state.changes).toBe(1);
    tab.emit('did-navigate');
    expect(h.state.changes).toBe(1);
  });

  it('is told once of a navigation that drops a grant while the page also made a sound', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('audio-state-changed');
    h.signals.mediaGranted(asContents(tab));
    h.state.changes = 0;
    tab.emit('did-navigate');
    expect(h.state.changes).toBe(1);
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']); // the grant is gone, the sound is not
  });

  it('does not forget the audio heard when a new document commits: only the grant is dropped', () => {
    const h = build();
    const tab = h.openWatched('a');
    tab.emit('audio-state-changed');
    tab.emit('did-navigate');
    expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
  });

  it('is told of a grant the first time only', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.mediaGranted(asContents(tab));
    expect(h.state.changes).toBe(1);
    h.signals.mediaGranted(asContents(tab));
    h.signals.mediaGranted(asContents(tab));
    expect(h.state.changes).toBe(1);
  });

  it('is told of a grant again on the next document', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.mediaGranted(asContents(tab));
    tab.emit('did-navigate'); // 2: the grant ended
    h.signals.mediaGranted(asContents(tab)); // 3
    expect(h.state.changes).toBe(3);
  });

  it('is not told by an evaluation: reading the protections changes nothing', () => {
    const h = build();
    const tab = h.open('a');
    tab.audible = true;
    tab.devTools = true;
    h.popups.add('a');
    h.signals.protectionsOf('a');
    h.signals.protectionsOf('a');
    expect(h.state.changes).toBe(0);
  });

  it('works without a listener', () => {
    const signals = new ProtectionSignals({
      contentsOf: () => undefined,
      hasOpenPopup: () => false,
      now: () => 0,
    });
    const tab = new FakeContents();
    signals.attach(asContents(tab));
    expect(() => {
      tab.emit('audio-state-changed');
      tab.emit('did-navigate');
      signals.mediaGranted(asContents(tab));
      tab.emit('did-navigate'); // drops the grant
      tab.emit('destroyed');
    }).not.toThrow();
  });

  describe('when the grace of the audio ends', () => {
    it('arms one timer for the grace and a second, when audio changes', () => {
      const h = build();
      const tab = h.openWatched('a');
      expect(h.timers.pending).toEqual([]);

      tab.emit('audio-state-changed');
      expect(h.timers.pending).toEqual([AUDIO_GRACE_MS + 1000]);
    });

    it('tells once more when the timer fires, a second after the grace itself is over', () => {
      const h = build();
      const tab = h.openWatched('a');
      tab.emit('audio-state-changed');
      expect(h.state.changes).toBe(1);

      h.timers.fireAll();
      expect(h.state.changes).toBe(2);
      expect(h.timers.pending).toEqual([]);

      h.timers.fireAll(); // nothing is pending: it does not fire again
      expect(h.state.changes).toBe(2);
    });

    it('is a timer that waits longer than the grace, so the audio protection is gone when it fires', () => {
      const h = build();
      const tab = h.openWatched('a');
      tab.audible = true;
      h.signals.protectionsOf('a');
      tab.audible = false;
      tab.emit('audio-state-changed');
      const [delay] = h.timers.pending;
      expect(delay).toBeGreaterThan(AUDIO_GRACE_MS);

      h.clock.now += delay ?? 0;
      expect(h.signals.protectionsOf('a')).toEqual([]);
    });

    it('restarts its wait when audio changes again: one timer pending, not two', () => {
      const h = build();
      const tab = h.openWatched('a');
      tab.emit('audio-state-changed');
      tab.emit('audio-state-changed');
      tab.emit('audio-state-changed');
      expect(h.timers.pending).toEqual([AUDIO_GRACE_MS + 1000]);

      h.state.changes = 0;
      h.timers.fireAll();
      expect(h.state.changes).toBe(1);
    });

    it('can be armed again after it fired', () => {
      const h = build();
      const tab = h.openWatched('a');
      tab.emit('audio-state-changed');
      h.timers.fireAll();
      tab.emit('audio-state-changed');
      expect(h.timers.pending).toEqual([AUDIO_GRACE_MS + 1000]);
    });

    it('is cleared when the web contents is destroyed, and never tells afterwards', () => {
      const h = build();
      const tab = h.openWatched('a');
      tab.emit('audio-state-changed');
      expect(h.timers.pending).toHaveLength(1);

      tab.emit('destroyed');
      expect(h.timers.pending).toEqual([]);
      h.state.changes = 0;
      h.timers.fireAll();
      expect(h.state.changes).toBe(0);
    });

    it('is cleared on destruction by contents that was never audible without a fuss', () => {
      const h = build();
      const tab = h.openWatched('a');
      expect(() => {
        tab.emit('destroyed');
      }).not.toThrow();
      expect(h.timers.pending).toEqual([]);
    });

    it('keeps a timer per web contents: another tab is not cleared by this one being destroyed', () => {
      const h = build();
      const first = h.openWatched('a');
      const second = h.openWatched('b');
      first.emit('audio-state-changed');
      second.emit('audio-state-changed');
      expect(h.timers.pending).toHaveLength(2);

      first.emit('destroyed');
      expect(h.timers.pending).toHaveLength(1);
    });

    it('arms nothing without timers', () => {
      const h = build({ timers: undefined });
      const tab = h.openWatched('a');
      expect(() => {
        tab.emit('audio-state-changed');
        tab.emit('destroyed');
      }).not.toThrow();
      expect(h.timers.pending).toEqual([]);
      expect(h.state.changes).toBe(1);
    });
  });

  describe('when the listener throws', () => {
    function throwing() {
      let calls = 0;
      const h = build({
        onChange: () => {
          calls += 1;
          throw new Error('listener bug');
        },
      });
      return { h, calls: () => calls };
    }

    it('does not break the audio event, and still notes the audio', () => {
      const { h, calls } = throwing();
      const tab = h.openWatched('a');
      expect(() => {
        tab.emit('audio-state-changed');
      }).not.toThrow();
      expect(calls()).toBe(1);
      expect(reasons(h.signals.protectionsOf('a'))).toEqual(['audio']);
      expect(h.timers.pending).toEqual([AUDIO_GRACE_MS + 1000]);
    });

    it('is never called by the media events, so it cannot break them', () => {
      const { h, calls } = throwing();
      const tab = h.openWatched('a');
      expect(() => {
        tab.emit('media-started-playing');
        tab.emit('media-paused');
      }).not.toThrow();
      expect(h.signals.protectionsOf('a')).toEqual([]);
      expect(calls()).toBe(0);
    });

    it('does not break a navigation, and still forgets the grant', () => {
      const { h, calls } = throwing();
      const tab = h.openWatched('a');
      h.signals.mediaGranted(asContents(tab));
      expect(calls()).toBe(1);
      expect(() => {
        tab.emit('did-navigate');
      }).not.toThrow();
      expect(calls()).toBe(2);
      expect(h.signals.protectionsOf('a')).toEqual([]);
    });

    it('does not break a grant, and still protects', () => {
      const { h } = throwing();
      const tab = h.open('a');
      expect(() => {
        h.signals.mediaGranted(asContents(tab));
      }).not.toThrow();
      expect(reasons(h.signals.protectionsOf('a'))).toEqual(['capture']);
    });

    it('does not break the timer of the grace period', () => {
      const { h } = throwing();
      const tab = h.openWatched('a');
      tab.emit('audio-state-changed');
      expect(() => {
        h.timers.fireAll();
      }).not.toThrow();
    });
  });
});

describe('ProtectionSignals: the listeners', () => {
  const EVENTS = ['audio-state-changed', 'did-navigate', 'destroyed'] as const;

  it('watches the audio, the navigations and the end of the web contents', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.attach(asContents(tab));
    expect(tab.registered).toEqual([...EVENTS]);
  });

  it('registers on no event but those: not the media events, and nothing else', () => {
    const h = build();
    const tab = h.open('a');
    h.signals.attach(asContents(tab));
    h.signals.mediaGranted(asContents(tab));
    h.signals.protectionsOf('a');
    expect(new Set(tab.registered)).toEqual(new Set(EVENTS));
    expect(tab.registered).toHaveLength(EVENTS.length);
  });

  it('registers each event once per web contents, however often it is read', () => {
    const h = build();
    const tab = h.open('a');
    for (let i = 0; i < 5; i += 1) {
      h.signals.protectionsOf('a');
    }
    expect(tab.registered).toEqual([...EVENTS]);
  });

  describe('attach', () => {
    it('is idempotent: attaching again adds no listener', () => {
      const h = build();
      const tab = h.open('a');
      h.signals.attach(asContents(tab));
      h.signals.attach(asContents(tab));
      h.signals.attach(asContents(tab));
      for (const event of EVENTS) {
        expect(tab.listenerCount(event), event).toBe(1);
      }
      expect(tab.registered).toEqual([...EVENTS]);
    });

    it('adds no listener when the contents is then read, granted or attached again', () => {
      const h = build();
      const tab = h.open('a');
      h.signals.attach(asContents(tab));
      h.signals.protectionsOf('a');
      h.signals.mediaGranted(asContents(tab));
      h.signals.attach(asContents(tab));
      for (const event of EVENTS) {
        expect(tab.listenerCount(event), event).toBe(1);
      }
    });

    it('keeps ignoring the media events however often it is attached', () => {
      const h = build();
      const tab = h.open('a');
      h.signals.attach(asContents(tab));
      h.signals.attach(asContents(tab));
      tab.emit('media-started-playing');
      tab.emit('media-paused');
      expect(h.signals.protectionsOf('a')).toEqual([]);
      expect(h.state.changes).toBe(0);
    });

    it('drops a grant once, not once per attach', () => {
      const h = build();
      const tab = h.open('a');
      h.signals.attach(asContents(tab));
      h.signals.attach(asContents(tab));
      h.signals.mediaGranted(asContents(tab));
      h.state.changes = 0;
      tab.emit('did-navigate');
      expect(h.state.changes).toBe(1);
    });

    it('is told of each event once, not once per attach', () => {
      const h = build();
      const tab = h.open('a');
      h.signals.attach(asContents(tab));
      h.signals.attach(asContents(tab));
      tab.emit('audio-state-changed');
      expect(h.state.changes).toBe(1);
    });

    it('watches each web contents on its own', () => {
      const h = build();
      const first = h.open('a');
      const second = h.open('b');
      h.signals.attach(asContents(first));
      h.signals.attach(asContents(second));
      for (const event of EVENTS) {
        expect(first.listenerCount(event), event).toBe(1);
        expect(second.listenerCount(event), event).toBe(1);
      }
    });

    it('watches the new web contents a tab gets, and leaves the old one as it was', () => {
      const h = build();
      const first = h.openWatched('a');
      const replacement = h.openWatched('a');
      h.signals.protectionsOf('a');
      h.signals.protectionsOf('a');
      expect(replacement.registered).toEqual([...EVENTS]);
      expect(first.registered).toEqual([...EVENTS]);
    });
  });

  it('registers on each web contents a tab gets, and on each tab', () => {
    const h = build();
    const first = h.open('a');
    const second = h.open('b');
    h.signals.protectionsOf('a');
    h.signals.protectionsOf('b');
    h.signals.protectionsOf('a');
    expect(first.registered).toEqual([...EVENTS]);
    expect(second.registered).toEqual([...EVENTS]);

    const replacement = h.open('a');
    h.signals.protectionsOf('a');
    h.signals.protectionsOf('a');
    expect(replacement.registered).toEqual([...EVENTS]);
    expect(first.registered).toEqual([...EVENTS]);
  });
});
