// M3.1, the discard and restore of assessment §4.9 (spikes S2 and S3), measured without
// Playwright (ADR-0008 4a): a hidden tab's page state, the renderer's release, and what comes
// back when the tab is selected again. The app loads pages from the fixture server started here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFixtureServer } from '../fixtures/server';
import type { FixtureServer } from '../fixtures/server';
import { runScenario } from './harness';

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server.close();
});

const env = (): Record<string, string> => ({ VELTRIVA_FIXTURE_ORIGIN: server.origin });

interface PageStateResult {
  readonly outcomes: { readonly article: unknown; readonly form: unknown };
  readonly discardMs: number;
  readonly afterDiscard: Record<string, { readonly runtime: string; readonly hasView: boolean }>;
  readonly renderersGone: { readonly article: boolean; readonly form: boolean };
  readonly article: { readonly scrolledTo: number; readonly restoredScroll: number };
  readonly form: {
    readonly scrolledTo: number;
    readonly restored: {
      readonly text: string;
      readonly area: string;
      readonly sel: string;
      readonly chk: boolean;
      readonly scrollY: number;
      readonly activated: boolean;
    };
  };
}

describe('discarding a hidden tab right after it was edited', () => {
  it('frees its renderer and brings back its scroll position and form values', async () => {
    const { result } = await runScenario<PageStateResult>('discard-restores-page-state', {
      env: env(),
    });
    expect(result.outcomes, JSON.stringify(result)).toEqual({
      article: { outcome: 'discarded' },
      form: { outcome: 'discarded' },
    });
    expect(result.afterDiscard).toEqual({
      article: { runtime: 'unloaded', hasView: false },
      form: { runtime: 'unloaded', hasView: false },
    });
    expect(result.renderersGone).toEqual({ article: true, form: true });
    // The flush caught edits made just before a hidden tab's discard (S2: ±1 px).
    expect(Math.abs(result.article.restoredScroll - result.article.scrolledTo)).toBeLessThanOrEqual(
      1,
    );
    expect(result.form.restored).toMatchObject({
      text: 'edited text',
      area: 'edited area',
      sel: 'b',
      chk: true,
      activated: false,
    });
    expect(Math.abs(result.form.restored.scrollY - result.form.scrolledTo)).toBeLessThanOrEqual(1);
  });
});

/** What a tab looks like after a discard attempt (src/main/testing/discard-scenarios.ts). */
interface TabAfter {
  readonly runtime: string;
  readonly hasView: boolean;
  readonly learned: readonly string[];
}

const KEPT_UNSAVED_INPUT = { outcome: 'blocked', reason: 'unsaved-input' };

/**
 * A discard that did not get its answer in time is tried again (`discardPatiently` in the
 * scenarios): on a loaded laptop the probe's 100 ms budget is sometimes missed. The attempts and
 * the time each took are reported here, so an intermittent stays visible.
 */
interface Attempts {
  readonly attempts: number;
  readonly attemptMs: readonly number[];
}

function noteAttempts(name: string, ...discards: readonly Attempts[]): void {
  for (const discard of discards) {
    if (discard.attempts > 1) {
      console.warn(
        `${name}: a discard needed ${String(discard.attempts)} attempts ` +
          `(ms per attempt: ${discard.attemptMs.join(', ')})`,
      );
    }
  }
}

interface UnloadCounters {
  readonly beforeunload: number;
  readonly objected: number;
  readonly keys: number;
}

interface BeforeUnloadResult {
  readonly windowsBefore: number;
  readonly dirty: TabAfter &
    Attempts & {
      readonly outcome: unknown;
      readonly activated: boolean;
      readonly inputAttempts: number;
      readonly answers: number;
      readonly text: string;
      readonly unload: UnloadCounters;
      readonly windows: number;
    };
  readonly keys: TabAfter &
    Attempts & {
      readonly outcome: unknown;
      readonly activated: boolean;
      readonly inputAttempts: number;
      readonly answers: number;
      readonly unload: UnloadCounters;
      readonly windows: number;
    };
  readonly always: TabAfter &
    Attempts & {
      readonly outcome: unknown;
      readonly activated: boolean;
      readonly windows: number;
    };
}

describe('beforeunload on a hidden tab, with real input', () => {
  it('keeps a typed-into page, keeps a page that objects after a key press, and discards an untouched one, with no dialog', async () => {
    const { result } = await runScenario<BeforeUnloadResult>('discard-beforeunload-hidden', {
      env: env(),
    });
    const why = JSON.stringify(result);
    noteAttempts('discard-beforeunload-hidden', result.dirty, result.keys, result.always);

    // Real typing into the page's field: the probe sees the changed field first, so the page is
    // kept for its unsaved input without being asked; it is alive, with the text, and its
    // beforeunload handler was never run.
    expect(result.dirty.activated, why).toBe(true);
    expect(result.dirty.outcome, why).toEqual(KEPT_UNSAVED_INPUT);
    expect(result.dirty, why).toMatchObject({
      runtime: 'live',
      hasView: true,
      learned: ['unsaved-input'],
      answers: 2,
    });
    expect(result.dirty.text, why).toContain('hi');
    expect(result.dirty.unload.beforeunload, why).toBe(0);
    expect(result.dirty.windows, why).toBe(result.windowsBefore);

    // A real key press with no field involved: the probe finds nothing, so the page's own
    // beforeunload is what keeps the tab. Electron cancels the close silently: the page lives on,
    // answering, and no window (so no dialog) appeared.
    expect(result.keys.activated, why).toBe(true);
    expect(result.keys.outcome, why).toEqual({
      outcome: 'blocked',
      reason: 'page-unsaved-changes',
    });
    expect(result.keys, why).toMatchObject({
      runtime: 'live',
      hasView: true,
      learned: ['page-unsaved-changes'],
      answers: 2,
    });
    expect(result.keys.unload.keys, why).toBeGreaterThanOrEqual(1);
    expect(result.keys.unload.objected, why).toBeGreaterThanOrEqual(1);
    expect(result.keys.windows, why).toBe(result.windowsBefore);

    // The page that objects to everything but was never touched has no say (S3 A1).
    expect(result.always.activated, why).toBe(false);
    expect(result.always.outcome, why).toEqual({ outcome: 'discarded' });
    expect(result.always, why).toMatchObject({ runtime: 'unloaded', hasView: false });
    expect(result.always.windows, why).toBe(result.windowsBefore);
  });
});

interface RealInputCase extends TabAfter, Attempts {
  readonly name: string;
  readonly typed: string;
  readonly focusedAfter: string;
  readonly activated: boolean;
  readonly typingAttempts: number;
  readonly outcome: unknown;
}

describe('real typing the probe must catch', () => {
  it('keeps hidden tabs typed into: a plain field, a React-style input, a blurred contenteditable', async () => {
    const { result } = await runScenario<RealInputCase[]>('discard-real-input-kept', {
      env: env(),
    });
    const why = JSON.stringify(result);
    noteAttempts('discard-real-input-kept', ...result);
    expect(
      result.map((entry) => entry.name),
      why,
    ).toEqual(['text', 'reactish', 'contenteditable']);
    for (const entry of result) {
      expect(entry.activated, why).toBe(true);
      expect(entry.outcome, why).toEqual(KEPT_UNSAVED_INPUT);
      expect(entry, why).toMatchObject({ runtime: 'live', hasView: true });
      expect(entry.learned, why).toEqual(['unsaved-input']);
    }
    const typed = Object.fromEntries(result.map((entry) => [entry.name, entry.typed]));
    expect(typed.text, why).toContain('hi');
    expect(typed.reactish, why).toBe('hello');
    expect(typed.contenteditable, why).toContain('hello');
    // The editable region was blurred by a click on the heading.
    expect(result.find((entry) => entry.name === 'contenteditable')?.focusedAfter, why).not.toBe(
      'ce',
    );
  });
});

interface BackgroundRestoreResult extends Attempts {
  readonly outcome: unknown;
  readonly afterDiscard: TabAfter;
  readonly scrolledTo: number;
  readonly selectedDuringRestore: boolean;
  readonly attachedWhileRestoring: boolean;
  readonly stillHidden: boolean;
  readonly hiddenScroll: number;
  readonly shownScroll: number;
  readonly scaleFactor: number;
  readonly devicePixelRatio: number;
  readonly activated: boolean;
}

describe('restoring a tab in the background', () => {
  it('puts the scroll back exactly, not multiplied by the display scale (S2)', async () => {
    const { result } = await runScenario<BackgroundRestoreResult>('background-restore-scroll', {
      env: env(),
    });
    const why = JSON.stringify(result);
    noteAttempts('background-restore-scroll', result);
    expect(result.outcome, why).toEqual({ outcome: 'discarded' });
    expect(result.afterDiscard, why).toMatchObject({ runtime: 'unloaded', hasView: false });
    // The restore ran while another tab was selected, into a view that is attached.
    expect(result.selectedDuringRestore, why).toBe(true);
    expect(result.attachedWhileRestoring, why).toBe(true);
    expect(result.stillHidden, why).toBe(true);
    expect(result.scrolledTo, why).toBeGreaterThan(3000);
    // Exact within a pixel, while hidden and once shown. The trap is the scale factor: a restore
    // into a detached view gives scrolledTo * scaleFactor, which this display (125 %) tells apart.
    expect(Math.abs(result.hiddenScroll - result.scrolledTo), why).toBeLessThanOrEqual(1);
    expect(Math.abs(result.shownScroll - result.scrolledTo), why).toBeLessThanOrEqual(1);
    if (result.scaleFactor !== 1) {
      expect(result.shownScroll, why).not.toBeCloseTo(result.scrolledTo * result.scaleFactor, 0);
    }
    expect(result.devicePixelRatio, why).toBeCloseTo(result.scaleFactor, 2);
    expect(result.activated, why).toBe(false);
  });
});

interface FreezeResult {
  readonly windowMs: number;
  readonly visibleTicks: number;
  readonly hiddenLiveTicks: number;
  readonly reshownTicks: number;
  readonly visibilityReshown: string;
  readonly freezeOutcome: unknown;
  readonly freezeMs: number;
  readonly runtimeAfterFreeze: string;
  readonly frozenTicks: number;
  readonly runtimeAfterSelect: string;
  readonly visibilityAfterThaw: string;
  readonly resumedTicks: number;
  readonly resumedTicksLater: number;
  readonly answersAfterThaw: number;
  readonly frozenDiscards: readonly {
    readonly freeze: unknown;
    readonly runtimeBefore: string;
    readonly outcome: { readonly outcome: string; readonly reason?: string };
    readonly ms: number;
  }[];
  readonly afterDiscard: TabAfter;
  readonly events: readonly string[];
}

describe('the freeze experiment (off by default in the app)', () => {
  it('stops a hidden tab, thaws it when selected, and discards a frozen tab', async () => {
    const { result } = await runScenario<FreezeResult>('freeze-experiment', { env: env() });
    const why = JSON.stringify(result);
    // The page logs every 100 ms: a visible tab about 20 times a second, a hidden live one is
    // throttled (S1), a frozen one logs nothing.
    expect(result.visibleTicks, why).toBeGreaterThanOrEqual(result.windowMs / 100 / 2);
    expect(result.hiddenLiveTicks, why).toBeLessThan(result.visibleTicks / 3);
    expect(result.hiddenLiveTicks, why).toBeGreaterThanOrEqual(1);
    // Control: showing a live tab again needs no thaw and runs at full speed.
    expect(result.visibilityReshown, why).toBe('visible');
    expect(result.reshownTicks, why).toBeGreaterThanOrEqual(10);
    expect(result.freezeOutcome, why).toEqual({ outcome: 'frozen' });
    expect(result.runtimeAfterFreeze, why).toBe('frozen');
    expect(result.frozenTicks, why).toBeLessThanOrEqual(1);

    // Selecting the tab thaws it in the same call. The page runs again at full speed, though not
    // always at once: the thaw is a DevTools command that the renderer answers when it is
    // scheduled (the first 2 s window measured 2, 20 and 9 ticks on this loaded laptop).
    expect(result.runtimeAfterSelect, why).toBe('live');
    expect(result.visibilityAfterThaw, why).toBe('visible');
    expect(result.resumedTicks, why).toBeGreaterThan(result.hiddenLiveTicks);
    expect(result.resumedTicksLater, why).toBeGreaterThanOrEqual(10);
    expect(result.answersAfterThaw, why).toBe(2);

    // A frozen tab is discarded: thawed first, then probed and closed. A page that is not
    // running again within the wake-up deadline keeps the tab (probe-unanswered, live), and the
    // attempts after it are fresh freezes; up to two such misses were allowed.
    const attempts = result.frozenDiscards;
    expect(attempts.length, why).toBeGreaterThanOrEqual(1);
    expect(attempts.length, why).toBeLessThanOrEqual(3);
    for (const attempt of attempts) {
      expect(attempt.freeze, why).toEqual({ outcome: 'frozen' });
      expect(attempt.runtimeBefore, why).toBe('frozen');
    }
    for (const missed of attempts.slice(0, -1)) {
      expect(missed.outcome, why).toEqual({ outcome: 'blocked', reason: 'probe-unanswered' });
    }
    expect(attempts.at(-1)?.outcome, why).toEqual({ outcome: 'discarded' });
    expect(result.afterDiscard, why).toMatchObject({ runtime: 'unloaded', hasView: false });
    // The discard goes from frozen straight to discarding: no thaw transition (the thaw is a
    // command to the page), and a missed attempt ends live.
    expect(result.events.slice(0, 4), why).toEqual(['load', 'ready', 'freeze', 'thaw']);
    expect(result.events.slice(-3), why).toEqual(['freeze', 'discard', 'discarded']);
  });
});
