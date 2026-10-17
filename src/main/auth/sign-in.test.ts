import { describe, expect, it } from 'vitest';

import { PromptManager } from '../prompts/prompt-manager';
import { EventEmitter } from 'node:events';

import {
  MAX_SIGN_IN_ATTEMPTS,
  cleanRealm,
  createLoginHandler,
  trackMainFrameNavigations,
} from './sign-in';

const PAGE = 'https://intranet.example/home';

function setup() {
  let clock = 0;
  const prompts = new PromptManager({
    onChange: () => undefined,
    now: () => (clock += 1_000),
  });
  prompts.setVisibleTab('tab-1');
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => PAGE,
  });
  trackMainFrameNavigations(contents as never);
  /** The tab's main frame starts navigating to `url`. */
  const navigateMainFrame = (url: string): void => {
    contents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
  };
  const login = createLoginHandler({
    prompts,
    tabIdOf: (asked) => (asked === (contents as never) ? 'tab-1' : undefined),
    logger: { warn: () => undefined, error: () => undefined },
  });
  const calls: (string | undefined)[][] = [];
  const ask = (
    overrides: {
      url?: string;
      nav?: boolean;
      first?: boolean;
      proxy?: boolean;
      realm?: string;
    } = {},
  ) =>
    login(
      contents as never,
      {
        url: overrides.url ?? 'https://intranet.example/private',
        pid: 1,
        isRequestForNavigation: overrides.nav ?? true,
        firstAuthAttempt: overrides.first ?? true,
      },
      {
        isProxy: overrides.proxy ?? false,
        scheme: 'basic',
        host: 'intranet.example',
        port: 443,
        realm: overrides.realm ?? 'Staff area',
      },
      (username, password) => calls.push([username, password]),
    );
  const answer = async (
    decision: 'allow' | 'block',
    credentials?: { username: string; password: string },
  ) => {
    await Promise.resolve();
    const shown = prompts.current('tab-1');
    if (shown === null) {
      throw new Error('no prompt');
    }
    prompts.respond('tab-1', shown.id, {
      decision,
      remember: false,
      ...(credentials ? { credentials } : {}),
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { prompts, ask, answer, calls, contents, login, navigateMainFrame };
}

describe('the sign-in prompt', () => {
  it('asks in the strip, naming the server, and passes the answer on once', async () => {
    const { prompts, ask, answer, calls } = setup();
    expect(ask()).toBe(true);
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({
      kind: 'http-auth',
      site: 'intranet.example',
      realm: 'Staff area',
      secure: true,
    });
    await answer('allow', { username: 'ana', password: 's3cret' });
    expect(calls).toEqual([['ana', 's3cret']]);
  });

  it('cancels when the user does', async () => {
    const { ask, answer, calls } = setup();
    ask();
    await answer('block');
    expect(calls).toEqual([[undefined, undefined]]);
  });

  it('warns about a password that would travel unencrypted', async () => {
    const { prompts, ask, navigateMainFrame } = setup();
    navigateMainFrame('http://intranet.example/private');
    ask({ url: 'http://intranet.example/private' });
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({ secure: false });
  });

  it('refuses proxies, cross-origin subresources and pages that are not tabs', () => {
    const { ask, login, prompts } = setup();
    expect(ask({ proxy: true })).toBe(false);
    expect(ask({ nav: false, url: 'https://tracker.example/pixel.gif' })).toBe(false);
    expect(
      login(
        null,
        { url: PAGE, pid: 1, isRequestForNavigation: true, firstAuthAttempt: true },
        {
          isProxy: false,
          scheme: 'basic',
          host: 'x',
          port: 1,
          realm: '',
        },
        () => undefined,
      ),
    ).toBe(false);
    expect(prompts.current('tab-1')).toBeNull();
    // The page's own origin may ask for a subresource.
    expect(ask({ nav: false })).toBe(true);
  });

  it('lets the main frame’s navigation to another site ask, but never a cross-origin frame’s', async () => {
    const { prompts, ask, contents, navigateMainFrame } = setup();
    // A cross-origin iframe navigates (Chromium flags it as a navigation too): refused.
    expect(ask({ url: 'https://widget.example/login' })).toBe(false);
    // The main frame itself goes there: it may ask, naming that server.
    navigateMainFrame('https://widget.example/login');
    expect(ask({ url: 'https://widget.example/login' })).toBe(true);
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({ site: 'widget.example' });
    // Once the main frame stops, that origin no longer counts.
    prompts.dismissAll('tab-1');
    contents.emit('did-stop-loading');
    expect(ask({ url: 'https://widget.example/login' })).toBe(false);
  });

  it('stops asking after repeated failed tries, until a fresh first attempt', async () => {
    const { ask, answer } = setup();
    for (let attempt = 1; attempt <= MAX_SIGN_IN_ATTEMPTS; attempt += 1) {
      expect(ask({ first: attempt === 1 })).toBe(true);
      await answer('allow', { username: 'ana', password: 'wrong' });
    }
    expect(ask({ first: false })).toBe(false);
    expect(ask({ first: true })).toBe(true);
  });

  it('cleans the realm the server sends', () => {
    expect(cleanRealm(' Staff‮\u0007  area\n'.padEnd(300, 'x'))).toMatch(/^Staff area x+$/);
    expect(cleanRealm('x'.repeat(500))).toHaveLength(100);
  });
});
