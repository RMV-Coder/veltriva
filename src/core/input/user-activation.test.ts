import { describe, expect, it } from 'vitest';

import { ACTIVATION_WINDOW_MS, ActivationTracker, isActivationInput } from './user-activation';

describe('isActivationInput', () => {
  it.each([
    [{ type: 'mouseDown' }, true],
    [{ type: 'touchEnd' }, true],
    [{ type: 'gestureTap' }, true],
    [{ type: 'rawKeyDown', key: 'a' }, true],
    [{ type: 'keyDown', key: 'Enter' }, true],
    [{ type: 'rawKeyDown', key: ' ' }, true],
    [{ type: 'rawKeyDown', key: 'Escape' }, false],
    [{ type: 'rawKeyDown', key: 'Shift' }, false],
    [{ type: 'rawKeyDown', key: 'Control' }, false],
    [{ type: 'rawKeyDown', key: 'Alt' }, false],
    [{ type: 'rawKeyDown', key: 'Meta' }, false],
    [{ type: 'rawKeyDown', key: '' }, false],
    [{ type: 'rawKeyDown' }, false],
    [{ type: 'keyUp', key: 'a' }, false],
    [{ type: 'char', key: 'a' }, false],
    [{ type: 'mouseUp' }, false],
    [{ type: 'mouseMove' }, false],
    [{ type: 'mouseWheel' }, false],
    [{ type: 'touchStart' }, false],
  ])('%j → %s', (input, expected) => {
    expect(isActivationInput(input)).toBe(expected);
  });
});

describe('ActivationTracker', () => {
  it('allows within the window and uses the activation up', () => {
    const tracker = new ActivationTracker<number>();
    tracker.record(1, 1_000);
    expect(tracker.isActive(1, 1_000 + ACTIVATION_WINDOW_MS)).toBe(true);
    expect(tracker.consume(1, 1_500)).toBe(true);
    // One activation, one popup.
    expect(tracker.consume(1, 1_600)).toBe(false);
    expect(tracker.isActive(1, 1_600)).toBe(false);
  });

  it('expires after the window', () => {
    const tracker = new ActivationTracker<number>();
    tracker.record(1, 1_000);
    expect(tracker.consume(1, 1_000 + ACTIVATION_WINDOW_MS + 1)).toBe(false);
  });

  it('keeps each web contents apart', () => {
    const tracker = new ActivationTracker<number>();
    tracker.record(1, 1_000);
    expect(tracker.consume(2, 1_100)).toBe(false);
    expect(tracker.consume(1, 1_100)).toBe(true);
  });

  it('has nothing for an id it never saw, or one it forgot', () => {
    const tracker = new ActivationTracker<number>();
    expect(tracker.isActive(7, 0)).toBe(false);
    tracker.record(7, 10);
    tracker.forget(7);
    expect(tracker.consume(7, 11)).toBe(false);
  });

  it('refreshes on a later activation', () => {
    const tracker = new ActivationTracker<number>(100);
    tracker.record(1, 0);
    tracker.record(1, 90);
    expect(tracker.consume(1, 150)).toBe(true);
  });

  it('does not count an activation from the future (a clock that went back)', () => {
    const tracker = new ActivationTracker<number>();
    tracker.record(1, 5_000);
    expect(tracker.isActive(1, 4_000)).toBe(false);
  });
});
