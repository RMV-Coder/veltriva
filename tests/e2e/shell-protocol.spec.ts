// The app://shell protocol and the shell's Content Security Policy (ADR-0002, assessment §6.2).
// Everything here runs in the shell page, so it is subject to the same CSP as the real UI.
import { SHELL_URL } from '../../src/main/shell/assets';
import { SHELL_CSP } from '../../src/main/shell/csp';
import { expect, test } from './fixtures';
import type { PageGlobal } from './page-globals';

test.describe('app://shell protocol', () => {
  test('serves the shell at app://shell/index.html', ({ shell }) => {
    expect(SHELL_URL).toBe('app://shell/index.html');
    expect(shell.url()).toBe(SHELL_URL);
  });

  test('sends the exact CSP and nosniff on the shell page', async ({ shell }) => {
    // Fetched from the shell itself, so `connect-src 'self'` and the scheme's fetch support apply.
    const response = await shell.evaluate(async () => {
      const page = globalThis as PageGlobal;
      const fetched = await fetch(page.location.href);
      return {
        status: fetched.status,
        csp: fetched.headers.get('content-security-policy'),
        contentTypeOptions: fetched.headers.get('x-content-type-options'),
        body: await fetched.text(),
      };
    });

    expect(response.status).toBe(200);
    expect(response.csp).toBe(SHELL_CSP);
    expect(response.contentTypeOptions).toBe('nosniff');
    // It is the shell document, not an error page that happens to carry the headers.
    expect(response.body).toContain('<div id="root"></div>');
  });

  test('refuses eval', async ({ shell }) => {
    // `script-src 'self'` has no 'unsafe-eval', so eval throws EvalError. While Playwright's own
    // call is running, the inspector allows eval so that it can evaluate your function. So the
    // eval must run later, from a timer task, to be subject to the page's policy.
    const outcome = await shell.evaluate(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            try {
              eval('1');
              resolve('eval ran');
            } catch (error) {
              resolve(error instanceof Error ? error.name : 'threw a non-error');
            }
          }, 0);
        }),
    );
    expect(outcome).toBe('EvalError');
  });

  test('does not run an inline script and reports the violation', async ({ shell }) => {
    const outcome = await shell.evaluate(async () => {
      const page = globalThis as PageGlobal & { __inlineScriptRan?: boolean };

      // The browser queues the violation event as a task, so wait for it (with a deadline).
      const violation = new Promise<{ directive: string; blocked: string } | 'timeout'>(
        (resolve) => {
          page.document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              resolve({ directive: event.effectiveDirective, blocked: event.blockedURI });
            },
            { once: true },
          );
          setTimeout(() => {
            resolve('timeout');
          }, 5_000);
        },
      );

      const script = page.document.createElement('script');
      script.textContent = 'globalThis.__inlineScriptRan = true;';
      page.document.head.append(script);

      return { violation: await violation, ran: page.__inlineScriptRan === true };
    });

    expect(outcome.ran).toBe(false);
    expect(outcome.violation).not.toBe('timeout');
    // Inline <script> elements are checked against script-src-elem, which falls back to script-src.
    expect(outcome.violation).toMatchObject({
      directive: expect.stringMatching(/^script-src/),
      blocked: 'inline',
    });
  });

  test('loads the stylesheet under style-src self', async ({ shell }) => {
    // Tailwind's preflight is the only thing that sets these: the browser's default body margin
    // is 8px, and its default box-sizing is content-box. The page's own HTML sets neither.
    const styled = await shell.evaluate(() => {
      const page = globalThis as PageGlobal;
      const body = page.getComputedStyle(page.document.body);
      const sheets = Array.from(page.document.styleSheets);
      return {
        sheetHrefs: sheets.map((sheet) => sheet.href),
        ruleCounts: sheets.map((sheet) => sheet.cssRules.length),
        margin: body.margin,
        boxSizing: body.boxSizing,
      };
    });

    expect(styled.sheetHrefs.length).toBeGreaterThan(0);
    for (const href of styled.sheetHrefs) {
      expect(href).toMatch(/^app:\/\/shell\/assets\/.+\.css$/);
    }
    expect(styled.ruleCounts.every((count) => count > 0)).toBe(true);
    expect(styled.margin).toBe('0px');
    expect(styled.boxSizing).toBe('border-box');
  });

  test('answers missing files, traversal and non-GET requests with errors', async ({ shell }) => {
    const responses = await shell.evaluate(async () => {
      async function request(url: string, init?: { method: string; body: string }) {
        const fetched = await fetch(url, init);
        return {
          status: fetched.status,
          csp: fetched.headers.get('content-security-policy'),
          body: await fetched.text(),
        };
      }
      return {
        missing: await request('app://shell/no-such-file.js'),
        // `..%2f` is not a separator to the URL parser, so only the protocol handler sees `..`.
        traversal: await request('app://shell/..%2f..%2fmain%2findex.js'),
        backslashes: await request('app://shell/..%5c..%5cmain%5cindex.js'),
        post: await request('app://shell/index.html', { method: 'POST', body: 'x' }),
      };
    });

    expect(responses.missing.status).toBe(404);
    expect(responses.post.status).toBe(405);
    // Traversal is refused outright (404 outside the root, 400 for a backslash), and no file
    // content comes back: not main's code, not anything.
    expect(responses.traversal.status).toBe(404);
    expect(responses.backslashes.status).toBe(400);
    for (const response of Object.values(responses)) {
      expect(response.body).toBe('');
      // Errors carry the policy too: the CSP is on every response.
      expect(response.csp).toBe(SHELL_CSP);
    }
  });
});
