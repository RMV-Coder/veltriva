// The protection monitor, preview mode, Pause and the regret metric, M3.4 (assessment §4.10 and
// §4.13, ADR-0003 item 15). What automation.spec.ts does for M3.2's signals, this does for the
// rest of the table: playing media, a protected site, notifications, activity in the background
// and fullscreen; then what a new user sees first (preview), the Pause switch, and the local
// regret metric the diagnostics page shows.
//
// Time and pressure as in automation.spec.ts: the lifecycle clock is fast-forwarded, plans are
// read in one step in main (`lifecyclePlanWith`), and the pressure is pinned to 'none' unless a
// spec sets it. A fresh profile is on its first active day, so preview mode is on unless a spec
// turns it off. Hidden pages are read and driven from main (`evaluateInTab`), never through
// Playwright (ADR-0008 item 4).
//
// Not here: capture through the camera or microphone. Automated tests never allow those
// (prompt-ui.ts), so the grant that protects a capturing tab is covered by unit tests
// (protection-signals.test.ts).
import type { ElectronApplication, Page } from '@playwright/test';

import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import {
  advanceLifecycleClock,
  evaluateInTab,
  invokeTabMenuItem,
  lifecycleEvaluate,
  lifecycleLog,
  lifecyclePlan,
  lifecyclePlanWith,
  requestPageFullscreen,
  selectedTabId,
  setLifecycleSettings,
  setMemoryPressure,
  tabMenuItems,
  tabState,
} from './hooks';
import type { TabId } from './hooks';
import type { PageGlobal } from './page-globals';
import { clickYes, waitForStrip, workspaceSnapshot } from './prompt-ui';
import { dataValue, test } from './session-ui';
import type { Launcher, RunningApp } from './session-ui';
import { loadInNewTab, openTabAt, sidebarIds, tabElement, waitForLoaded } from './shell-ui';

test.describe.configure({ timeout: 240_000 });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

interface Rig extends RunningApp {
  /** The new-tab page the app starts with. */
  readonly blank: TabId;
}

async function launchRig(launcher: Launcher, options: { preview?: boolean } = {}): Promise<Rig> {
  const run = await launcher.launch();
  const [blank] = await sidebarIds(run.shell);
  if (blank === undefined) {
    throw new Error('The app starts with one tab.');
  }
  await setMemoryPressure(run.app, 'none');
  if (options.preview !== true) {
    await setLifecycleSettings(run.app, { preview: 'off' });
  }
  return { ...run, blank };
}

async function selectTab(rig: Pick<Rig, 'app' | 'shell'>, tabId: TabId): Promise<void> {
  await tabElement(rig.shell, tabId).click();
  await expect.poll(() => selectedTabId(rig.app)).toBe(tabId);
}

async function contentsOf(app: ElectronApplication, tabId: TabId): Promise<number> {
  const state = await tabState(app, tabId);
  if (state?.webContentsId === null || state?.webContentsId === undefined) {
    throw new Error(`Tab ${tabId} has no web contents.`);
  }
  return state.webContentsId;
}

/** What the snapshot says keeps a tab awake (strip or Sleeping). */
async function keptAwake(shell: Page, tabId: TabId): Promise<readonly string[]> {
  const snapshot = await workspaceSnapshot(shell);
  const tab = [...snapshot.tabs, ...snapshot.sleeping].find((candidate) => candidate.id === tabId);
  return tab?.keptAwake ?? [];
}

const plain = (server: FixtureServer, name: string, host = '127.0.0.1'): string => {
  const url = new URL(server.url(`/lifecycle-plain.html?case=protection&tab=${name}`));
  url.hostname = host;
  return url.href;
};

const discards = (plan: readonly { kind: string; tabId: string }[]): string[] =>
  plan.filter((action) => action.kind === 'discard').map((action) => action.tabId);

/** Sends a lifecycle command as the sidebar does. */
function setPaused(shell: Page, paused: boolean): Promise<unknown> {
  return shell.evaluate(
    (value) => (globalThis as PageGlobal).veltriva.lifecycle.setPaused({ paused: value }),
    paused,
  );
}

function restoreTab(shell: Page, tabId: TabId): Promise<unknown> {
  return shell.evaluate(
    (id) => (globalThis as PageGlobal).veltriva.tabs.restore({ tabId: id }),
    tabId,
  );
}

// ── 1. Playing media ────────────────────────────────────────────────────────────────────────────

test.describe('media', () => {
  test('a playing media element keeps its tab, muted or not; paused, the tab can go', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const tab = await loadInNewTab(app, shell, fixtureServer.url('/lifecycle-media.html'));
    const contents = await contentsOf(app, tab);
    expect(await evaluateInTab(app, contents, 'lifecycleMedia.play()', { userGesture: true })).toBe(
      'playing',
    );
    await selectTab(rig, rig.blank);

    await expect.poll(() => keptAwake(shell, tab), { timeout: 20_000 }).toContain('video');
    // A muted element is never audible: this is the media protection, not the audio one.
    expect(await keptAwake(shell, tab)).not.toContain('audio');
    // The sidebar says what it observed (§4.10: never that the tab is "safe").
    await expect(tabElement(shell, tab)).toHaveAttribute('data-kept-awake', 'video');
    await expect(tabElement(shell, tab)).toHaveAttribute('title', /\nKept awake: playing media$/);
    const hourLater = await lifecyclePlanWith(app, { clock: { wallMs: 61 * MINUTE } });
    expect(discards(hourLater), 'hard: not even critical pressure takes it').not.toContain(tab);
    expect(
      discards(await lifecyclePlanWith(app, { pressure: 'critical', then: { pressure: 'none' } })),
    ).not.toContain(tab);

    expect(await evaluateInTab(app, contents, 'lifecycleMedia.pause()')).toBe('paused');
    await expect.poll(() => keptAwake(shell, tab)).not.toContain('video');
    expect(discards(await lifecyclePlan(app))).toContain(tab);
  });
});

// ── 2. A protected site ─────────────────────────────────────────────────────────────────────────

test.describe('a protected site', () => {
  test('the tab menu protects every tab of the site, loaded or not, across a restart', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const a = await loadInNewTab(app, shell, plain(fixtureServer, 'a'));
    const b = await loadInNewTab(app, shell, plain(fixtureServer, 'b'));
    const other = await loadInNewTab(app, shell, plain(fixtureServer, 'c', 'localhost'));
    await selectTab(rig, rig.blank);

    const menu = (await tabMenuItems(app, a)).flatMap((entry) =>
      entry.type === 'item' ? [entry.label] : [],
    );
    expect(menu).toContain('Always protect 127.0.0.1');
    await invokeTabMenuItem(app, a, 'protect-site');
    await expect.poll(() => keptAwake(shell, a)).toContain('protected-site');
    expect(await keptAwake(shell, b)).toContain('protected-site');
    expect(await keptAwake(shell, other)).not.toContain('protected-site');
    expect(
      (await tabMenuItems(app, b)).some(
        (entry) => entry.type === 'item' && entry.label === 'Stop protecting 127.0.0.1',
      ),
    ).toBe(true);

    // Hard: nothing is planned for its tabs, even under critical pressure; the other site's tab is.
    const plan = await lifecyclePlanWith(app, {
      clock: { wallMs: 61 * MINUTE, engagedMs: 3 * HOUR },
      pressure: 'critical',
      then: { pressure: 'none' },
    });
    const planned = plan.map((action) => action.tabId);
    expect(planned).not.toContain(a);
    expect(planned).not.toContain(b);
    expect(planned).toContain(other);

    // Saved in the settings document, and in force after a restart for tabs not loaded yet.
    await expect
      .poll(async () => {
        const stored = await dataValue<{ value: { lifecycle?: { protectedSites?: string[] } } }>(
          app,
          'settings.get',
          {},
        );
        return stored.value.lifecycle?.protectedSites;
      })
      .toEqual(['127.0.0.1']);
    await launcher.quit(rig);
    const second = await launcher.launch();
    await setMemoryPressure(second.app, 'none');
    await expect.poll(() => sidebarIds(second.shell)).toContain(a);
    expect(await tabState(second.app, a)).toMatchObject({ runtime: 'unloaded' });
    await expect.poll(() => keptAwake(second.shell, a)).toContain('protected-site');
    expect(await keptAwake(second.shell, other)).not.toContain('protected-site');
  });
});

// ── 3. Soft signals: notifications and activity in the background ──────────────────────────────

test.describe('soft signals', () => {
  test('a site allowed to notify keeps its tab softly: discard-hidden leaves it, critical pressure does not', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const tab = await loadInNewTab(app, shell, fixtureServer.url('/permissions.html'));
    const contents = await contentsOf(app, tab);
    await evaluateInTab(app, contents, "permissionsFixture.start('notifications')", {
      userGesture: true,
    });
    await waitForStrip(shell, 'permission');
    await clickYes(shell, 'Allow');
    await expect
      .poll(() => evaluateInTab(app, contents, "permissionsFixture.result('notifications')"))
      .toMatchObject({ ok: true, value: 'granted' });
    await selectTab(rig, rig.blank);

    await expect.poll(() => keptAwake(shell, tab)).toContain('notifications');
    const hourLater = await lifecyclePlanWith(app, { clock: { wallMs: 61 * MINUTE } });
    expect(discards(hourLater)).not.toContain(tab);
    const critical = await lifecyclePlanWith(app, {
      pressure: 'critical',
      then: { pressure: 'none' },
    });
    expect(critical.find((action) => action.tabId === tab)).toMatchObject({
      kind: 'discard',
      rule: 'pressure-discard',
      overrideSoft: true,
    });
  });

  test('a page whose title changes while it is hidden is active in the background: kept softly for an hour after', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const tab = await loadInNewTab(app, shell, plain(fixtureServer, 'chat'));
    const contents = await contentsOf(app, tab);
    await selectTab(rig, rig.blank);

    // A title change in the first 30 s hidden is the page settling, not activity.
    await evaluateInTab(app, contents, "document.title = 'settling'");
    await expect.poll(async () => (await tabState(app, tab))?.title).toBe('settling');
    expect(await keptAwake(shell, tab)).not.toContain('background-activity');

    // 59 minutes later a new message arrives: the title changes. Two minutes after that, the tab
    // has been hidden over an hour, and only the activity keeps it.
    await advanceLifecycleClock(app, { wallMs: 59 * MINUTE });
    await evaluateInTab(app, contents, "document.title = '(1) New message'");
    await expect.poll(() => keptAwake(shell, tab)).toContain('background-activity');
    const kept = await lifecyclePlanWith(app, { clock: { wallMs: 2 * MINUTE } });
    expect(discards(kept)).not.toContain(tab);
    const critical = await lifecyclePlanWith(app, {
      pressure: 'critical',
      then: { pressure: 'none' },
    });
    expect(discards(critical)).toContain(tab);
    // An hour after the last change, it is an ordinary hidden tab again.
    const later = await lifecyclePlanWith(app, { clock: { wallMs: 61 * MINUTE } });
    expect(discards(later)).toContain(tab);
    expect(await keptAwake(shell, tab)).not.toContain('background-activity');
  });

  test('a page in fullscreen is kept awake by it', async ({ launcher, fixtureServer }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const tab = await loadInNewTab(app, shell, fixtureServer.url('/fullscreen.html'));
    await requestPageFullscreen(app, await contentsOf(app, tab));
    await expect.poll(() => keptAwake(shell, tab), { timeout: 20_000 }).toContain('fullscreen');
  });
});

// ── 4. Preview mode ─────────────────────────────────────────────────────────────────────────────

test.describe('preview mode', () => {
  test('on the first active days automation marks the tabs it would move; from day 4 it moves them', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher, { preview: true });
    const { app, shell } = rig;
    const opened: TabId[] = [];
    for (let index = 0; index < 12; index += 1) {
      opened.push(await loadInNewTab(app, shell, plain(fixtureServer, `preview-${String(index)}`)));
    }
    await selectTab(rig, rig.blank);
    const strip = await sidebarIds(shell);
    const oldest = opened.slice(0, 3);

    expect((await workspaceSnapshot(shell)).automation).toMatchObject({
      preview: true,
      previewUntilDay: 3,
      activeDay: 1,
      paused: false,
    });
    await expect(shell.locator('[data-automation-preview-text]')).toHaveText(
      'Preview: automation shows what it would move (day 1 of 3)',
    );
    // Past the shelve rule's time (and the guard), still day 1: three tabs would move.
    await advanceLifecycleClock(app, { engagedMs: 3 * HOUR, wallMs: 16 * MINUTE });
    await lifecycleEvaluate(app);
    const previewed = (await lifecycleLog(app)).filter((record) => record.kind === 'shelve');
    expect(new Set(previewed.map((record) => record.tabId))).toEqual(new Set(oldest));
    expect(previewed.every((record) => record.result.outcome === 'planned')).toBe(true);
    expect(await sidebarIds(shell), 'nothing moved').toEqual(strip);
    await expect
      .poll(async () =>
        (await workspaceSnapshot(shell)).tabs
          .filter((tab) => tab.previewMove === 'shelve')
          .map((tab) => tab.id)
          .sort(),
      )
      .toEqual([...oldest].sort());
    for (const tabId of oldest) {
      await expect(
        tabElement(shell, tabId).locator('[data-preview-icon="shelve"]'),
        'the sidebar marks the tab',
      ).toHaveCount(1);
    }
    // Evaluated again, a planned move is logged once.
    await lifecycleEvaluate(app);
    expect((await lifecycleLog(app)).filter((record) => record.kind === 'shelve')).toHaveLength(3);

    // Day 4: preview is over, the marks go and the tabs move.
    await advanceLifecycleClock(app, { activeDays: 3 });
    await lifecycleEvaluate(app);
    await expect.poll(() => sidebarIds(shell)).toEqual(strip.filter((id) => !oldest.includes(id)));
    const snapshot = await workspaceSnapshot(shell);
    expect(snapshot.automation.preview).toBe(false);
    await expect(shell.locator('[data-automation-preview]')).toHaveCount(0);
    expect(
      [...snapshot.tabs, ...snapshot.sleeping].filter((tab) => tab.previewMove !== null),
    ).toEqual([]);
  });

  test('"Start now" ends preview at once and is saved', async ({ launcher }) => {
    const rig = await launchRig(launcher, { preview: true });
    const { app, shell } = rig;
    expect((await workspaceSnapshot(shell)).automation.preview).toBe(true);
    await shell.getByRole('button', { name: 'Start now', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(shell)).automation.preview).toBe(false);
    await expect(shell.locator('[data-automation-preview]')).toHaveCount(0);
    const stored = await dataValue<{ value: { lifecycle?: { preview?: string } } }>(
      app,
      'settings.get',
      {},
    );
    expect(stored.value.lifecycle?.preview).toBe('off');
  });
});

// ── 5. Pause ────────────────────────────────────────────────────────────────────────────────────

test.describe('Pause automation', () => {
  test('paused plans nothing, says so, and stays paused after a restart until resumed', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const tab = await loadInNewTab(app, shell, plain(fixtureServer, 'paused'));
    await selectTab(rig, rig.blank);
    expect(discards(await lifecyclePlanWith(app, { clock: { wallMs: 61 * MINUTE } }))).toContain(
      tab,
    );

    await shell.getByRole('button', { name: 'Pause automation', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(shell)).automation.paused).toBe(true);
    await expect(shell.locator('[data-automation-state="paused"]')).toHaveText('Automation paused');
    await expect(shell.locator('#automation-toggle')).toHaveAccessibleName('Resume automation');
    expect(
      await lifecyclePlanWith(app, { pressure: 'critical', then: { pressure: 'none' } }),
    ).toEqual([]);

    await launcher.quit(rig);
    const second = await launcher.launch();
    expect((await workspaceSnapshot(second.shell)).automation.paused).toBe(true);
    expect(await lifecyclePlan(second.app)).toEqual([]);
    await expect(second.shell.locator('[data-automation-state="paused"]')).toHaveText(
      'Automation paused',
    );
    await setPaused(second.shell, false);
    await expect
      .poll(async () => (await workspaceSnapshot(second.shell)).automation.paused)
      .toBe(false);
    await expect(second.shell.locator('[data-automation-state="paused"]')).toHaveCount(0);
  });
});

// ── 6. The regret metric ────────────────────────────────────────────────────────────────────────

interface Diagnostics {
  readonly regret: {
    readonly moves: number;
    readonly moveRegrets: number;
    readonly unloads: number;
    readonly unloadRegrets: number;
    readonly events: readonly { readonly how: string; readonly action: string }[];
  };
}

async function diagnostics(shell: Page): Promise<Diagnostics> {
  const result = (await shell.evaluate(() =>
    (globalThis as PageGlobal).veltriva.lifecycle.diagnostics(),
  )) as { ok: boolean; value: Diagnostics };
  expect(result.ok).toBe(true);
  return result.value;
}

test.describe('the regret metric', () => {
  test('bringing a tab back within an engaged hour of automation moving or unloading it counts; later, it does not', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const opened: TabId[] = [];
    for (let index = 0; index < 12; index += 1) {
      opened.push(await loadInNewTab(app, shell, plain(fixtureServer, `regret-${String(index)}`)));
    }
    await selectTab(rig, rig.blank);
    const [first, second, third] = opened;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('unreachable: 12 tabs were opened');
    }
    const before = (await diagnostics(shell)).regret;

    // Automation moves three to Sleeping.
    await advanceLifecycleClock(app, { engagedMs: 3 * HOUR, wallMs: 16 * MINUTE });
    await lifecycleEvaluate(app);
    await expect.poll(async () => (await diagnostics(shell)).regret.moves).toBe(before.moves + 3);

    // The user brings one back at once: a regret. Another after more than an engaged hour: not.
    await restoreTab(shell, first);
    await expect
      .poll(async () => (await diagnostics(shell)).regret.moveRegrets)
      .toBe(before.moveRegrets + 1);
    await advanceLifecycleClock(app, { engagedMs: 61 * MINUTE });
    await restoreTab(shell, second);
    await expect.poll(async () => (await sidebarIds(shell)).includes(second)).toBe(true);
    expect((await diagnostics(shell)).regret.moveRegrets).toBe(before.moveRegrets + 1);
    const event = (await diagnostics(shell)).regret.events[0];
    expect(event).toMatchObject({ how: 'restore', action: 'shelve' });

    // Memory pressure unloads a hidden tab; the user selects it right away: an unload regret.
    const target = opened[5];
    if (target === undefined) {
      throw new Error('unreachable');
    }
    const unloaded = await lifecyclePlanWith(app, {
      pressure: 'critical',
      then: { pressure: 'critical' },
    });
    expect(discards(unloaded).length).toBeGreaterThan(0);
    await expect
      .poll(
        async () => {
          await lifecycleEvaluate(app);
          return (await tabState(app, target))?.runtime;
        },
        { timeout: 90_000 },
      )
      .toBe('unloaded');
    await setMemoryPressure(app, 'none');
    await selectTab(rig, target);
    await waitForLoaded(app, target);
    await expect
      .poll(async () => (await diagnostics(shell)).regret.unloadRegrets)
      .toBeGreaterThanOrEqual(before.unloadRegrets + 1);

    // The local diagnostics page says the same.
    const counts = (await diagnostics(shell)).regret;
    await openTabAt(shell, 'veltriva://diagnostics');
    const page = shell.locator('[data-internal-page="diagnostics"]');
    await expect(page).toHaveAttribute('data-diagnostics-state', 'ready');
    await expect(page.locator('dd[data-diagnostics-field="moves-total"]')).toHaveText(
      String(counts.moves),
    );
    await expect(page.locator('dd[data-diagnostics-field="moves-regrets"]')).toHaveText(
      String(counts.moveRegrets),
    );
    await expect(page.locator('[data-diagnostics-privacy]')).toBeVisible();
  });
});
