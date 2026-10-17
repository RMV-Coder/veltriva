// Certificate errors and client certificates, M1.4b (ADR-0002 item 10; src/core/net/error-pages.ts,
// the pages in src/renderer/features/pages). Electron's default is to reject a certificate it cannot
// trust, and Veltriva keeps that: a failed load with a certificate error (-200 to -299) shows its own
// page, with no way to continue to the site anyway. A site that asks for a client certificate gets
// none, because Veltriva always declines to choose one, and the failure shows a page saying so.
//
// The server is tests/fixtures/https-server.ts: TLS on 127.0.0.1 with a throwaway identity made by
// tests/fixtures/certificate.ts at test time. It never writes a key anywhere. A refused certificate
// stops at the handshake, so the server's `requestsServed()` stays 0: nothing was sent to it.
//
// The client-certificate page cannot be reached with an untrusted server, because the certificate
// error comes first (the first test of that describe shows it). So the page is reached for real,
// with the one change to the browser that makes it possible: the app starts with
// `--ignore-certificate-errors-spki-list=<hash of this run's throwaway public key>`, which makes
// Chromium trust that single key and nothing else, so the TLS handshake gets as far as the server
// asking for a client certificate. No snapshot is faked. (The server's refusal can lose a race with
// its own close, and then Chromium reports a dropped connection, which the network-error page rightly
// shows. `untilClientCertificatePage` reconnects until the refusal is read first.)
import { X509Certificate } from 'node:crypto';
import { connect } from 'node:tls';

import type { ElectronApplication, Page } from '@playwright/test';

import { createServerIdentity } from '../fixtures/certificate';
import { startHttpsFixtureServer } from '../fixtures/https-server';
import type { HttpsFixtureServer, HttpsFixtureOptions } from '../fixtures/https-server';
import { expect } from './expect';
import { test } from './fixtures';
import { clickElement, setSearchTemplate, tabState } from './hooks';
import {
  expectConsistent,
  internalPage,
  loadTab,
  openNewTab,
  sidebarTabs,
  tabElements,
  typeAddress,
  waitForLoaded,
  waitForPage,
} from './shell-ui';
import type { InternalPageName } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** Runs `body` against an HTTPS server with a fresh identity, and closes the server afterwards. */
async function withSecureServer(
  options: Omit<HttpsFixtureOptions, 'identity'>,
  body: (server: HttpsFixtureServer) => Promise<void>,
): Promise<void> {
  const server = await startHttpsFixtureServer({
    identity: createServerIdentity(),
    ...(options.requireClientCertificate === undefined
      ? {}
      : { requireClientCertificate: options.requireClientCertificate }),
  });
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

/** The buttons of the page, by name. These pages have two at most and no links. */
async function pageButtons(shell: Page, name: InternalPageName): Promise<string[]> {
  return internalPage(shell, name)
    .getByRole('button')
    .evaluateAll((buttons: { textContent: string | null }[]) =>
      buttons.map((button) => button.textContent ?? ''),
    );
}

/** Checks the page offers only "Try again" and, when asked, "Go back": no way past the error. */
async function expectNoWayToProceed(shell: Page, name: InternalPageName): Promise<void> {
  const page = internalPage(shell, name);
  await expect(page.getByRole('link'), 'no links on the page').toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /proceed|continue|advanced|unsafe|accept|visit|ignore|anyway/i,
    }),
    'no button that goes on to the site',
  ).toHaveCount(0);
  await expect(
    page.getByText(/proceed|continue to|advanced|unsafe|accept the risk|anyway/i),
    'no text that offers to go on',
  ).toHaveCount(0);
}

async function tabStatus(shell: Page, tabId: string): Promise<string | null> {
  return (await sidebarTabs(shell)).find((tab) => tab.id === tabId)?.status ?? null;
}

test.describe('the HTTPS fixture', () => {
  test('makes certificates that are what the specs say: well-formed, self-signed, and untrusted', async () => {
    const identity = createServerIdentity();
    const certificate = new X509Certificate(identity.cert);
    expect(certificate.verify(certificate.publicKey), 'signed by its own key').toBe(true);
    expect(certificate.issuer, 'issuer and subject are the same').toBe(certificate.subject);
    expect(identity.spkiSha256, 'a SHA-256 in base64').toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(identity.key).toContain('PRIVATE KEY');
    expect(Boolean(certificate.checkIP('127.0.0.1')), 'made for 127.0.0.1').toBe(true);
    const now = Date.now();
    expect(Date.parse(certificate.validFrom), 'already valid').toBeLessThan(now);
    expect(Date.parse(certificate.validTo), 'not yet expired').toBeGreaterThan(now);

    // A client that checks, as a browser does, refuses it.
    await withSecureServer({}, async (server) => {
      const port = Number(new URL(server.origin).port);
      const failure = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: true }, () => {
          socket.destroy();
          reject(new Error('the self-signed certificate was accepted'));
        });
        socket.once('error', (error: NodeJS.ErrnoException) => {
          resolve(error);
        });
      });
      expect(failure.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    });
  });
});

test.describe('the certificate-error page', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('a self-signed certificate typed into the address bar shows the page with ERR_CERT_AUTHORITY_INVALID, and no way on', async ({
    electronApp,
    shell,
  }) => {
    await withSecureServer({}, async (server) => {
      const tabId = await openNewTab(shell);
      await typeAddress(shell, server.url('/'));

      const page = internalPage(shell, 'certificate-error');
      await expect(page).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        "Your connection to this site isn't private",
      );
      await expect(page).toContainText(new URL(server.origin).host);
      await expect(page).toContainText('ERR_CERT_AUTHORITY_INVALID');
      await expect(page).toContainText(/won't open this site until the problem is fixed/);
      await expectNoWayToProceed(shell, 'certificate-error');

      // A tab with no history has nowhere to go back to: only "Try again".
      expect(await pageButtons(shell, 'certificate-error')).toEqual(['Try again']);

      // What main holds: an internal page with the net error, and the failed address.
      await expect
        .poll(async () => (await tabState(electronApp, tabId))?.page)
        .toEqual({
          kind: 'internal',
          name: 'certificate-error',
          error: { code: -202, name: 'ERR_CERT_AUTHORITY_INVALID' },
        });
      const state = await tabState(electronApp, tabId);
      expect(state?.url).toBe(server.url('/'));
      expect(state?.loading).toBe(false);
      expect(state?.canGoBack).toBe(false);
      // The sidebar marks the tab as failed, and no web view covers the page.
      await expect.poll(() => tabStatus(shell, tabId)).toBe('failed');
      await expectConsistent(electronApp, shell);

      // The browser stopped at the handshake: not one request reached the server.
      expect(server.handshakeFailures()).toBeGreaterThanOrEqual(1);
      expect(server.requestsServed()).toBe(0);
    });
  });

  test('"Try again" tries the connection again and shows the error again', async ({
    electronApp,
    shell,
  }) => {
    await withSecureServer({}, async (server) => {
      const tabId = await openNewTab(shell);
      await typeAddress(shell, server.url('/'));
      const page = internalPage(shell, 'certificate-error');
      await expect(page).toBeVisible({ timeout: 30_000 });
      const failuresBefore = server.handshakeFailures();

      await page.getByRole('button', { name: 'Try again', exact: true }).click();

      // A new connection attempt reached the server, and was refused again.
      await expect
        .poll(() => server.handshakeFailures(), { message: 'Try again should reconnect' })
        .toBeGreaterThan(failuresBefore);
      await expect(page).toBeVisible();
      await expect(page).toContainText('ERR_CERT_AUTHORITY_INVALID');
      await expect.poll(() => tabStatus(shell, tabId)).toBe('failed');
      expect(server.requestsServed()).toBe(0);
      expect((await tabState(electronApp, tabId))?.page).toMatchObject({
        kind: 'internal',
        name: 'certificate-error',
      });
    });
  });

  test('"Go back" returns to the page before, and is not there when there is none', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    await withSecureServer({}, async (server) => {
      const previous = fixtureServer.url('/page-a.html?case=cert-back');
      const tab = await loadTab(electronApp, shell, previous);

      await typeAddress(shell, server.url('/'));
      const page = internalPage(shell, 'certificate-error');
      await expect(page).toBeVisible({ timeout: 30_000 });
      expect(await pageButtons(shell, 'certificate-error')).toEqual(['Try again', 'Go back']);
      expect((await tabState(electronApp, tab.tabId))?.canGoBack).toBe(true);

      await page.getByRole('button', { name: 'Go back', exact: true }).click();

      await waitForPage(electronApp, tab.tabId, { url: previous, title: 'Page A' });
      await expect(page).toHaveCount(0);
      await expect.poll(() => tabStatus(shell, tab.tabId)).toBeNull();
      await expectConsistent(electronApp, shell);
      expect(server.requestsServed()).toBe(0);
    });
  });

  test('a link on a page to the HTTPS fixture shows the same page, and Go back returns to that page', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    await withSecureServer({}, async (server) => {
      const linkPage = fixtureServer.url(
        `/https-link.html?to=${encodeURIComponent(server.url('/'))}`,
      );
      const tab = await loadTab(electronApp, shell, linkPage);

      await clickElement(electronApp, tab.webContentsId, '#secure-link');

      const page = internalPage(shell, 'certificate-error');
      await expect(page).toBeVisible({ timeout: 30_000 });
      await expect(page).toContainText('ERR_CERT_AUTHORITY_INVALID');
      await expectNoWayToProceed(shell, 'certificate-error');
      expect(await pageButtons(shell, 'certificate-error')).toEqual(['Try again', 'Go back']);
      await expect.poll(() => tabStatus(shell, tab.tabId)).toBe('failed');
      expect(server.requestsServed()).toBe(0);

      await page.getByRole('button', { name: 'Go back', exact: true }).click();
      await waitForPage(electronApp, tab.tabId, { url: linkPage });
    });
  });
});

/**
 * Runs `start` (typing the address, or "Try again") and waits for the client-certificate page.
 *
 * The server refuses a client that has no certificate by ending the handshake with an alert and
 * closing the socket, and Chromium may read the close before the alert. Then it reports
 * ERR_CONNECTION_ABORTED, and the generic network-error page is the right answer to that: it is
 * the product behaving correctly, not a flaw of the page under test. So when that happens this
 * reconnects with "Try again" (the same button on either page) until the alert is read first.
 * Every refused attempt must still be an honest network error. Returns how many attempts it took.
 */
async function untilClientCertificatePage(
  app: ElectronApplication,
  shell: Page,
  tabId: string,
  server: HttpsFixtureServer,
  start: () => Promise<void>,
): Promise<number> {
  const attempts = 12;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const refusedBefore = server.handshakeFailures();
    if (attempt === 1) {
      await start();
    } else {
      await shell.getByRole('button', { name: 'Try again', exact: true }).click();
    }
    // This attempt is over once the server saw a refused handshake and the tab stopped loading.
    const outcome = { page: '' };
    await expect
      .poll(
        async () => {
          const state = await tabState(app, tabId);
          const over = state?.loading === false && server.handshakeFailures() > refusedBefore;
          outcome.page = over && state.page.kind === 'internal' ? state.page.name : '';
          return outcome.page;
        },
        { message: `attempt ${String(attempt)} should end in an error page`, timeout: 30_000 },
      )
      .not.toBe('');
    if (outcome.page === 'client-certificate') {
      return attempt;
    }
    expect(outcome.page, 'a dropped connection is a plain network error').toBe('network-error');
  }
  throw new Error(`no client-certificate page in ${String(attempts)} attempts`);
}

test.describe('the client-certificate page', () => {
  test('a server that wants a certificate and has an untrusted one shows the certificate error first', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await withSecureServer({ requireClientCertificate: true }, async (server) => {
      const tabId = await openNewTab(shell);
      await typeAddress(shell, server.url('/'));

      // Which is why the client-certificate page cannot be reached with a self-signed server.
      await expect(internalPage(shell, 'certificate-error')).toBeVisible({ timeout: 30_000 });
      await expect(internalPage(shell, 'client-certificate')).toHaveCount(0);
      expect((await tabState(electronApp, tabId))?.page).toMatchObject({
        name: 'certificate-error',
      });
    });
  });

  test.describe('with the one throwaway key trusted', () => {
    // The key made for this run, trusted by hash. Both the switch and the server use it, so they
    // agree whichever process builds the test list. It is never written anywhere.
    const trusted = createServerIdentity();
    test.use({ appSwitches: [`--ignore-certificate-errors-spki-list=${trusted.spkiSha256}`] });

    test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
      await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
      await expect(tabElements(shell)).toHaveCount(1);
    });

    async function serve(
      requireClientCertificate: boolean,
      body: (server: HttpsFixtureServer) => Promise<void>,
    ): Promise<void> {
      const server = await startHttpsFixtureServer({
        identity: trusted,
        requireClientCertificate,
      });
      try {
        await body(server);
      } finally {
        await server.close();
      }
    }

    test('control: the trusted key is trusted, so a server that asks for nothing loads', async ({
      electronApp,
      shell,
    }) => {
      await serve(false, async (server) => {
        const tab = await loadTab(electronApp, shell, server.url('/'));
        await waitForLoaded(electronApp, tab.tabId);
        expect((await tabState(electronApp, tab.tabId))?.title).toBe('Secure fixture');
        await expect(internalPage(shell, 'certificate-error')).toHaveCount(0);
        expect(server.requestsServed()).toBeGreaterThanOrEqual(1);
      });
    });

    test('a site that needs a certificate shows the page, with its error name and no way on', async ({
      electronApp,
      shell,
    }) => {
      await serve(true, async (server) => {
        const tabId = await openNewTab(shell);
        const attempts = await untilClientCertificatePage(electronApp, shell, tabId, server, () =>
          typeAddress(shell, server.url('/')),
        );
        test
          .info()
          .annotations.push({ type: 'client-certificate attempts', description: String(attempts) });

        const page = internalPage(shell, 'client-certificate');
        await expect(page).toBeVisible();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          'This site needs a certificate to sign in',
        );
        await expect(page).toContainText(new URL(server.origin).host);
        await expect(page).toContainText(
          /ERR_(SSL_CLIENT_AUTH_CERT_NEEDED|BAD_SSL_CLIENT_AUTH_CERT|SSL_CLIENT_AUTH_CERT_NO_PRIVATE_KEY)/,
        );
        await expectNoWayToProceed(shell, 'client-certificate');
        expect(await pageButtons(shell, 'client-certificate')).toEqual(['Try again']);

        const state = await tabState(electronApp, tabId);
        expect(state?.page).toMatchObject({ kind: 'internal', name: 'client-certificate' });
        const error = state?.page.kind === 'internal' ? state.page.error : undefined;
        expect([-110, -117, -134]).toContain(error?.code);
        // Which of the three Chromium reports, for the milestone report.
        test.info().annotations.push({
          type: 'client-certificate-error',
          description: `${String(error?.code)} ${error?.name ?? ''}`,
        });
        await expect.poll(() => tabStatus(shell, tabId)).toBe('failed');
        await expectConsistent(electronApp, shell);
        // Veltriva sent no certificate, so the server never served a request.
        expect(server.requestsServed()).toBe(0);
      });
    });

    test('"Try again" asks the site again and gets the same page; "Go back" is there when there is a page before', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      await serve(true, async (server) => {
        const previous = fixtureServer.url('/page-a.html?case=client-cert-back');
        const tab = await loadTab(electronApp, shell, previous);
        await untilClientCertificatePage(electronApp, shell, tab.tabId, server, () =>
          typeAddress(shell, server.url('/')),
        );
        const page = internalPage(shell, 'client-certificate');
        await expect(page).toBeVisible();
        expect(await pageButtons(shell, 'client-certificate')).toEqual(['Try again', 'Go back']);

        // "Try again" asks the site again; the answer is the same page (or, when the server's
        // close wins the race, a dropped connection, until the alert is read first).
        await untilClientCertificatePage(electronApp, shell, tab.tabId, server, () =>
          page.getByRole('button', { name: 'Try again', exact: true }).click(),
        );
        await expect(page).toBeVisible();
        await expect.poll(() => tabStatus(shell, tab.tabId)).toBe('failed');

        await page.getByRole('button', { name: 'Go back', exact: true }).click();
        await waitForPage(electronApp, tab.tabId, { url: previous, title: 'Page A' });
      });
    });
  });
});
