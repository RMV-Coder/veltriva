import { describe, expect, it, vi } from 'vitest';

import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS } from '../../core/updates/release-feed';
import type { Logger } from '../platform/logger';
import { EMPTY_UPDATE_STATE, parseUpdateState, UpdateChecker } from './update-checker';
import type { UpdateCheckerOptions, UpdateState } from './update-checker';

const FEED = 'https://api.github.com/repos/RMV-Coder/veltriva/releases/latest';
const release = (tag: string) => ({
  tag_name: tag,
  html_url: `https://github.com/RMV-Coder/veltriva/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
});

interface Harness {
  readonly checker: UpdateChecker;
  readonly fetchFeed: ReturnType<typeof vi.fn<UpdateCheckerOptions['fetchFeed']>>;
  readonly onAvailable: ReturnType<typeof vi.fn<UpdateCheckerOptions['onAvailable']>>;
  readonly saved: UpdateState[];
  readonly timers: { callback: () => void; at: number }[];
  readonly clock: { now: number };
  readonly settings: { enabled: boolean };
  /** Runs the timer that is due, as the event loop would. */
  readonly fire: () => Promise<void>;
}

function harness(
  options: { enabled?: boolean; answer?: unknown; stored?: UpdateState; current?: string } = {},
): Harness {
  const clock = { now: 1_000_000 };
  const settings = { enabled: options.enabled ?? true };
  const saved: UpdateState[] = [];
  const timers: { callback: () => void; at: number }[] = [];
  const fetchFeed = vi.fn<UpdateCheckerOptions['fetchFeed']>(() =>
    Promise.resolve(options.answer ?? release('v0.2.0')),
  );
  const onAvailable = vi.fn<UpdateCheckerOptions['onAvailable']>();
  const logger: Logger = { warn: vi.fn(), error: vi.fn() };
  const checker = new UpdateChecker({
    enabled: () => settings.enabled,
    feedUrl: () => FEED,
    currentVersion: options.current ?? '0.1.0',
    fetchFeed,
    load: () => Promise.resolve(options.stored ?? EMPTY_UPDATE_STATE),
    save: (state) => {
      saved.push(state);
      return Promise.resolve();
    },
    onAvailable,
    onChange: vi.fn(),
    logger,
    now: () => clock.now,
    setTimer: (callback, ms) => {
      const timer = { callback, at: clock.now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timers.splice(timers.indexOf(timer as (typeof timers)[number]), 1);
    },
  });
  const fire = async (): Promise<void> => {
    const timer = timers.shift();
    if (timer === undefined) {
      throw new Error('no timer is waiting');
    }
    clock.now = timer.at;
    timer.callback();
    await vi.waitFor(() => {
      expect(checker.view().checking).toBe(false);
    });
  };
  return { checker, fetchFeed, onAvailable, saved, timers, clock, settings, fire };
}

describe('UpdateChecker (M6.3): off by default, silent while off', () => {
  it('never schedules, asks or saves anything while checks are off', async () => {
    const h = harness({ enabled: false });
    await h.checker.start();
    expect(h.timers).toEqual([]);
    await h.checker.checkNow();
    expect(h.fetchFeed).not.toHaveBeenCalled();
    expect(h.saved).toEqual([]);
    expect(h.checker.view()).toMatchObject({ enabled: false, lastCheckedAt: null });
  });

  it('turning checks off cancels the check that was waiting', async () => {
    const h = harness();
    await h.checker.start();
    expect(h.timers).toHaveLength(1);
    h.settings.enabled = false;
    h.checker.reschedule();
    expect(h.timers).toEqual([]);
  });
});

describe('UpdateChecker (M6.3): when it is on', () => {
  it('first asks two minutes after startup, then once a day', async () => {
    const h = harness();
    await h.checker.start();
    expect(h.timers[0]?.at).toBe(h.clock.now + FIRST_CHECK_DELAY_MS);
    await h.fire();
    expect(h.fetchFeed).toHaveBeenCalledTimes(1);
    expect(h.fetchFeed.mock.calls[0]?.[0]).toBe(FEED);
    expect(h.timers[0]?.at).toBe(h.clock.now + CHECK_INTERVAL_MS);
  });

  it("a restart doesn't ask again before the day is up", async () => {
    const lastCheckedAt = 1_000_000 - 60 * 60 * 1000;
    const h = harness({
      stored: { ...EMPTY_UPDATE_STATE, lastCheckedAt, lastStatus: 'up-to-date' },
    });
    await h.checker.start();
    expect(h.timers[0]?.at).toBe(lastCheckedAt + CHECK_INTERVAL_MS);
  });

  it('a newer release shows one notice per run, and is remembered', async () => {
    const h = harness();
    await h.checker.start();
    await h.checker.checkNow();
    await h.checker.checkNow();
    expect(h.onAvailable).toHaveBeenCalledTimes(1);
    expect(h.onAvailable).toHaveBeenCalledWith({
      version: '0.2.0',
      url: 'https://github.com/RMV-Coder/veltriva/releases/tag/v0.2.0',
    });
    expect(h.checker.view()).toMatchObject({
      lastStatus: 'available',
      available: { version: '0.2.0' },
    });
    expect(h.saved.at(-1)).toMatchObject({ lastStatus: 'available', latest: { version: '0.2.0' } });
  });

  it('says nothing when the newest release is this one', async () => {
    const h = harness({ answer: release('v0.1.0') });
    await h.checker.start();
    expect(await h.checker.checkNow()).toMatchObject({ lastStatus: 'up-to-date', available: null });
    expect(h.onAvailable).not.toHaveBeenCalled();
  });

  it('a skipped version never notifies again; a newer one does', async () => {
    const h = harness({ stored: { ...EMPTY_UPDATE_STATE, skipped: '0.2.0' } });
    await h.checker.start();
    await h.checker.checkNow();
    expect(h.onAvailable).not.toHaveBeenCalled();
    h.fetchFeed.mockResolvedValue(release('v0.3.0'));
    await h.checker.checkNow();
    expect(h.onAvailable).toHaveBeenCalledTimes(1);
  });

  it('records a failed check and keeps what it knew', async () => {
    const h = harness({
      stored: {
        ...EMPTY_UPDATE_STATE,
        latest: { version: '0.2.0', url: 'https://github.com/x/y/releases/tag/v0.2.0' },
      },
    });
    h.fetchFeed.mockRejectedValue(new TypeError('net::ERR_NAME_NOT_RESOLVED'));
    await h.checker.start();
    expect(await h.checker.checkNow()).toMatchObject({
      lastStatus: 'failed',
      available: { version: '0.2.0' },
    });
    h.fetchFeed.mockResolvedValue({ message: 'Not Found' });
    expect((await h.checker.checkNow()).lastStatus).toBe('failed');
  });

  it('runs one check at a time', async () => {
    const h = harness();
    await h.checker.start();
    const first = h.checker.checkNow();
    expect(h.checker.view().checking).toBe(true);
    const second = h.checker.checkNow();
    const [view] = await Promise.all([first, second]);
    expect(h.fetchFeed).toHaveBeenCalledTimes(1);
    // What a check answers is the settled view: no longer checking.
    expect(view.checking).toBe(false);
    expect(h.checker.view().checking).toBe(false);
  });
});

describe('parseUpdateState', () => {
  it('reads a stored document, and falls back to empty for anything else', () => {
    const state: UpdateState = {
      lastCheckedAt: 5,
      lastStatus: 'up-to-date',
      latest: { version: '0.1.0', url: 'https://github.com/x/y' },
      skipped: null,
    };
    expect(parseUpdateState(state)).toEqual(state);
    expect(parseUpdateState(null)).toEqual(EMPTY_UPDATE_STATE);
    expect(parseUpdateState({ lastCheckedAt: 'yesterday' })).toEqual(EMPTY_UPDATE_STATE);
    expect(
      parseUpdateState({ ...state, latest: { version: '0.1.0', url: 'javascript:alert(1)' } }),
    ).toEqual(EMPTY_UPDATE_STATE);
  });
});
