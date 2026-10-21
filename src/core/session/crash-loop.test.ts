import { describe, expect, it } from 'vitest';

import { CRASH_LOOP_RUNS, CRASH_LOOP_WINDOW_MS, isCrashLoop } from './crash-loop';
import type { RunSummary } from './crash-loop';

const T0 = 1_700_000_000_000;

/** A crash that ended `lastedMs` after its start (its last heartbeat). */
const crash = (startedAt: number, lastedMs: number): RunSummary => ({
  startedAt,
  endedAt: startedAt + lastedMs,
  exitKind: 'crash',
});
const clean = (startedAt: number, lastedMs: number): RunSummary => ({
  startedAt,
  endedAt: startedAt + lastedMs,
  exitKind: 'clean',
});

describe('isCrashLoop', () => {
  it('looks at the last two runs, within 60 seconds each', () => {
    expect(CRASH_LOOP_RUNS).toBe(2);
    expect(CRASH_LOOP_WINDOW_MS).toBe(60_000);
  });

  it('is false with no earlier run', () => {
    expect(isCrashLoop([])).toBe(false);
  });

  it('is false with a single earlier run, however badly it ended', () => {
    expect(isCrashLoop([crash(T0, 0)])).toBe(false);
  });

  it('is true when the last two runs both crashed soon after starting', () => {
    expect(isCrashLoop([crash(T0 + 1000, 5000), crash(T0, 20_000)])).toBe(true);
  });

  it('is true for crashes that ended at their start, as one before the first heartbeat does', () => {
    expect(isCrashLoop([crash(T0 + 1000, 0), crash(T0, 0)])).toBe(true);
  });

  it('is false when one of the last two runs ended cleanly', () => {
    expect(isCrashLoop([clean(T0 + 1000, 5000), crash(T0, 5000)])).toBe(false);
    expect(isCrashLoop([crash(T0 + 1000, 5000), clean(T0, 5000)])).toBe(false);
  });

  it('is false when both of the last two runs ended cleanly', () => {
    expect(isCrashLoop([clean(T0 + 1000, 5000), clean(T0, 5000)])).toBe(false);
  });

  it('is false when a crash lasted a minute or more, because the session was usable then', () => {
    expect(isCrashLoop([crash(T0 + 1000, 5000), crash(T0, 60_000)])).toBe(false);
    expect(isCrashLoop([crash(T0 + 1000, 5 * 60_000), crash(T0, 5000)])).toBe(false);
  });

  it('puts the limit between 59,999 and 60,000 milliseconds', () => {
    expect(isCrashLoop([crash(T0 + 1000, 59_999), crash(T0, 59_999)])).toBe(true);
    expect(isCrashLoop([crash(T0 + 1000, 60_000), crash(T0, 59_999)])).toBe(false);
    expect(isCrashLoop([crash(T0 + 1000, 59_999), crash(T0, 60_000)])).toBe(false);
  });

  it('is false for a run that has not ended', () => {
    expect(
      isCrashLoop([{ startedAt: T0 + 1000, endedAt: null, exitKind: 'crash' }, crash(T0, 5000)]),
    ).toBe(false);
    expect(
      isCrashLoop([crash(T0 + 1000, 5000), { startedAt: T0, endedAt: null, exitKind: 'crash' }]),
    ).toBe(false);
  });

  it('is false for a run with no exit kind', () => {
    const unknown: RunSummary = { startedAt: T0, endedAt: T0 + 1000, exitKind: null };

    expect(isCrashLoop([crash(T0 + 5000, 1000), unknown])).toBe(false);
  });

  it('counts only the two newest runs', () => {
    // Newest first: two quick crashes, then older runs that don't matter.
    expect(
      isCrashLoop([
        crash(T0 + 3000, 1000),
        crash(T0 + 2000, 1000),
        clean(T0 + 1000, 600_000),
        clean(T0, 600_000),
      ]),
    ).toBe(true);
    // A clean run in third place doesn't rescue a loop; a crash in third place doesn't make one.
    expect(
      isCrashLoop([clean(T0 + 3000, 1000), crash(T0 + 2000, 1000), crash(T0 + 1000, 1000)]),
    ).toBe(false);
    expect(
      isCrashLoop([crash(T0 + 3000, 1000), clean(T0 + 2000, 1000), crash(T0 + 1000, 1000)]),
    ).toBe(false);
  });

  it('does not depend on how far apart the runs are', () => {
    expect(isCrashLoop([crash(T0 + 90 * 24 * 3_600_000, 1000), crash(T0, 1000)])).toBe(true);
  });
});
