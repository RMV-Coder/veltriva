// About and the update notice (M6.3, assessment §7.2 Release, ADR-0007 items 4 and 8).
//
// The update check must stay silent until the user turns it on, so these specs point the feed at
// the local fixture server (`/release-feed`, which answers in GitHub's release format) and count
// its hits. A release page is an https address: `releases.test` is mapped to the HTTPS fixture
// server, whose throwaway certificate is trusted for this spec only.
import type { Page } from '@playwright/test';

import { createServerIdentity } from '../fixtures/certificate';
import { startHttpsFixtureServer } from '../fixtures/https-server';
import type { HttpsFixtureServer } from '../fixtures/https-server';
import { expect } from './expect';
import { test } from './fixtures';
import { tabState } from './hooks';
import type { PageGlobal } from './page-globals';
import { SLOW_TIMEOUT_MS, internalPage, mainIds, openTabAt, tabElements } from './shell-ui';

const identity = createServerIdentity();

test.use({
  appSwitches: [
    `--ignore-certificate-errors-spki-list=${identity.spkiSha256}`,
    '--host-resolver-rules=MAP releases.test 127.0.0.1',
  ],
});

/** Sends the shell's own settings change, as the Settings page does. */
async function changeUpdates(
  shell: Page,
  updates: { check?: boolean; feedUrl?: string },
): Promise<boolean> {
  return shell.evaluate(
    async (change) =>
      (await (globalThis as PageGlobal).veltriva.settings.update({ updates: change })).ok,
    updates,
  );
}

function noticeStrip(shell: Page) {
  return shell.locator('[data-notice-kind="update-available"]');
}

test.describe('About (M6.3)', () => {
  test('shows the versions, the MIT license and every third-party notice', async ({
    electronApp,
    shell,
  }) => {
    await openTabAt(shell, 'veltriva://about');
    const about = internalPage(shell, 'about');
    await expect(about).toHaveAttribute('data-about-state', 'ready', { timeout: SLOW_TIMEOUT_MS });

    const versions = await electronApp.evaluate(({ app }) => ({
      veltriva: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    }));
    for (const [name, version] of [
      ['Veltriva Browser', versions.veltriva],
      ['Electron', versions.electron],
      ['Chromium', versions.chrome],
      ['Node.js', versions.node],
      ['V8', versions.v8],
    ] as const) {
      await expect(about.locator(`[data-version-of="${name}"]`)).toHaveText(version);
    }
    await expect(about.locator('[data-about-license]')).toContainText('MIT License');
    await about.locator('summary', { hasText: 'Third-party notices' }).click();
    const notices = about.locator('[data-about-notices]');
    await expect(notices).toContainText('THIRD-PARTY SOFTWARE NOTICES');
    await expect(notices).toContainText(`electron ${versions.electron}`);
    await expect(notices).toContainText('react 19.3.1');
    // The tab is named for the page.
    await expect(tabElements(shell).last()).toHaveAccessibleName('About Veltriva');
  });

  test('is one page: opening it again selects its tab', async ({ electronApp, shell }) => {
    await openTabAt(shell, 'veltriva://about');
    await expect(internalPage(shell, 'about')).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
    const before = (await mainIds(electronApp)).length;
    await shell.evaluate(() => (globalThis as PageGlobal).veltriva.app.openAbout());
    expect((await mainIds(electronApp)).length).toBe(before);
  });
});

test.describe('the update notice (M6.3)', () => {
  let releases: HttpsFixtureServer;
  test.beforeEach(async () => {
    releases = await startHttpsFixtureServer({ identity });
  });
  test.afterEach(async () => {
    await releases.close();
  });

  /** The feed on the fixture server, naming `tag` with its page on `releases.test`. */
  const feedFor = (origin: string, tag: string, port: string): string =>
    `${origin}/release-feed?tag=${tag}&page=${encodeURIComponent(
      `https://releases.test:${port}/release/${tag}`,
    )}`;

  test('is off by default, and nothing is asked while it is off, not even "Check now"', async ({
    fixtureServer,
    shell,
  }) => {
    const settings = await shell.evaluate(() => (globalThis as PageGlobal).veltriva.settings.get());
    expect(settings.ok && settings.value.settings.updates.check).toBe(false);

    const port = new URL(releases.origin).port;
    expect(
      await changeUpdates(shell, { feedUrl: feedFor(fixtureServer.origin, 'v99.0.0', port) }),
    ).toBe(true);
    const answer = await shell.evaluate(() => (globalThis as PageGlobal).veltriva.updates.check());
    expect(answer).toMatchObject({ ok: true, value: { enabled: false, lastCheckedAt: null } });
    expect(fixtureServer.pathHits('/release-feed')).toBe(0);

    // About says so, and offers no check.
    await openTabAt(shell, 'veltriva://about');
    const about = internalPage(shell, 'about');
    await expect(about.locator('[data-about-updates]')).toHaveText(
      'Off. Veltriva never contacts the release feed while this is off.',
      { timeout: SLOW_TIMEOUT_MS },
    );
    await expect(about.locator('[data-about-check]')).toHaveCount(0);
    expect(fixtureServer.pathHits('/release-feed')).toBe(0);
  });

  test('turned on, "Check now" finds a newer version; the notice opens its page, and a skipped version stays away', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const port = new URL(releases.origin).port;
    expect(
      await changeUpdates(shell, {
        check: true,
        feedUrl: feedFor(fixtureServer.origin, 'v99.0.0', port),
      }),
    ).toBe(true);

    await shell.locator('[data-settings-button]').click();
    const settings = internalPage(shell, 'settings');
    await expect(settings.locator('[data-setting="update-check"]')).toBeChecked({
      timeout: SLOW_TIMEOUT_MS,
    });
    await settings.locator('[data-setting="check-now"]').click();
    await expect(settings.locator('[data-update-status]')).toHaveText(
      /^Veltriva 99\.0\.0 is available\. You have /,
      { timeout: SLOW_TIMEOUT_MS },
    );
    expect(fixtureServer.pathHits('/release-feed')).toBe(1);

    const strip = noticeStrip(shell);
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('Veltriva 99.0.0 is available.');

    // "View release" opens the page main read from the feed, in a new tab.
    const before = await mainIds(electronApp);
    await strip.locator('[data-notice-action="view-release"]').click();
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(before.length + 1);
    const opened = (await mainIds(electronApp)).find((id) => !before.includes(id)) ?? '';
    await expect
      .poll(async () => (await tabState(electronApp, opened))?.url, { timeout: SLOW_TIMEOUT_MS })
      .toBe(`https://releases.test:${port}/release/v99.0.0`);
    expect(releases.requests().map((request) => request.url)).toContain('/release/v99.0.0');

    // Skip it: the notice goes, and the next check doesn't bring it back.
    await strip.locator('[data-notice-action="skip-version"]').click();
    await expect(strip).toHaveCount(0);
    await shell.evaluate(() => (globalThis as PageGlobal).veltriva.updates.check());
    expect(fixtureServer.pathHits('/release-feed')).toBe(2);
    await expect(strip).toHaveCount(0);
  });

  test('main refuses a feed that is not https (or http to this machine)', async ({ shell }) => {
    for (const feedUrl of [
      'http://example.invalid/feed',
      'file:///C:/feed.json',
      'https://user:pass@example.invalid/feed',
    ]) {
      expect(await changeUpdates(shell, { feedUrl })).toBe(false);
    }
  });

  test('an unreadable answer is a failed check, with no notice', async ({
    fixtureServer,
    shell,
  }) => {
    expect(
      await changeUpdates(shell, {
        check: true,
        feedUrl: `${fixtureServer.origin}/release-feed?tag=latest`,
      }),
    ).toBe(true);
    const answer = await shell.evaluate(() => (globalThis as PageGlobal).veltriva.updates.check());
    expect(answer).toMatchObject({ ok: true, value: { lastStatus: 'failed', available: null } });
    await expect(noticeStrip(shell)).toHaveCount(0);
  });
});
