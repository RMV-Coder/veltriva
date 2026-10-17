// HTTP authentication, M1.4b (ADR-0002 item 10; src/main/auth/sign-in.ts, the form in
// src/renderer/features/prompts/PromptStrip.tsx). Electron cancels a `401` unless the app answers
// the `login` event. Veltriva asks in the toolbar's strip, outside the page area (threat T6),
// naming the server from main's own parse of the URL, and hands what the user typed to Chromium
// once: it is never stored, logged or shown again.
//
// The server is the fixture server's `/auth/page` (tests/fixtures/auth-routes.ts): it answers 401
// with `WWW-Authenticate: Basic realm="…"` until a request carries the one known username and
// password, and it records every request's headers. The fixture server is shared by all specs of a
// worker, so each test uses its own `?case=` and reads only the requests carrying it.
//
// A yes ("Sign in") counts only 500 ms after the strip was shown, so `clickYes` waits.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { Page } from '@playwright/test';

import {
  AUTH_OK_TITLE,
  AUTH_PASSWORD,
  AUTH_REFUSED_TEXT,
  AUTH_REFUSED_TITLE,
  AUTH_USERNAME,
  AUTH_WRONG_PASSWORD,
  basicAuthorization,
} from '../fixtures/auth-routes';
import type { FixtureServer, RecordedRequest } from '../fixtures/server';
import { expect } from './expect';
import { test } from './fixtures';
import {
  evaluateInTab,
  focusWebContents,
  focusedWebContents,
  recordMainWarnings,
  sendKey,
  setSearchTemplate,
  tabState,
} from './hooks';
import {
  clickNow,
  clickYes,
  expectNoStrip,
  expectNoStripFor,
  passwordField,
  promptOf,
  promptStrip,
  signInRealm,
  stripButton,
  stripSentence,
  usernameField,
  waitForStrip,
  waitForStripAfter,
  workspaceSnapshot,
} from './prompt-ui';
import { loadTab, openNewTab, tabElements, typeAddress, waitForPage } from './shell-ui';
import type { TabId } from './hooks';

test.describe.configure({ timeout: 120_000 });

interface Protected {
  readonly caseId: string;
  readonly url: string;
}

/** A URL of the protected page that only this test's requests carry. */
function protectedPage(server: FixtureServer, realm?: string): Protected {
  const caseId = randomUUID();
  const query = new URLSearchParams({ case: caseId });
  if (realm !== undefined) {
    query.set('realm', realm);
  }
  return { caseId, url: server.url(`/auth/page?${query.toString()}`) };
}

/** The requests the server got for one test's protected page, oldest first. */
function requestsFor(server: FixtureServer, caseId: string): readonly RecordedRequest[] {
  return server.requestsTo('/auth/page').filter((request) => request.url.includes(caseId));
}

function authorizations(requests: readonly RecordedRequest[]): (string | string[] | undefined)[] {
  return requests.map((request) => request.headers.authorization);
}

/** Opens a new tab and types the address, which draws the 401. Returns the tab's id. */
async function visit(shell: Page, url: string): Promise<TabId> {
  const tabId = await openNewTab(shell);
  await typeAddress(shell, url);
  return tabId;
}

async function fillForm(shell: Page, username: string, password: string): Promise<void> {
  await usernameField(shell).fill(username);
  await passwordField(shell).fill(password);
}

test.describe('HTTP sign-in', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('the strip asks "… wants you to sign in" with the server\'s realm, and the right password loads the page', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const host = new URL(fixtureServer.origin).host;
    const page = protectedPage(fixtureServer, 'Staff area');
    const tabId = await visit(shell, page.url);

    const promptId = await waitForStrip(shell, 'http-auth');
    await expect(stripSentence(shell)).toContainText(`${host} wants you to sign in`);
    await expect(signInRealm(shell)).toHaveText('The server says: “Staff area”');
    expect(await promptOf(shell, tabId)).toEqual({
      id: promptId,
      kind: 'http-auth',
      site: host,
      realm: 'Staff area',
      secure: true,
    });
    // The region has a name, the fields are labelled, the password is hidden, and a plain address
    // on this machine gets no unencrypted-password warning.
    await expect(shell.getByRole('region', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(usernameField(shell)).toBeVisible();
    await expect(passwordField(shell)).toHaveAttribute('type', 'password');
    await expect(stripButton(shell, 'Sign in')).toBeVisible();
    await expect(stripButton(shell, 'Cancel')).toBeVisible();
    await expect(stripButton(shell, 'Dismiss')).toBeVisible();
    await expect(promptStrip(shell).locator('[data-sign-in-warning]')).toHaveCount(0);
    // Nothing was sent yet but the first, unauthenticated request.
    expect(authorizations(requestsFor(fixtureServer, page.caseId))).toEqual([undefined]);

    await fillForm(shell, AUTH_USERNAME, AUTH_PASSWORD);
    await clickYes(shell, 'Sign in');

    await waitForPage(electronApp, tabId, { url: page.url, title: AUTH_OK_TITLE });
    await expectNoStrip(shell, 'signing in should close the strip');
    // The server saw the right header, and the address never carried the credentials.
    expect(authorizations(requestsFor(fixtureServer, page.caseId))).toEqual([
      undefined,
      basicAuthorization(AUTH_USERNAME, AUTH_PASSWORD),
    ]);
    expect((await tabState(electronApp, tabId))?.url).toBe(page.url);
    expect(await promptOf(shell, tabId)).toBeNull();
  });

  test('Enter in the password field signs in too', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const page = protectedPage(fixtureServer);
    const tabId = await visit(shell, page.url);
    await waitForStrip(shell, 'http-auth');
    await fillForm(shell, AUTH_USERNAME, AUTH_PASSWORD);

    // Enter counts like the button: after the 500 ms.
    await delay(700);
    await passwordField(shell).press('Enter');

    await waitForPage(electronApp, tabId, { url: page.url, title: AUTH_OK_TITLE });
    expect(authorizations(requestsFor(fixtureServer, page.caseId)).at(-1)).toBe(
      basicAuthorization(AUTH_USERNAME, AUTH_PASSWORD),
    );
  });

  test('a wrong password asks again with empty fields, and the right one then works', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const host = new URL(fixtureServer.origin).host;
    const page = protectedPage(fixtureServer, 'Staff area');
    const tabId = await visit(shell, page.url);
    const first = await waitForStrip(shell, 'http-auth');

    await fillForm(shell, AUTH_USERNAME, AUTH_WRONG_PASSWORD);
    await clickYes(shell, 'Sign in');

    // The server refused: a new question, with nothing left in the fields.
    const second = await waitForStripAfter(shell, 'http-auth', first);
    expect(second).not.toBe(first);
    await expect(usernameField(shell)).toHaveValue('');
    await expect(passwordField(shell)).toHaveValue('');
    await expect(stripSentence(shell)).toContainText(`${host} wants you to sign in`);
    await expect(signInRealm(shell)).toHaveText('The server says: “Staff area”');
    expect((await promptOf(shell, tabId))?.id).toBe(second);

    await fillForm(shell, AUTH_USERNAME, AUTH_PASSWORD);
    await clickYes(shell, 'Sign in');

    await waitForPage(electronApp, tabId, { url: page.url, title: AUTH_OK_TITLE });
    expect(authorizations(requestsFor(fixtureServer, page.caseId))).toEqual([
      undefined,
      basicAuthorization(AUTH_USERNAME, AUTH_WRONG_PASSWORD),
      basicAuthorization(AUTH_USERNAME, AUTH_PASSWORD),
    ]);
  });

  for (const refusal of ['Cancel', 'Dismiss'] as const) {
    test(`"${refusal}" shows the server's own 401 page and sends no credentials`, async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const page = protectedPage(fixtureServer);
      const tabId = await visit(shell, page.url);
      await waitForStrip(shell, 'http-auth');
      // Typed text is not sent when the user refuses.
      await fillForm(shell, AUTH_USERNAME, AUTH_PASSWORD);

      await clickNow(shell, refusal);

      await waitForPage(electronApp, tabId, { url: page.url, title: AUTH_REFUSED_TITLE });
      await expectNoStripFor(shell, tabId, 1_000, `${refusal} must not ask again`);
      expect(
        await evaluateInTab(
          electronApp,
          (await tabState(electronApp, tabId))?.webContentsId ?? -1,
          'document.body.innerText',
        ),
      ).toContain(AUTH_REFUSED_TEXT);
      expect(authorizations(requestsFor(fixtureServer, page.caseId))).toEqual([undefined]);
    });
  }

  test('three wrong tries stop the prompts; a fresh attempt asks again', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const warnings = await recordMainWarnings(electronApp);
    const page = protectedPage(fixtureServer);
    const tabId = await visit(shell, page.url);

    let previous: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      previous = await waitForStripAfter(shell, 'http-auth', previous);
      await fillForm(shell, AUTH_USERNAME, AUTH_WRONG_PASSWORD);
      await clickYes(shell, 'Sign in');
    }

    // The fourth refusal gets no question: the server's own 401 page is what the user sees.
    await waitForPage(electronApp, tabId, { url: page.url, title: AUTH_REFUSED_TITLE });
    await expectNoStripFor(shell, tabId, 2_000, 'a server that refused three tries gets no more');
    await expect
      .poll(async () => (await warnings.all()).map((warning) => warning.event))
      .toContain('auth.tooManyAttempts');
    expect(authorizations(requestsFor(fixtureServer, page.caseId))).toEqual([
      undefined,
      basicAuthorization(AUTH_USERNAME, AUTH_WRONG_PASSWORD),
      basicAuthorization(AUTH_USERNAME, AUTH_WRONG_PASSWORD),
      basicAuthorization(AUTH_USERNAME, AUTH_WRONG_PASSWORD),
    ]);

    // A fresh attempt (the user loads the address again) is a first attempt, and asks.
    await typeAddress(shell, page.url);
    await waitForStripAfter(shell, 'http-auth', previous);
    await fillForm(shell, AUTH_USERNAME, AUTH_PASSWORD);
    await clickYes(shell, 'Sign in');
    await waitForPage(electronApp, tabId, { url: page.url, title: AUTH_OK_TITLE });
  });

  test('a navigation elsewhere takes the question with it', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const page = protectedPage(fixtureServer);
    const tabId = await visit(shell, page.url);
    await waitForStrip(shell, 'http-auth');

    const away = fixtureServer.url('/page-a.html?case=signin-away');
    await typeAddress(shell, away);

    await waitForPage(electronApp, tabId, { url: away, title: 'Page A' });
    await expectNoStrip(shell, 'the question belonged to the page that went away');
    expect(await promptOf(shell, tabId)).toBeNull();
  });

  test.describe('who may ask', () => {
    test('an image from another origin that answers 401 gets no strip and no password', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const caseId = randomUUID();
      // `localhost` is another origin than the page's `127.0.0.1`, on the same server.
      const image = fixtureServer.otherSiteUrl(`/auth/image.png?case=${caseId}`);
      const tab = await loadTab(
        electronApp,
        shell,
        fixtureServer.url(`/auth-subresource.html?img=${encodeURIComponent(image)}`),
      );

      // The image was asked for, refused with 401, and failed without a question.
      await expect
        .poll(() => evaluateInTab(electronApp, tab.webContentsId, 'authFixture.image'), {
          message: 'the image should have failed to load',
        })
        .toBe('failed');
      expect(
        fixtureServer
          .requestsTo('/auth/image.png')
          .filter((request) => request.url.includes(caseId)),
      ).toHaveLength(1);
      await expectNoStripFor(
        shell,
        tab.tabId,
        1_500,
        'a cross-origin image may not ask for a password',
      );
      expect(await promptOf(shell, tab.tabId)).toBeNull();
      // Measured: Chromium itself withholds a cross-origin subresource's prompt, so Electron's
      // `login` event never fires for it and main's own check (`auth.crossOriginRefused`) stays a
      // backstop this scenario does not reach. What the user sees is the same either way.
    });

    test('an iframe from another origin whose navigation answers 401 gets no strip', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const caseId = randomUUID();
      // Chromium flags an iframe's load as a navigation too; main still refuses it, because the
      // frame's origin is neither the page's nor the one its main frame is navigating to.
      const frame = fixtureServer.otherSiteUrl(`/auth/page?case=${caseId}`);
      const tab = await loadTab(
        electronApp,
        shell,
        fixtureServer.url(`/auth-subresource.html?frame=${encodeURIComponent(frame)}`),
      );
      await expect
        .poll(() =>
          fixtureServer.requestsTo('/auth/page').filter((request) => request.url.includes(caseId)),
        )
        .toHaveLength(1);
      await expectNoStripFor(
        shell,
        tab.tabId,
        1_500,
        'an iframe from another site may not ask for a password',
      );
      expect(await promptOf(shell, tab.tabId)).toBeNull();
      // No credentials were ever sent to it.
      expect(
        authorizations(
          fixtureServer.requestsTo('/auth/page').filter((request) => request.url.includes(caseId)),
        ).filter((value) => value !== undefined),
      ).toEqual([]);
    });

    test("an iframe from the page's own origin may ask", async ({ fixtureServer, shell }) => {
      const caseId = randomUUID();
      const frame = fixtureServer.url(`/auth/page?case=${caseId}`);
      await visit(
        shell,
        fixtureServer.url(`/auth-subresource.html?frame=${encodeURIComponent(frame)}`),
      );
      await waitForStrip(shell, 'http-auth');
    });

    test("an image from the page's own origin may ask, in the page's name", async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const host = new URL(fixtureServer.origin).host;
      const caseId = randomUUID();
      const image = fixtureServer.url(`/auth/image.png?case=${caseId}`);
      // Not `loadTab`: the page's load waits for the image, which waits for the password.
      const tabId = await visit(
        shell,
        fixtureServer.url(`/auth-subresource.html?img=${encodeURIComponent(image)}`),
      );

      await waitForStrip(shell, 'http-auth');
      await expect(stripSentence(shell)).toContainText(`${host} wants you to sign in`);
      await fillForm(shell, AUTH_USERNAME, AUTH_PASSWORD);
      await clickYes(shell, 'Sign in');

      const webContentsId = (await tabState(electronApp, tabId))?.webContentsId ?? -1;
      await expect
        .poll(() => evaluateInTab(electronApp, webContentsId, 'authFixture.image'))
        .toBe('loaded');
      const requests = fixtureServer
        .requestsTo('/auth/image.png')
        .filter((request) => request.url.includes(caseId));
      expect(authorizations(requests).at(-1)).toBe(
        basicAuthorization(AUTH_USERNAME, AUTH_PASSWORD),
      );
    });
  });

  test.describe("the realm is the server's text", () => {
    test('controls and invisible formatting are removed before it is shown', async ({
      fixtureServer,
      shell,
    }) => {
      // A right-to-left override, a soft hyphen (invisible) and a C1 control, inside a realm. The
      // server sends them as UTF-8, and Chromium reads a realm as Latin-1 (measured, for Basic and
      // Digest), so a real U+202E never arrives: its bytes come out as the mojibake "â", U+0080 and
      // "®". The U+0080, the soft hyphen U+00AD (format) and the U+0085 (control) are the Latin-1
      // characters this rule exists for, and they do arrive. The `bdi` below covers the rest.
      const hostile = 'Staff \u202Egpj.\u00ADarea\u0085 end';
      const page = protectedPage(fixtureServer, hostile);
      const tabId = await visit(shell, page.url);
      await waitForStrip(shell, 'http-auth');

      const prompt = await promptOf(shell, tabId);
      expect(prompt?.kind).toBe('http-auth');
      const realm = prompt?.kind === 'http-auth' ? prompt.realm : '';
      expect(realm, 'main sends the realm without controls or formatting').not.toMatch(
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u,
      );
      expect(realm).toContain('Staff');
      expect(realm).toContain('end');
      test.info().annotations.push({ type: 'realm shown', description: JSON.stringify(realm) });

      // What the strip draws is that text, and nothing in the line carries an override.
      const shown = (await signInRealm(shell).textContent()) ?? '';
      expect(shown).toContain('Staff');
      expect(shown.replace(/[“”]/g, '')).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      // It sits in a bdi with dir=ltr, so bidirectional text cannot reorder the words around it.
      await expect(signInRealm(shell).locator('bdi[dir="ltr"]')).toHaveCount(1);
    });

    test('a very long realm is cut short', async ({ fixtureServer, shell }) => {
      const page = protectedPage(fixtureServer, 'long '.repeat(80));
      const tabId = await visit(shell, page.url);
      await waitForStrip(shell, 'http-auth');

      const prompt = await promptOf(shell, tabId);
      const realm = prompt?.kind === 'http-auth' ? prompt.realm : '';
      expect(realm.length).toBeGreaterThan(0);
      expect(realm.length).toBeLessThanOrEqual(100);
    });
  });

  test("the password never appears in main's output or in any console", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // Everything main prints, and everything any page prints, from before the form shows.
    const captured: string[] = [];
    const take = (source: string, text: string): void => {
      captured.push(`${source}: ${text}`);
    };
    electronApp.on('console', (message) => {
      take('main console', message.text());
    });
    const child = electronApp.process();
    child.stdout?.on('data', (chunk: Buffer) => {
      take('main stdout', chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      take('main stderr', chunk.toString('utf8'));
    });
    const watchPage = (page: Page, source: string): void => {
      page.on('console', (message) => {
        take(source, message.text());
      });
      page.on('pageerror', (error) => {
        take(`${source} error`, error.message);
      });
    };
    watchPage(shell, 'shell console');
    electronApp.on('window', (page) => {
      watchPage(page, 'tab console');
    });
    const warnings = await recordMainWarnings(electronApp);

    // The capture works: a canary printed in main (console.log to stdout, console.error to stderr)
    // and in the shell is seen by every watcher below. Without this, silence would prove nothing.
    const canary = `canary-${randomUUID()}`;
    await electronApp.evaluate((_electron, text) => {
      console.log(text);
      console.error(text);
    }, canary);
    await shell.evaluate((text) => {
      console.log(text);
    }, canary);
    await expect
      .poll(
        () =>
          [
            ...new Set(
              captured
                .filter((line) => line.includes(canary))
                .map((line) => line.slice(0, line.indexOf(':'))),
            ),
          ].sort(),
        { message: 'the canary should reach every capture' },
      )
      .toEqual(['main console', 'main stderr', 'main stdout', 'shell console']);

    const page = protectedPage(fixtureServer);
    const tabId = await visit(shell, page.url);
    await waitForStrip(shell, 'http-auth');
    // A wrong try, then the right one: both secrets pass through the app.
    await fillForm(shell, AUTH_USERNAME, AUTH_WRONG_PASSWORD);
    // While it is typed, it lives in the form only.
    expect(JSON.stringify(await workspaceSnapshot(shell))).not.toContain(AUTH_WRONG_PASSWORD);
    const first = await promptOf(shell, tabId);
    await clickYes(shell, 'Sign in');
    await waitForStripAfter(shell, 'http-auth', first?.id ?? null);
    await fillForm(shell, AUTH_USERNAME, AUTH_PASSWORD);
    expect(JSON.stringify(await workspaceSnapshot(shell))).not.toContain(AUTH_PASSWORD);
    await clickYes(shell, 'Sign in');
    await waitForPage(electronApp, tabId, { url: page.url, title: AUTH_OK_TITLE });
    // Time for anything late to be printed.
    await delay(1_000);

    const everything = [...captured, JSON.stringify(await warnings.all())].join('\n');
    for (const secret of [AUTH_PASSWORD, AUTH_WRONG_PASSWORD]) {
      expect(everything, 'a password reached a log').not.toContain(secret);
    }
    // And once sent, the strip and the snapshot hold nothing: the form is gone.
    expect(JSON.stringify(await workspaceSnapshot(shell))).not.toContain(AUTH_PASSWORD);
    await expectNoStrip(shell);
  });

  test('when the strip shows, the shell has the keyboard and the username field has the focus', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=signin-focus'),
    );
    // The page has the keyboard, as it does for a user who was reading it.
    await focusWebContents(electronApp, tab.webContentsId);
    expect((await focusedWebContents(electronApp))?.webContentsId).toBe(tab.webContentsId);

    const page = protectedPage(fixtureServer);
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      `window.location.href = ${JSON.stringify(page.url)}`,
    );
    await waitForStrip(shell, 'http-auth');

    // Main moved the keyboard to the shell, and the form put it in the username field.
    await expect
      .poll(async () => (await focusedWebContents(electronApp))?.isShell, {
        message: 'the shell should have the keyboard',
      })
      .toBe(true);
    await expect(usernameField(shell)).toBeFocused();

    // Keys reach the field: what a user types lands there.
    await sendKey(electronApp, 'focused', 'a');
    await sendKey(electronApp, 'focused', 'b');
    await expect(usernameField(shell)).toHaveValue('ab');
    await sendKey(electronApp, 'focused', 'Tab');
    await expect(passwordField(shell)).toBeFocused();
  });
});
