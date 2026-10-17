// The permission broker, M1.4a (ADR-0002 item 9; src/main/permissions, src/main/prompts, the strip
// in src/renderer/features/prompts). A page that wants the camera, microphone, location,
// notifications or clipboard asks in the toolbar, naming its site; the answer is remembered per
// origin for the session. Everything else is refused without asking.
//
// The page is tests/fixtures/pages/permissions.html. A request that needs an answer does not settle
// until the user gives one, so a spec starts it (`startRequest`), answers in the strip, and reads
// the outcome later (`settledOutcome`).
//
// PRIVACY: an automated test never turns on this machine's camera or microphone and never makes a
// real location lookup. So no spec Allows `media` (camera, microphone) or `geolocation`: those are
// tested through the strip's sentence and site, Block, Dismiss, the embargo, embedded pages and the
// question going away with its page. Every Allow path (granted, remembered, per origin, queued, the
// 500 ms rule, focus) runs on `notifications` and `clipboard-read`. `prompt-ui.ts` backs this up: its
// `clickYes` and `answerAsSoonAsSeen` throw instead of answering "allow" to a question that lists
// the camera, the microphone or geolocation.
//
// Results depend on this machine's devices (harness rule 4), which is why a blocked request is
// judged by its denied result and an allowed one by `navigator.permissions.query`.
//
// Everything the specs ask is judged through a tab TabManager made (`loadTab`): a test tab
// (`openTab`) has no tab id, so the broker refuses it.
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication, Page } from '@playwright/test';

import { DISMISSALS_BEFORE_EMBARGO } from '../../src/core/permissions/permission-decisions';
import { MAX_QUEUED_PROMPTS } from '../../src/main/prompts/prompt-manager';
import { expect } from './expect';
import { test } from './fixtures';
import {
  crashTab,
  evaluateInTab,
  focusWebContents,
  focusedWebContents,
  fullscreenInfo,
  recordMainWarnings,
  requestPageFullscreen,
  selectedTabId,
  setSearchTemplate,
  tabState,
} from './hooks';
import type { PageGlobal } from './page-globals';
import {
  SETTLE_BEFORE_YES_MS,
  answerAsSoonAsSeen,
  clickNow,
  clickYes,
  expectNoStrip,
  expectNoStripFor,
  promptOf,
  promptStrip,
  stripButton,
  stripSentence,
  tabSnapshot,
  waitForStrip,
  waitForStripAfter,
} from './prompt-ui';
import {
  closeWithButton,
  internalPage,
  loadTab,
  tabElement,
  tabElements,
  typeAddress,
  waitForPage,
} from './shell-ui';
import type { LoadedTab } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

type RequestName =
  | 'geolocation'
  | 'notifications'
  | 'camera+microphone'
  | 'camera'
  | 'clipboard-read'
  | 'pointer-lock'
  | 'fullscreen'
  | 'clipboard-write';

type StateName = 'geolocation' | 'notifications' | 'camera' | 'microphone' | 'clipboard-read';

/** What `permissionsFixture.result(name)` returns once a request has settled. */
interface Outcome {
  readonly ok: boolean;
  readonly name?: string;
  readonly code?: number | null;
  readonly message?: string;
  readonly value?: string;
}

function startRequest(
  app: ElectronApplication,
  contentsId: number,
  name: RequestName,
  options: { readonly userGesture?: boolean } = {},
): Promise<unknown> {
  return evaluateInTab(
    app,
    contentsId,
    `permissionsFixture.start(${JSON.stringify(name)})`,
    options,
  );
}

async function outcomeOf(
  app: ElectronApplication,
  contentsId: number,
  name: RequestName,
): Promise<Outcome | null> {
  return (await evaluateInTab(
    app,
    contentsId,
    `permissionsFixture.result(${JSON.stringify(name)})`,
  )) as Outcome | null;
}

/** Waits until a started request has settled, however it ended. */
async function settledOutcome(
  app: ElectronApplication,
  contentsId: number,
  name: RequestName,
  timeoutMs = 30_000,
): Promise<Outcome> {
  const seen: { outcome: Outcome | null } = { outcome: null };
  await expect
    .poll(
      async () => {
        seen.outcome = await outcomeOf(app, contentsId, name);
        return seen.outcome !== null;
      },
      { message: `the ${name} request should settle`, timeout: timeoutMs },
    )
    .toBe(true);
  if (seen.outcome === null) {
    throw new Error('unreachable: the poll passed with no outcome');
  }
  return seen.outcome;
}

async function permissionState(
  app: ElectronApplication,
  contentsId: number,
  name: StateName | 'clipboard-write',
): Promise<string> {
  return (await evaluateInTab(
    app,
    contentsId,
    `permissionsFixture.state(${JSON.stringify(name)})`,
  )) as string;
}

/** The request was refused as denied: each API has its own way of saying so. */
function expectDenied(request: RequestName, outcome: Outcome): void {
  switch (request) {
    case 'geolocation':
      expect(outcome).toMatchObject({ ok: false, code: 1 });
      return;
    case 'notifications':
      expect(outcome).toMatchObject({ ok: true, value: 'denied' });
      return;
    default:
      expect(outcome).toMatchObject({ ok: false, name: 'NotAllowedError' });
  }
}

/** The requests a spec may Allow (see the privacy note above). */
type AllowableRequest = 'notifications' | 'clipboard-read';

/** The request was granted. (Reading an empty clipboard is still a grant: it only has no items.) */
function expectGranted(request: AllowableRequest, outcome: Outcome): void {
  if (request === 'notifications') {
    expect(outcome).toMatchObject({ ok: true, value: 'granted' });
  } else {
    expect(outcome.name ?? '').not.toBe('NotAllowedError');
  }
}

/** Waits until a tab's view starts `y` pixels down the window (within a pixel of display rounding). */
async function expectPageY(app: ElectronApplication, tabId: string, y: number): Promise<void> {
  await expect
    .poll(async () => Math.abs(((await tabState(app, tabId))?.bounds?.y ?? NaN) - y), {
      message: `the page of tab ${tabId} should start ${String(y)} px down`,
    })
    .toBeLessThanOrEqual(1);
}

interface PermissionCase {
  readonly title: string;
  readonly request: RequestName;
  /** The strip's sentence after "{site} wants to ". */
  readonly phrase: string;
  /** What the snapshot's prompt lists. */
  readonly asked: readonly string[];
  /** The `permissions.query` names that follow the answer. */
  readonly states: readonly StateName[];
  /** The request to Allow in this case's Allow test, or null: camera, microphone and location are never allowed. */
  readonly allowable: AllowableRequest | null;
}

const CASES: readonly PermissionCase[] = [
  {
    title: 'geolocation',
    request: 'geolocation',
    phrase: 'know your location',
    asked: ['geolocation'],
    states: ['geolocation'],
    allowable: null,
  },
  {
    title: 'notifications',
    request: 'notifications',
    phrase: 'show notifications',
    asked: ['notifications'],
    states: ['notifications'],
    allowable: 'notifications',
  },
  {
    title: 'camera and microphone',
    request: 'camera+microphone',
    phrase: 'use your camera and microphone',
    asked: ['camera', 'microphone'],
    states: ['camera', 'microphone'],
    allowable: null,
  },
  {
    title: 'clipboard read',
    request: 'clipboard-read',
    phrase: 'see text and images you copied',
    asked: ['clipboard-read'],
    states: ['clipboard-read'],
    allowable: 'clipboard-read',
  },
];

test.describe('the permission broker', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  for (const permission of CASES) {
    const allowable = permission.allowable;
    if (allowable !== null) {
      test(`${permission.title}: asks in the strip, and "Allow" grants it and is remembered`, async ({
        electronApp,
        fixtureServer,
        shell,
      }) => {
        const site = new URL(fixtureServer.origin).host;
        const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

        await startRequest(electronApp, tab.webContentsId, allowable);

        // The strip names the site from main's own record of the tab, and says what is asked.
        const promptId = await waitForStrip(shell, 'permission');
        await expect(stripSentence(shell)).toHaveText(`${site} wants to ${permission.phrase}`);
        expect(await promptOf(shell, tab.tabId)).toEqual({
          id: promptId,
          kind: 'permission',
          site,
          permissions: [...permission.asked],
        });
        await expect(stripButton(shell, 'Allow')).toBeVisible();
        await expect(stripButton(shell, 'Block')).toBeVisible();
        await expect(stripButton(shell, 'Dismiss')).toBeVisible();
        // The request is still waiting: nothing is decided until the user answers.
        expect(await outcomeOf(electronApp, tab.webContentsId, allowable)).toBeNull();

        await clickYes(shell, 'Allow');
        await expectNoStrip(shell, 'answering should close the strip');

        expectGranted(allowable, await settledOutcome(electronApp, tab.webContentsId, allowable));
        for (const name of permission.states) {
          expect(await permissionState(electronApp, tab.webContentsId, name), name).toBe('granted');
        }

        // Remembered: asking again shows no strip, and is not refused.
        await startRequest(electronApp, tab.webContentsId, allowable);
        await expectNoStripFor(shell, tab.tabId, 1_500, 'a remembered "Allow" must not ask again');
        expectGranted(allowable, await settledOutcome(electronApp, tab.webContentsId, allowable));
      });
    }

    test(`${permission.title}: asks in the strip, and "Block" denies it and is remembered`, async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const site = new URL(fixtureServer.origin).host;
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

      await startRequest(electronApp, tab.webContentsId, permission.request);

      const promptId = await waitForStrip(shell, 'permission');
      await expect(stripSentence(shell)).toHaveText(`${site} wants to ${permission.phrase}`);
      expect(await promptOf(shell, tab.tabId)).toEqual({
        id: promptId,
        kind: 'permission',
        site,
        permissions: [...permission.asked],
      });
      await expect(stripButton(shell, 'Allow')).toBeVisible();
      await expect(stripButton(shell, 'Block')).toBeVisible();
      await expect(stripButton(shell, 'Dismiss')).toBeVisible();
      // The request is still waiting: nothing is decided until the user answers.
      expect(await outcomeOf(electronApp, tab.webContentsId, permission.request)).toBeNull();

      // A no counts at once: no waiting.
      await clickNow(shell, 'Block');
      await expectNoStrip(shell, 'answering should close the strip');

      expectDenied(
        permission.request,
        await settledOutcome(electronApp, tab.webContentsId, permission.request),
      );
      for (const name of permission.states) {
        expect(await permissionState(electronApp, tab.webContentsId, name), name).toBe('denied');
      }

      // Remembered: asking again shows no strip and is denied again.
      await startRequest(electronApp, tab.webContentsId, permission.request);
      await expectNoStripFor(shell, tab.tabId, 1_000, 'a remembered "Block" must not ask again');
      expectDenied(
        permission.request,
        await settledOutcome(electronApp, tab.webContentsId, permission.request),
      );
    });

    // Notifications and the clipboard have their Dismiss tests below; camera, microphone and
    // location are only ever dismissed or blocked, so their embargo is checked here.
    if (allowable === null) {
      test(`${permission.title}: "Dismiss" asks again, and the third dismissal blocks it for the session`, async ({
        electronApp,
        fixtureServer,
        shell,
      }) => {
        const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

        for (let attempt = 1; attempt <= DISMISSALS_BEFORE_EMBARGO; attempt += 1) {
          await startRequest(electronApp, tab.webContentsId, permission.request);
          await waitForStrip(shell, 'permission');
          await expect(stripSentence(shell), `request ${String(attempt)} asks`).toContainText(
            `wants to ${permission.phrase}`,
          );
          await clickNow(shell, 'Dismiss');
          await expectNoStrip(shell);
          expectDenied(
            permission.request,
            await settledOutcome(electronApp, tab.webContentsId, permission.request),
          );
        }

        // Embargoed: no strip, denied at once, and still no decision recorded as an "Allow".
        await startRequest(electronApp, tab.webContentsId, permission.request);
        await expectNoStripFor(shell, tab.tabId, 1_000, 'an embargoed request must not ask');
        expectDenied(
          permission.request,
          await settledOutcome(electronApp, tab.webContentsId, permission.request),
        );
        for (const name of permission.states) {
          expect(await permissionState(electronApp, tab.webContentsId, name), name).toBe('denied');
        }
      });
    }
  }

  test('a camera-only request asks for the camera alone, and is blocked', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const site = new URL(fixtureServer.origin).host;
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

    await startRequest(electronApp, tab.webContentsId, 'camera');
    await waitForStrip(shell, 'permission');
    await expect(stripSentence(shell)).toHaveText(`${site} wants to use your camera`);
    expect(await promptOf(shell, tab.tabId)).toMatchObject({ permissions: ['camera'] });

    // Never allowed in a test (privacy note above): the harness refuses, and the answer is "Block".
    await expect(clickYes(shell, 'Allow')).rejects.toThrow('Refusing to Allow');
    await expect(stripSentence(shell)).toHaveText(`${site} wants to use your camera`);
    await clickNow(shell, 'Block');
    expectDenied('camera', await settledOutcome(electronApp, tab.webContentsId, 'camera'));
    expect(await permissionState(electronApp, tab.webContentsId, 'camera')).toBe('denied');
    // The microphone was never asked for, and is still not allowed.
    expect(await permissionState(electronApp, tab.webContentsId, 'microphone')).toBe('denied');
  });

  test('decisions belong to an origin: another host on the same server asks again', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const first = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
    await startRequest(electronApp, first.webContentsId, 'notifications');
    await waitForStrip(shell, 'permission');
    await clickYes(shell, 'Allow');
    await settledOutcome(electronApp, first.webContentsId, 'notifications');
    expect(await permissionState(electronApp, first.webContentsId, 'notifications')).toBe(
      'granted',
    );

    // `localhost` is another origin (and another site) on the same server.
    const other = await loadTab(
      electronApp,
      shell,
      fixtureServer.otherSiteUrl('/permissions.html'),
    );
    expect(await permissionState(electronApp, other.webContentsId, 'notifications')).toBe('denied');
    await startRequest(electronApp, other.webContentsId, 'notifications');
    await waitForStrip(shell, 'permission');
    await expect(stripSentence(shell)).toHaveText(
      `${new URL(fixtureServer.otherSiteOrigin).host} wants to show notifications`,
    );
    await clickNow(shell, 'Block');
    expectDenied(
      'notifications',
      await settledOutcome(electronApp, other.webContentsId, 'notifications'),
    );

    // The first origin is unaffected.
    expect(await permissionState(electronApp, first.webContentsId, 'notifications')).toBe(
      'granted',
    );
  });

  test.describe('dismissing', () => {
    test('denies this time but asks again; the third dismissal blocks for the session', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

      for (let attempt = 1; attempt <= DISMISSALS_BEFORE_EMBARGO; attempt += 1) {
        await startRequest(electronApp, tab.webContentsId, 'notifications');
        await waitForStrip(shell, 'permission');
        await expect(stripSentence(shell), `request ${String(attempt)} asks`).toContainText(
          'wants to show notifications',
        );
        // Dismiss counts at once, like a no.
        await clickNow(shell, 'Dismiss');
        await expectNoStrip(shell);
        expectDenied(
          'notifications',
          await settledOutcome(electronApp, tab.webContentsId, 'notifications'),
        );
      }

      // Three dismissals count as a block for the rest of the session: no strip, denied at once.
      await startRequest(electronApp, tab.webContentsId, 'notifications');
      await expectNoStripFor(
        shell,
        tab.tabId,
        1_500,
        `the ${String(DISMISSALS_BEFORE_EMBARGO + 1)}th request must not ask`,
      );
      expectDenied(
        'notifications',
        await settledOutcome(electronApp, tab.webContentsId, 'notifications'),
      );
      expect(await permissionState(electronApp, tab.webContentsId, 'notifications')).toBe('denied');
    });

    test('a dismissal is no decision: a later "Allow" still grants', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
      await startRequest(electronApp, tab.webContentsId, 'clipboard-read');
      await waitForStrip(shell, 'permission');
      await clickNow(shell, 'Dismiss');
      expectDenied(
        'clipboard-read',
        await settledOutcome(electronApp, tab.webContentsId, 'clipboard-read'),
      );
      expect(await permissionState(electronApp, tab.webContentsId, 'clipboard-read')).toBe(
        'denied',
      );

      await startRequest(electronApp, tab.webContentsId, 'clipboard-read');
      await waitForStrip(shell, 'permission');
      await clickYes(shell, 'Allow');
      expectGranted(
        'clipboard-read',
        await settledOutcome(electronApp, tab.webContentsId, 'clipboard-read'),
      );
      expect(await permissionState(electronApp, tab.webContentsId, 'clipboard-read')).toBe(
        'granted',
      );
    });
  });

  test.describe('the 500 ms rule', () => {
    test('an "Allow" that comes too early is ignored and the question stays; a later one works', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

      // Armed before the request, so the answer leaves the shell in the same task that sees the
      // question: as early as an answer can come.
      const early = answerAsSoonAsSeen(shell, tab.tabId, 'allow');
      await startRequest(electronApp, tab.webContentsId, 'notifications');
      const answer = await early;

      // The test is only meaningful if the answer really was inside the 500 ms window.
      const startedAt = (await evaluateInTab(
        electronApp,
        tab.webContentsId,
        "permissionsFixture.startedAt('notifications')",
      )) as number;
      expect(
        answer.sentAt - startedAt,
        'the machine was too slow to place an answer inside the 500 ms window',
      ).toBeLessThan(400);

      // Ignored: the same question stays on screen, and the page is still waiting.
      expect(await promptOf(shell, tab.tabId)).toMatchObject({ id: answer.promptId });
      await expect(promptStrip(shell)).toHaveAttribute('data-prompt-id', answer.promptId);
      expect(await outcomeOf(electronApp, tab.webContentsId, 'notifications')).toBeNull();
      expect(await permissionState(electronApp, tab.webContentsId, 'notifications')).toBe('denied');

      // After the 500 ms, the same click works.
      await clickYes(shell, 'Allow');
      expectGranted(
        'notifications',
        await settledOutcome(electronApp, tab.webContentsId, 'notifications'),
      );
      expect(await permissionState(electronApp, tab.webContentsId, 'notifications')).toBe(
        'granted',
      );
    });

    test('"Block" and "Dismiss" are never delayed', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

      const blocked = answerAsSoonAsSeen(shell, tab.tabId, 'block');
      await startRequest(electronApp, tab.webContentsId, 'clipboard-read');
      await blocked;
      // Counted on the spot: the question is gone and the page was told no.
      await expectNoStrip(shell, 'an immediate "Block" should count');
      expectDenied(
        'clipboard-read',
        await settledOutcome(electronApp, tab.webContentsId, 'clipboard-read'),
      );
      expect(await permissionState(electronApp, tab.webContentsId, 'clipboard-read')).toBe(
        'denied',
      );

      const dismissed = answerAsSoonAsSeen(shell, tab.tabId, 'dismiss');
      await startRequest(electronApp, tab.webContentsId, 'notifications');
      await dismissed;
      await expectNoStrip(shell, 'an immediate "Dismiss" should count');
      expectDenied(
        'notifications',
        await settledOutcome(electronApp, tab.webContentsId, 'notifications'),
      );
    });
  });

  test.describe('the 500 ms rule counts from when the question is shown (M1.4a review)', () => {
    /**
     * Selects `tabId` and, in the same task, sends "Allow" for `promptId`: as early after the
     * selection as an answer can come. The yes is a command like the click's, so main sees it a
     * few milliseconds after it saw the selection. Returns how long that took, in the shell's
     * own milliseconds, so a spec can tell whether the window was really beaten.
     */
    function selectAndAllow(shell: Page, tabId: string, promptId: string): Promise<number> {
      return shell.evaluate(
        async ({ tab, prompt }) => {
          const veltriva = (globalThis as PageGlobal).veltriva;
          await veltriva.tabs.select({ tabId: tab });
          const selectedAt = Date.now();
          await veltriva.prompts.respond({
            tabId: tab,
            promptId: prompt,
            decision: 'allow',
            remember: false,
          });
          return Date.now() - selectedAt;
        },
        { tab: tabId, prompt: promptId },
      );
    }

    test('a question asked by a background tab cannot be allowed the instant its tab is selected, but can after a wait', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const asking = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
      // Another tab on top: the asking page is in the background from now on.
      const other = await loadTab(
        electronApp,
        shell,
        fixtureServer.url('/page-a.html?case=background'),
      );
      expect(await selectedTabId(electronApp)).toBe(other.tabId);

      await startRequest(electronApp, asking.webContentsId, 'notifications');
      let promptId = '';
      await expect
        .poll(
          async () => {
            promptId = (await promptOf(shell, asking.tabId))?.id ?? '';
            return promptId;
          },
          { message: "main should hold the background tab's question" },
        )
        .not.toBe('');
      // Long enough that the question would already have counted, had the clock run in the
      // background: it must not have.
      await delay(SETTLE_BEFORE_YES_MS);
      await expectNoStrip(shell, 'the question belongs to a tab that is not shown');

      const elapsed = await selectAndAllow(shell, asking.tabId, promptId);
      expect(
        elapsed,
        'the machine was too slow to place the answer inside the 500 ms window',
      ).toBeLessThan(400);

      // Ignored: the same question is on screen now, and the page is still waiting.
      await expect(promptStrip(shell)).toHaveAttribute('data-prompt-id', promptId);
      expect((await promptOf(shell, asking.tabId))?.id).toBe(promptId);
      expect(await outcomeOf(electronApp, asking.webContentsId, 'notifications')).toBeNull();
      expect(await permissionState(electronApp, asking.webContentsId, 'notifications')).toBe(
        'denied',
      );

      // After the 500 ms of being shown, the same yes counts.
      await clickYes(shell, 'Allow');
      expectGranted(
        'notifications',
        await settledOutcome(electronApp, asking.webContentsId, 'notifications'),
      );
    });

    test('a question that is hidden and shown again starts its 500 ms again', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const asking = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
      await startRequest(electronApp, asking.webContentsId, 'notifications');
      const promptId = (await waitForStrip(shell, 'permission')) ?? '';
      // Shown for longer than 500 ms: a yes would count now.
      await delay(SETTLE_BEFORE_YES_MS);

      // The user looks at another tab and comes back.
      const other = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=hide'));
      await expectNoStrip(shell, 'the question must not show over another tab');
      expect(other.tabId).not.toBe(asking.tabId);

      const elapsed = await selectAndAllow(shell, asking.tabId, promptId);
      expect(
        elapsed,
        'the machine was too slow to place the answer inside the 500 ms window',
      ).toBeLessThan(400);
      await expect(promptStrip(shell)).toHaveAttribute('data-prompt-id', promptId);
      expect(await outcomeOf(electronApp, asking.webContentsId, 'notifications')).toBeNull();

      await clickYes(shell, 'Allow');
      expectGranted(
        'notifications',
        await settledOutcome(electronApp, asking.webContentsId, 'notifications'),
      );
    });
  });

  test.describe('queued questions', () => {
    /** Starts a request and waits until the strip shows its question (so the order is known). */
    async function ask(
      app: ElectronApplication,
      shell: Page,
      tab: LoadedTab,
      name: RequestName,
    ): Promise<void> {
      await startRequest(app, tab.webContentsId, name);
      await expect.poll(async () => (await promptOf(shell, tab.tabId)) !== null).toBe(true);
    }

    test('a second question shows after the first is answered, and a too-early "Allow" cannot approve it', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const site = new URL(fixtureServer.origin).host;
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

      await ask(electronApp, shell, tab, 'notifications');
      const first = await promptOf(shell, tab.tabId);
      // The second question queues behind the first; the strip keeps showing the first.
      await startRequest(electronApp, tab.webContentsId, 'clipboard-read');
      await expect(stripSentence(shell)).toHaveText(`${site} wants to show notifications`);
      expect((await promptOf(shell, tab.tabId))?.id).toBe(first?.id);
      expect(await outcomeOf(electronApp, tab.webContentsId, 'clipboard-read')).toBeNull();

      // Armed now, so the second question is answered "Allow" the moment the shell sees it.
      const early = answerAsSoonAsSeen(shell, tab.tabId, 'allow', first === null ? [] : [first.id]);
      await clickYes(shell, 'Allow');
      const answered = await early;

      expect(answered.promptId).not.toBe(first?.id);
      await expect(stripSentence(shell)).toHaveText(
        `${site} wants to see text and images you copied`,
      );
      // The too-early yes was ignored: the second question is still there and unanswered.
      expect(await promptOf(shell, tab.tabId)).toMatchObject({
        id: answered.promptId,
        permissions: ['clipboard-read'],
      });
      expect(await outcomeOf(electronApp, tab.webContentsId, 'clipboard-read')).toBeNull();
      expect(await permissionState(electronApp, tab.webContentsId, 'clipboard-read')).toBe(
        'denied',
      );
      // The first one did get its yes.
      expect(await permissionState(electronApp, tab.webContentsId, 'notifications')).toBe(
        'granted',
      );

      await clickYes(shell, 'Allow');
      expectGranted(
        'clipboard-read',
        await settledOutcome(electronApp, tab.webContentsId, 'clipboard-read'),
      );
      expect(await permissionState(electronApp, tab.webContentsId, 'clipboard-read')).toBe(
        'granted',
      );
      await expectNoStrip(shell);
    });

    test('a double click on "Allow" answers one question, never two', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

      await ask(electronApp, shell, tab, 'notifications');
      await startRequest(electronApp, tab.webContentsId, 'clipboard-read');
      await expect(stripSentence(shell)).toContainText('show notifications');
      await delay(700);

      await stripButton(shell, 'Allow').dblclick();

      // Whichever of the two clicks reached which strip, the second question is untouched.
      await expect(stripSentence(shell)).toContainText('see text and images you copied');
      expect(await outcomeOf(electronApp, tab.webContentsId, 'clipboard-read')).toBeNull();
      expect(await permissionState(electronApp, tab.webContentsId, 'clipboard-read')).toBe(
        'denied',
      );
      expect(await permissionState(electronApp, tab.webContentsId, 'notifications')).toBe(
        'granted',
      );

      await clickNow(shell, 'Block');
      expectDenied(
        'clipboard-read',
        await settledOutcome(electronApp, tab.webContentsId, 'clipboard-read'),
      );
    });

    test('a page that piles up questions has the extra ones refused at once', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

      // One shown and `MAX_QUEUED_PROMPTS - 1` waiting fill the queue; the next one is refused.
      // Four different permissions. They reach main in the order they are asked, except that
      // getUserMedia first looks at the devices and arrives about two seconds late (measured), so
      // which one is refused is read from what happened, not assumed.
      const requests: RequestName[] = ['notifications', 'clipboard-read', 'geolocation', 'camera'];
      expect(requests.length).toBe(MAX_QUEUED_PROMPTS + 1);
      for (const name of requests) {
        await startRequest(electronApp, tab.webContentsId, name);
        await delay(300);
      }

      // Exactly one request settles by itself, with no question: the one that arrived fourth.
      const settledAlone: RequestName[] = [];
      await expect
        .poll(
          async () => {
            settledAlone.length = 0;
            for (const name of requests) {
              if ((await outcomeOf(electronApp, tab.webContentsId, name)) !== null) {
                settledAlone.push(name);
              }
            }
            return settledAlone.length;
          },
          { message: 'the fourth request should be refused at once', timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(1);
      expect(settledAlone).toHaveLength(1);
      const refused = settledAlone[0] ?? 'notifications';
      expectDenied(refused, await settledOutcome(electronApp, tab.webContentsId, refused));

      // The other three are queued, one question at a time. Answering them leaves nothing behind:
      // the refused one was never shown.
      const queued = requests.filter((name) => name !== refused);
      let previous: string | null = null;
      let answered = 0;
      while (answered < queued.length) {
        previous = await waitForStripAfter(shell, 'permission', previous);
        await clickNow(shell, 'Block');
        answered += 1;
      }
      for (const name of queued) {
        expectDenied(name, await settledOutcome(electronApp, tab.webContentsId, name));
      }
      await expectNoStripFor(shell, tab.tabId, 1_000, 'no fourth question was queued');
    });
  });

  test.describe('prompts go with their page', () => {
    test('navigating the tab dismisses its question, and nothing is remembered', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const url = fixtureServer.url('/permissions.html');
      const away = fixtureServer.url('/page-a.html?case=permissions-navigate');
      const tab = await loadTab(electronApp, shell, url);

      // More times than three real dismissals would allow: a page that went away was not
      // dismissed by the user, so it must be asked about every time.
      for (let attempt = 1; attempt <= DISMISSALS_BEFORE_EMBARGO + 1; attempt += 1) {
        await startRequest(electronApp, tab.webContentsId, 'notifications');
        await waitForStrip(shell, 'permission');
        expect(await promptOf(shell, tab.tabId), `attempt ${String(attempt)}`).not.toBeNull();

        await typeAddress(shell, away);
        await waitForPage(electronApp, tab.tabId, { url: away });
        await expectNoStrip(shell, 'a new document ends the question');
        expect(await promptOf(shell, tab.tabId)).toBeNull();

        await typeAddress(shell, url);
        await waitForPage(electronApp, tab.tabId, { url });
      }
      // No decision was recorded by any of it.
      expect(await permissionState(electronApp, tab.webContentsId, 'notifications')).toBe('denied');
      await startRequest(electronApp, tab.webContentsId, 'notifications');
      await waitForStrip(shell, 'permission');
      await clickYes(shell, 'Allow');
      expectGranted(
        'notifications',
        await settledOutcome(electronApp, tab.webContentsId, 'notifications'),
      );
    });

    test('closing the tab dismisses its question', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const other = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=other'));
      const asking = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
      await startRequest(electronApp, asking.webContentsId, 'geolocation');
      await waitForStrip(shell, 'permission');

      await closeWithButton(shell, asking.tabId);

      await expect
        .poll(async () => (await tabState(electronApp, asking.tabId)) === undefined)
        .toBe(true);
      await expectNoStripFor(shell, other.tabId, 1_000, 'the closed tab left a question behind');
      expect(await promptOf(shell, other.tabId)).toBeNull();
    });

    test('a crashed page loses its question', async ({ electronApp, fixtureServer, shell }) => {
      const asking = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
      await startRequest(electronApp, asking.webContentsId, 'notifications');
      await waitForStrip(shell, 'permission');

      await crashTab(electronApp, asking.tabId);

      await expect(internalPage(shell, 'crashed')).toBeVisible();
      await expectNoStrip(shell, 'a crash ends the question');
      expect(await promptOf(shell, asking.tabId)).toBeNull();
    });

    test('a failed load loses its question', async ({ electronApp, fixtureServer, shell }) => {
      const asking = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
      await startRequest(electronApp, asking.webContentsId, 'notifications');
      await waitForStrip(shell, 'permission');

      // The discard port on this machine: nothing listens, so the load is refused at once.
      await typeAddress(shell, 'http://127.0.0.1:9/');

      await expect(internalPage(shell, 'network-error')).toBeVisible();
      await expectNoStrip(shell, 'a failed load ends the question');
      expect(await promptOf(shell, asking.tabId)).toBeNull();
    });
  });

  test('a question belongs to its tab: hidden while another tab is selected, back on return', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const asking = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
    const baseline = (await tabState(electronApp, asking.tabId))?.bounds;
    expect(baseline).toBeTruthy();
    const yWithoutStrip = baseline?.y ?? NaN;

    await startRequest(electronApp, asking.webContentsId, 'notifications');
    const promptId = await waitForStrip(shell, 'permission');

    // The strip is chrome above the page area, so the page moves down to make room for it.
    await expect
      .poll(async () => (await tabState(electronApp, asking.tabId))?.bounds?.y ?? NaN, {
        message: 'the page should sit lower while the strip shows',
      })
      .toBeGreaterThan(yWithoutStrip + 20);
    const yWithStrip = (await tabState(electronApp, asking.tabId))?.bounds?.y ?? NaN;
    // The strip's box ends where the page starts.
    const strip = await promptStrip(shell).boundingBox();
    expect(strip).not.toBeNull();
    expect(Math.abs((strip?.y ?? 0) + (strip?.height ?? 0) - yWithStrip)).toBeLessThanOrEqual(2);

    // Another tab: no strip, and the page is back where it was.
    const second = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=second'));
    await expectNoStrip(shell, 'the question must not show over another tab');
    expect(await promptOf(shell, second.tabId)).toBeNull();
    await expectPageY(electronApp, second.tabId, yWithoutStrip);
    // It still belongs to the first tab.
    expect((await promptOf(shell, asking.tabId))?.id).toBe(promptId);

    // Back to the first tab: the same question, and the page makes room again.
    await tabElement(shell, asking.tabId).click();
    await expect(promptStrip(shell)).toHaveAttribute('data-prompt-id', promptId ?? '');
    await expectPageY(electronApp, asking.tabId, yWithStrip);

    // Answering it gives the room back.
    await clickYes(shell, 'Allow');
    await expectNoStrip(shell);
    await expectPageY(electronApp, asking.tabId, yWithoutStrip);
  });

  test('a request from an embedded page of another site gets no strip and is denied', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const warnings = await recordMainWarnings(electronApp);
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
    // `localhost` inside a `127.0.0.1` page, allowed the feature by the page itself: only the
    // browser's policy can refuse it.
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      `permissionsFixture.addFrame(${JSON.stringify(fixtureServer.otherSiteUrl('/permissions-frame.html'))})`,
    );

    for (const name of ['geolocation', 'camera'] as const) {
      const reply = (await evaluateInTab(
        electronApp,
        tab.webContentsId,
        `permissionsFixture.askFrame(${JSON.stringify(name)})`,
      )) as { origin: string; state: string; outcome: Outcome };

      expect(reply.origin, 'the request came from the embedded page').toBe(
        fixtureServer.otherSiteOrigin,
      );
      expect(reply.state, `${name} state inside the frame`).toBe('denied');
      expectDenied(name === 'camera' ? 'camera' : 'geolocation', reply.outcome);
      await expectNoStripFor(shell, tab.tabId, 500, `the ${name} request must not ask`);
    }

    // Refused by the broker's rule for other sites, not for some other reason.
    const denials = (await warnings.all()).filter(
      (warning) => warning.event === 'permission.denied',
    );
    expect(denials.map((warning) => warning.fields.reason)).toContain('cross-origin-frame');
    expect(await promptOf(shell, tab.tabId)).toBeNull();
    // The page around it was never asked and was never allowed anything.
    expect(await permissionState(electronApp, tab.webContentsId, 'geolocation')).toBe('denied');
  });

  test('pointer lock is denied without asking', async ({ electronApp, fixtureServer, shell }) => {
    const warnings = await recordMainWarnings(electronApp);
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

    // With a user activation for Chromium, so the request reaches the broker.
    await startRequest(electronApp, tab.webContentsId, 'pointer-lock', { userGesture: true });
    const outcome = await settledOutcome(electronApp, tab.webContentsId, 'pointer-lock');

    expect(outcome).toMatchObject({ ok: false, name: 'pointerlockerror' });
    expect(
      await evaluateInTab(electronApp, tab.webContentsId, 'document.pointerLockElement'),
    ).toBeNull();
    await expectNoStripFor(shell, tab.tabId, 500, 'pointer lock must not ask');
    // The broker saw it and refused it; the page did not just lack an activation.
    const denied = (await warnings.all()).filter(
      (warning) =>
        warning.event === 'permission.denied' && warning.fields.permission === 'pointerLock',
    );
    expect(denied.length, 'the broker should have refused pointerLock').toBeGreaterThanOrEqual(1);
    expect(denied[0]?.fields.reason).toBe('not-on-allow-list');
  });

  test('after an answer with the mouse the page has the keyboard back', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

    for (const [request, button] of [
      ['notifications', 'Allow'],
      ['clipboard-read', 'Block'],
    ] as const) {
      await startRequest(electronApp, tab.webContentsId, request);
      await waitForStrip(shell, 'permission');
      // A real click on the strip would put the keyboard in the shell; Playwright's does not.
      await focusWebContents(electronApp, 'shell');
      await expect.poll(async () => (await focusedWebContents(electronApp))?.isShell).toBe(true);

      if (button === 'Allow') {
        await clickYes(shell, 'Allow');
      } else {
        await clickNow(shell, 'Block');
      }

      await expect
        .poll(async () => (await focusedWebContents(electronApp))?.webContentsId, {
          message: `the page should have the keyboard after "${button}"`,
        })
        .toBe(tab.webContentsId);
      await settledOutcome(electronApp, tab.webContentsId, request);
      await expectNoStrip(shell);
    }
  });

  test.describe('still works without asking', () => {
    test('a page can go fullscreen with a gesture, with no strip', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

      await requestPageFullscreen(electronApp, tab.webContentsId);

      await expect
        .poll(async () => (await fullscreenInfo(electronApp)).state?.tabId, {
          message: 'main should report the tab as fullscreen',
        })
        .toBe(tab.tabId);
      expect(await promptOf(shell, tab.tabId)).toBeNull();
      expect((await tabSnapshot(shell, tab.tabId))?.blockedPopups).toBeNull();
      await expect(promptStrip(shell)).toHaveCount(0);

      await evaluateInTab(electronApp, tab.webContentsId, 'document.exitFullscreen()');
      await expect
        .poll(async () => (await fullscreenInfo(electronApp)).state, {
          message: 'the page should leave fullscreen',
        })
        .toBeNull();
    });

    test('a copy button (clipboard-sanitized-write) writes with no strip', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const saved = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
      try {
        const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));

        // With a user activation: Chromium wants one for a write.
        await startRequest(electronApp, tab.webContentsId, 'clipboard-write', {
          userGesture: true,
        });
        expect(await settledOutcome(electronApp, tab.webContentsId, 'clipboard-write')).toEqual({
          ok: true,
        });
        expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(
          'permissions fixture text',
        );
        expect(await permissionState(electronApp, tab.webContentsId, 'clipboard-write')).toBe(
          'granted',
        );
        await expectNoStripFor(shell, tab.tabId, 500, 'a copy button must not ask');
      } finally {
        await electronApp
          .evaluate(async ({ clipboard }, text) => {
            if (text === '') {
              clipboard.clear();
            } else {
              await clipboard.writeText(text);
            }
          }, saved)
          .catch((error: unknown) => {
            console.warn('Could not restore the clipboard text:', error);
          });
      }
    });
  });
});
