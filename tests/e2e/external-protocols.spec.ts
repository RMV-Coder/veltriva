// The external-protocol guard, M1.4a (ADR-0002 item 9; src/core/url/external-protocol.ts,
// src/main/external/protocol-guard.ts). Electron would hand any URL scheme it can't load to Windows
// with no prompt. Veltriva launches another app only after a trusted gesture in the page within 5 s
// and the user's yes in the toolbar ("site wants to open App"); dangerous schemes never launch.
//
// No real app may ever open. Test builds record each launch instead (`externalLaunches`), and the
// specs use `veltriva-test:`, a scheme nobody has registered, so even a mistake would open nothing.
// The one exception is `mailto:` typed into the address bar, which is asked about but only ever
// recorded.
//
// Gestures are `sendInputEvent` clicks (`clickElement`); "no gesture" is `executeJavaScript(…, true)`
// or a page that acts on its own (harness rule, ADR-0008 item 4). A yes counts only after 500 ms, so
// `clickYes` waits.
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication } from '@playwright/test';

import { expect } from './expect';
import { test } from './fixtures';
import {
  allWindows,
  clickElement,
  evaluateInTab,
  externalLaunches,
  pageForTab,
  popupWindows,
  recordMainWarnings,
  setSearchTemplate,
  tabState,
  tabStates,
} from './hooks';
import {
  alwaysAllowBox,
  answerAsSoonAsSeen,
  clickNow,
  clickYes,
  expectNoStrip,
  expectNoStripFor,
  promptOf,
  promptStrip,
  stripOfKind,
  stripSentence,
  waitForStrip,
} from './prompt-ui';
import { loadTab, tabElements, typeAddress } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** Waits long enough for a launch that should not happen to have happened, then checks. */
async function expectNoLaunch(app: ElectronApplication, message: string): Promise<void> {
  await delay(500);
  expect(await externalLaunches(app), message).toEqual([]);
}

test.describe('the external-protocol guard', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test.describe('a link with a gesture', () => {
    test('asks in the strip, and "Open" launches exactly that URL', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const site = new URL(fixtureServer.origin).host;
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

      await clickElement(electronApp, tab.webContentsId, '#link-hello');

      const promptId = await waitForStrip(shell, 'external-protocol');
      // "{site} wants to open {App}", or, with no app registered for the scheme, "a “scheme:” link".
      await expect(stripSentence(shell)).toHaveText(
        new RegExp(
          `^${site.replaceAll('.', '\\.')} wants to open (a “veltriva-test:” link in another app|.+)$`,
        ),
      );
      expect(await promptOf(shell, tab.tabId)).toMatchObject({
        id: promptId,
        kind: 'external-protocol',
        site,
        scheme: 'veltriva-test',
        canRemember: true,
      });
      await expect(alwaysAllowBox(shell)).toBeVisible();
      await expect(alwaysAllowBox(shell)).not.toBeChecked();
      // Nothing launches until the user says so.
      expect(await externalLaunches(electronApp)).toEqual([]);

      await clickYes(shell, 'Open');

      await expect
        .poll(() => externalLaunches(electronApp), { message: 'Open should launch the URL' })
        .toEqual(['veltriva-test:hello']);
      await expectNoStrip(shell);
      // The page itself did not navigate: the guard cancelled that.
      expect((await tabState(electronApp, tab.tabId))?.url).toBe(
        fixtureServer.url('/external-links.html'),
      );
    });

    for (const refusal of ['Cancel', 'Dismiss'] as const) {
      test(`"${refusal}" launches nothing, and asks again next time`, async ({
        electronApp,
        fixtureServer,
        shell,
      }) => {
        const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

        await clickElement(electronApp, tab.webContentsId, '#link-hello');
        await waitForStrip(shell, 'external-protocol');
        // Even a ticked box counts only for "Open".
        await alwaysAllowBox(shell).check();
        await clickNow(shell, refusal);

        await expectNoStrip(shell);
        await expectNoLaunch(electronApp, `${refusal} must not launch anything`);

        // Nothing was remembered: the next click asks again.
        await clickElement(electronApp, tab.webContentsId, '#link-hello');
        await waitForStrip(shell, 'external-protocol');
        await expect(alwaysAllowBox(shell)).not.toBeChecked();
        await clickNow(shell, 'Cancel');
        await expectNoLaunch(electronApp, 'the second answer was a no too');
      });
    }

    test('an "Open" that comes too early is ignored: nothing launches and the question stays', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

      // Armed before the click, so the answer leaves the shell in the same task that first sees the
      // question: as early as an answer can come (a Playwright locator takes longer than 500 ms on
      // a loaded machine, and that would be a late answer).
      const early = answerAsSoonAsSeen(shell, tab.tabId, 'allow');
      const clickedAt = Date.now();
      await clickElement(electronApp, tab.webContentsId, '#link-hello');
      const answer = await early;

      // The test means something only if the answer really came inside the 500 ms window.
      expect(
        answer.sentAt - clickedAt,
        'the machine was too slow to place an answer inside the 500 ms window',
      ).toBeLessThan(400);

      // Ignored: nothing launches, and the same question stays on screen.
      await delay(300);
      expect(await externalLaunches(electronApp)).toEqual([]);
      await expect(promptStrip(shell)).toHaveAttribute('data-prompt-id', answer.promptId);

      // After the 500 ms it counts.
      await clickYes(shell, 'Open');
      await expect.poll(() => externalLaunches(electronApp)).toEqual(['veltriva-test:hello']);
    });
  });

  test('"Always allow" skips the question the next time, but never the gesture', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const warnings = await recordMainWarnings(electronApp);
    const site = new URL(fixtureServer.origin).host;
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

    await clickElement(electronApp, tab.webContentsId, '#link-hello');
    await waitForStrip(shell, 'external-protocol');
    await expect(alwaysAllowBox(shell)).toHaveAccessibleName(
      `Always allow ${site} to open veltriva-test: links`,
    );
    await alwaysAllowBox(shell).check();
    await clickYes(shell, 'Open');
    await expect.poll(() => externalLaunches(electronApp)).toEqual(['veltriva-test:hello']);

    // The next click, with its own gesture, launches with no strip.
    await clickElement(electronApp, tab.webContentsId, '#link-hello');
    await expect
      .poll(() => externalLaunches(electronApp), { message: 'a remembered site should launch' })
      .toEqual(['veltriva-test:hello', 'veltriva-test:hello']);
    expect(await promptOf(shell, tab.tabId)).toBeNull();
    await expect(promptStrip(shell)).toHaveCount(0);

    // Still remembered for the site and the scheme, whatever the rest of the URL says.
    await clickElement(electronApp, tab.webContentsId, '#link-escape');
    await expect
      .poll(() => externalLaunches(electronApp))
      .toEqual(['veltriva-test:hello', 'veltriva-test:hello', 'veltriva-test:a%20b%22c']);

    // But it never skips the gesture: a script with no click launches nothing.
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      'externalFixture.goTo("veltriva-test:hello")',
      {
        userGesture: true,
      },
    );
    await expectNoStripFor(shell, tab.tabId, 1_000, 'a remembered site still needs a gesture');
    expect(await externalLaunches(electronApp)).toHaveLength(3);
    await expect
      .poll(
        async () =>
          (await warnings.all()).filter((warning) => warning.event === 'external.noGesture').length,
      )
      .toBe(1);

    // And only for that site: the same link on another site asks.
    const other = await loadTab(
      electronApp,
      shell,
      fixtureServer.otherSiteUrl('/external-links.html'),
    );
    await clickElement(electronApp, other.webContentsId, '#link-hello');
    await waitForStrip(shell, 'external-protocol');
    await expect(stripSentence(shell)).toContainText(new URL(fixtureServer.otherSiteOrigin).host);
    await clickNow(shell, 'Cancel');
    expect(await externalLaunches(electronApp)).toHaveLength(3);
  });

  test.describe('without a gesture', () => {
    test('location.href set from a script gets no strip and no launch', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const warnings = await recordMainWarnings(electronApp);
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

      // Chromium gets a user activation; main sees no input at all.
      await evaluateInTab(
        electronApp,
        tab.webContentsId,
        'externalFixture.goTo("veltriva-test:nogesture")',
        { userGesture: true },
      );

      await expectNoStripFor(shell, tab.tabId, 1_500, 'a script is not a gesture');
      await expectNoLaunch(electronApp, 'no gesture, no launch');
      // Refused for the missing gesture, by the guard.
      await expect
        .poll(async () => (await warnings.all()).map((warning) => warning.event))
        .toContain('external.noGesture');
    });

    test('a page that tries on load gets no strip and no launch', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const warnings = await recordMainWarnings(electronApp);
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-onload.html'));

      await expectNoStripFor(shell, tab.tabId, 1_500, 'a page may not open an app on load');
      await expectNoLaunch(electronApp, 'no gesture, no launch');
      expect((await warnings.all()).map((warning) => warning.event)).toContain(
        'external.noGesture',
      );
      // The page is still the page: the attempt was cancelled, not followed.
      expect((await tabState(electronApp, tab.tabId))?.url).toBe(
        fixtureServer.url('/external-onload.html'),
      );
    });

    test('a click pays for one launch only: the same gesture cannot be used again', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

      await clickElement(electronApp, tab.webContentsId, '#link-hello');
      const promptId = await waitForStrip(shell, 'external-protocol');

      // A script now, inside the click's 5 s: the click was already spent on the question above.
      await evaluateInTab(
        electronApp,
        tab.webContentsId,
        'externalFixture.goTo("veltriva-test:second")',
        {
          userGesture: true,
        },
      );

      await delay(500);
      await expect(promptStrip(shell)).toHaveAttribute('data-prompt-id', promptId ?? '');
      await clickYes(shell, 'Open');
      await expect.poll(() => externalLaunches(electronApp)).toEqual(['veltriva-test:hello']);
      await expectNoStrip(shell);
      // Only the click's launch happened: the script's one never got a question of its own.
      await delay(300);
      expect(await externalLaunches(electronApp)).toEqual(['veltriva-test:hello']);
    });
  });

  test.describe('always blocked', () => {
    const BLOCKED = [
      { id: '#link-msdt', scheme: 'ms-msdt:' },
      { id: '#link-search-ms', scheme: 'search-ms:' },
      { id: '#link-file', scheme: 'file:' },
      { id: '#link-javascript', scheme: 'javascript:' },
    ] as const;

    for (const blocked of BLOCKED) {
      test(`a click on a ${blocked.scheme} link gets no strip and no launch`, async ({
        electronApp,
        fixtureServer,
        shell,
      }) => {
        const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

        // With a gesture: the refusal is the scheme's, not the missing click's.
        await clickElement(electronApp, tab.webContentsId, blocked.id);

        await expectNoStripFor(shell, tab.tabId, 1_500, `${blocked.scheme} must never ask`);
        expect(await externalLaunches(electronApp)).toEqual([]);
        expect(await promptOf(shell, tab.tabId)).toBeNull();
        // The tab is still on the fixture page.
        expect((await tabState(electronApp, tab.tabId))?.url).toBe(
          fixtureServer.url('/external-links.html'),
        );
      });
    }

    test('window.open of ms-msdt: with a gesture opens nothing, asks nothing and launches nothing', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));
      const tabsBefore = (await tabStates(electronApp)).length;

      await clickElement(electronApp, tab.webContentsId, '#open-window-blocked');

      await expect
        .poll(() => evaluateInTab(electronApp, tab.webContentsId, 'externalFixture.openResult'))
        .toBe('null');
      await expectNoStripFor(shell, tab.tabId, 1_000, 'ms-msdt: must never ask');
      expect(await externalLaunches(electronApp)).toEqual([]);
      expect(await popupWindows(electronApp)).toEqual([]);
      expect((await tabStates(electronApp)).length).toBe(tabsBefore);
    });
  });

  test.describe('frames', () => {
    test('a link clicked inside an embedded page of another site gets no strip and no launch; a click on the page itself works', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const warnings = await recordMainWarnings(electronApp);
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));
      await evaluateInTab(electronApp, tab.webContentsId, 'externalFixture.addFrame()');

      // A click on the link inside the frame. `sendInputEvent` can't make it: it reaches only the
      // top page's widget, and a cross-site frame (its own process) never receives the click
      // (measured). Playwright's click goes through CDP, which routes it into the frame.
      const page = await pageForTab(electronApp, tab.tabId);
      await page.frameLocator('#external-frame').locator('#frame-link').click();
      // The click did land in the embedded page, so the refusal below is the guard's.
      await expect
        .poll(() => evaluateInTab(electronApp, tab.webContentsId, 'externalFixture.frameClicks'))
        .toBe(1);

      await expectNoStripFor(shell, tab.tabId, 1_500, 'an embedded page may not open apps');
      await expectNoLaunch(electronApp, 'a frame cannot launch an app');
      // The guard saw it, and refused it for being in a frame.
      await expect
        .poll(
          async () =>
            (await warnings.all()).filter(
              (warning) =>
                warning.event === 'guard.navigationBlocked' &&
                warning.fields.mainFrame === false &&
                warning.fields.external === true,
            ).length,
        )
        .toBeGreaterThanOrEqual(1);

      // The same kind of link in the page itself works.
      await clickElement(electronApp, tab.webContentsId, '#link-hello');
      await waitForStrip(shell, 'external-protocol');
      await clickYes(shell, 'Open');
      await expect.poll(() => externalLaunches(electronApp)).toEqual(['veltriva-test:hello']);
    });
  });

  test.describe('a typed address', () => {
    test('mailto: asks with no site and no "always allow"; "Open" launches it', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));
      // Hit counts accumulate for the whole worker (ADR-0008 item 4): count what this test adds.
      const searchesBefore = fixtureServer.pathHits('/search');

      // Typed input counts as a gesture. The address is not searched for: it would send an
      // address to the search engine.
      await typeAddress(shell, 'mailto:someone@example.invalid');

      const promptId = await waitForStrip(shell, 'external-protocol');
      // Nobody asks, so no site is named; the app's name depends on this machine.
      await expect(stripSentence(shell)).toHaveText(
        /^Open (this “mailto:” link in another app|.+)\?$/,
      );
      await expect(stripSentence(shell)).not.toContainText('127.0.0.1');
      expect(await promptOf(shell, tab.tabId)).toMatchObject({
        id: promptId,
        kind: 'external-protocol',
        site: null,
        scheme: 'mailto',
        canRemember: false,
      });
      await expect(alwaysAllowBox(shell)).toHaveCount(0);
      expect(await externalLaunches(electronApp)).toEqual([]);
      expect(fixtureServer.pathHits('/search')).toBe(searchesBefore);

      await clickYes(shell, 'Open');

      await expect
        .poll(() => externalLaunches(electronApp))
        .toEqual(['mailto:someone@example.invalid']);
      await expectNoStrip(shell);
      // Never searched for.
      expect(fixtureServer.pathHits('/search')).toBe(searchesBefore);
    });

    test('mailto: with "Cancel" launches nothing', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

      await typeAddress(shell, 'mailto:someone@example.invalid');
      await waitForStrip(shell, 'external-protocol');
      await clickNow(shell, 'Cancel');

      await expectNoStrip(shell);
      await expectNoLaunch(electronApp, 'Cancel must not launch anything');
    });
  });

  test.describe('other routes to another app', () => {
    test('window.open("veltriva-test:popup") with a gesture asks, and opens no window', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));
      const tabsBefore = (await tabStates(electronApp)).length;

      await clickElement(electronApp, tab.webContentsId, '#open-window');

      await waitForStrip(shell, 'external-protocol');
      await expect(stripSentence(shell)).toContainText(new URL(fixtureServer.origin).host);
      expect(await promptOf(shell, tab.tabId)).toMatchObject({ scheme: 'veltriva-test' });
      // No window of any kind: the page was told no.
      await expect
        .poll(() => evaluateInTab(electronApp, tab.webContentsId, 'externalFixture.openResult'))
        .toBe('null');
      expect(await popupWindows(electronApp)).toEqual([]);
      expect(await allWindows(electronApp)).toHaveLength(1);
      expect((await tabStates(electronApp)).length).toBe(tabsBefore);
      expect(await externalLaunches(electronApp)).toEqual([]);

      await clickYes(shell, 'Open');

      await expect.poll(() => externalLaunches(electronApp)).toEqual(['veltriva-test:popup']);
      expect(await popupWindows(electronApp)).toEqual([]);
      expect((await tabStates(electronApp)).length).toBe(tabsBefore);
    });

    test('a link that redirects to another app asks, and launches after "Open"', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const redirectsBefore = fixtureServer.hits('/redirect-external');
      const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

      await clickElement(electronApp, tab.webContentsId, '#link-redirect');

      await waitForStrip(shell, 'external-protocol');
      expect(await promptOf(shell, tab.tabId)).toMatchObject({
        kind: 'external-protocol',
        scheme: 'veltriva-test',
      });
      expect(fixtureServer.hits('/redirect-external')).toBe(redirectsBefore + 1);
      expect(await externalLaunches(electronApp)).toEqual([]);

      await clickYes(shell, 'Open');

      await expect.poll(() => externalLaunches(electronApp)).toEqual(['veltriva-test:redirected']);
      // The tab is still on the page with the link.
      expect((await tabState(electronApp, tab.tabId))?.url).toBe(
        fixtureServer.url('/external-links.html'),
      );
    });
  });

  test('the URL is escaped before it is launched: veltriva-test:a b"c becomes veltriva-test:a%20b%22c', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/external-links.html'));

    await clickElement(electronApp, tab.webContentsId, '#link-escape');
    await waitForStrip(shell, 'external-protocol');
    await clickYes(shell, 'Open');

    await expect.poll(() => externalLaunches(electronApp)).toEqual(['veltriva-test:a%20b%22c']);
    // Nothing else was ever shown for it.
    await expect(stripOfKind(shell, 'blocked-popups')).toHaveCount(0);
  });
});
