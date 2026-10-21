import { describe, expect, it, vi } from 'vitest';

import { PromptManager } from '../prompts/prompt-manager';
import type { PromptAnswer } from '../prompts/prompt-manager';
import { ExternalProtocolGuard } from './protocol-guard';
import type { ExternalRequest } from './protocol-guard';

const PAGE = 'https://zoom.example/j/123';

function setup(
  options: {
    appName?: string;
    launchFails?: boolean;
    /** Stored "always allow" answers, as the guard is given them at startup. */
    alwaysAllowed?: { site: string; scheme: string }[];
    onAlwaysAllowed?: (site: string, scheme: string) => void;
  } = {},
) {
  const launched: string[] = [];
  const warnings: string[] = [];
  // Each reading of the clock is a second later: every answer comes long after its question.
  let clock = 0;
  const prompts = new PromptManager({
    onChange: () => undefined,
    now: () => {
      clock += 1_000;
      return clock;
    },
  });
  prompts.setVisibleTab('tab-1');
  const guard = new ExternalProtocolGuard({
    prompts,
    appNameFor: () => options.appName ?? 'Zoom Meetings',
    launch: (url) => {
      if (options.launchFails === true) {
        return Promise.reject(new Error('no app'));
      }
      launched.push(url);
      return Promise.resolve();
    },
    logger: {
      warn: (event) => warnings.push(event),
      error: (event) => warnings.push(event),
    },
    ...(options.alwaysAllowed === undefined ? {} : { alwaysAllowed: options.alwaysAllowed }),
    ...(options.onAlwaysAllowed === undefined ? {} : { onAlwaysAllowed: options.onAlwaysAllowed }),
  });
  const request = (overrides: Partial<ExternalRequest> = {}): ExternalRequest => ({
    tabId: 'tab-1',
    url: 'zoommtg://zoom.example/join?confno=123',
    pageUrl: PAGE,
    gesture: true,
    ...overrides,
  });
  /** Answers the shown prompt once it appears. */
  const answer = async (reply: PromptAnswer): Promise<void> => {
    await Promise.resolve();
    const shown = prompts.current('tab-1');
    if (shown === null) {
      throw new Error('no prompt is shown');
    }
    prompts.respond('tab-1', shown.id, reply);
  };
  return { guard, prompts, launched, warnings, request, answer };
}

describe('ExternalProtocolGuard', () => {
  it('asks, naming the site and the app, and launches the escaped URL on yes', async () => {
    const { guard, prompts, launched, request, answer } = setup();
    const outcome = guard.request(request({ url: 'zoommtg://zoom.example/join?confno=123 x' }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({
      kind: 'external-protocol',
      site: 'zoom.example',
      scheme: 'zoommtg',
      appName: 'Zoom Meetings',
      canRemember: true,
    });
    await answer({ decision: 'allow', remember: false });
    await expect(outcome).resolves.toBe('launched');
    expect(launched).toEqual(['zoommtg://zoom.example/join?confno=123%20x']);
  });

  it('launches nothing when the user says no or the prompt goes away', async () => {
    const { guard, launched, request, answer, prompts } = setup();
    const declined = guard.request(request());
    await answer({ decision: 'block', remember: false });
    await expect(declined).resolves.toBe('declined');
    const dismissed = guard.request(request());
    await Promise.resolve();
    prompts.dismissAll('tab-1');
    await expect(dismissed).resolves.toBe('declined');
    expect(launched).toEqual([]);
  });

  it('never launches an always-blocked scheme, and asks nothing', async () => {
    const { guard, prompts, launched, warnings, request } = setup();
    for (const url of [
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x',
      'file:///C:/x.exe',
      'javascript:1',
    ]) {
      await expect(guard.request(request({ url }))).resolves.toBe('blocked');
    }
    expect(prompts.current('tab-1')).toBeNull();
    expect(launched).toEqual([]);
    expect(warnings.every((event) => event === 'external.refused')).toBe(true);
  });

  it('needs a gesture: a page that launches on load gets no prompt at all', async () => {
    const { guard, prompts, launched, request } = setup();
    await expect(guard.request(request({ gesture: false }))).resolves.toBe('blocked');
    expect(prompts.current('tab-1')).toBeNull();
    expect(launched).toEqual([]);
  });

  it('refuses pages with no site to name', async () => {
    const { guard, prompts, request } = setup();
    for (const pageUrl of ['about:blank', 'data:text/html,x', 'file:///C:/page.html']) {
      await expect(guard.request(request({ pageUrl }))).resolves.toBe('blocked');
    }
    expect(prompts.current('tab-1')).toBeNull();
  });

  it('remembers "always allow" per site and scheme, and still needs a gesture', async () => {
    const { guard, prompts, launched, request, answer } = setup();
    const first = guard.request(request());
    await answer({ decision: 'allow', remember: true });
    await expect(first).resolves.toBe('launched');

    await expect(guard.request(request())).resolves.toBe('launched');
    expect(prompts.current('tab-1')).toBeNull();
    await expect(guard.request(request({ gesture: false }))).resolves.toBe('blocked');

    // Another scheme on the same site, or the same scheme on another site, asks again.
    const other = guard.request(request({ url: 'mailto:a@b.example' }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({ scheme: 'mailto' });
    await answer({ decision: 'block', remember: false });
    await other;
    const otherSite = guard.request(request({ pageUrl: 'https://evil.example/' }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({ site: 'evil.example' });
    await answer({ decision: 'block', remember: false });
    await otherSite;
    expect(launched).toHaveLength(2);
  });

  it('asks without "always allow" for a typed address, which has no site', async () => {
    const { guard, prompts, request, answer, launched } = setup();
    const typed = guard.request(request({ pageUrl: null, url: 'mailto:a@b.example' }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({ site: null, canRemember: false });
    // A remember tick can't be stored without a site.
    await answer({ decision: 'allow', remember: true });
    await expect(typed).resolves.toBe('launched');
    const again = guard.request(request({ pageUrl: null, url: 'mailto:a@b.example' }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).not.toBeNull();
    await answer({ decision: 'block', remember: false });
    await again;
    expect(launched).toEqual(['mailto:a@b.example']);
  });

  it('cleans the app name Windows reports before showing it', async () => {
    const { guard, prompts, request } = setup({
      appName: 'Zoom\u202e\u0007 Meetings\n'.padEnd(200, 'x'),
    });
    void guard.request(request());
    await Promise.resolve();
    const appName = (prompts.current('tab-1') as { appName: string } | null)?.appName ?? '';
    expect(appName.startsWith('Zoom Meetings')).toBe(true);
    expect(appName).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(appName.length).toBeLessThanOrEqual(64);
  });

  it('reports a failed launch', async () => {
    const { guard, request, answer, warnings } = setup({ launchFails: true });
    const outcome = guard.request(request());
    await answer({ decision: 'allow', remember: false });
    await expect(outcome).resolves.toBe('failed');
    expect(warnings).toContain('external.launchFailed');
  });
});

describe('ExternalProtocolGuard: stored always-allow answers', () => {
  const ZOOM = { site: 'https://zoom.example', scheme: 'zoommtg' };

  it('launches without asking for the site and scheme that were stored', async () => {
    const { guard, prompts, launched, request } = setup({ alwaysAllowed: [ZOOM] });

    await expect(guard.request(request())).resolves.toBe('launched');

    expect(prompts.current('tab-1')).toBeNull();
    expect(launched).toEqual(['zoommtg://zoom.example/join?confno=123']);
  });

  it('asks again for another scheme on the same site', async () => {
    const { guard, prompts, launched, request, answer } = setup({ alwaysAllowed: [ZOOM] });

    const outcome = guard.request(request({ url: 'mailto:a@b.example' }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({ scheme: 'mailto', canRemember: true });
    await answer({ decision: 'block', remember: false });

    await expect(outcome).resolves.toBe('declined');
    expect(launched).toEqual([]);
  });

  it('asks again for the same scheme on another site', async () => {
    const { guard, prompts, launched, request, answer } = setup({ alwaysAllowed: [ZOOM] });

    const outcome = guard.request(request({ pageUrl: 'https://evil.example/' }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({ scheme: 'zoommtg', site: 'evil.example' });
    await answer({ decision: 'block', remember: false });

    await expect(outcome).resolves.toBe('declined');
    expect(launched).toEqual([]);
  });

  it.each([
    ['another port', 'https://zoom.example:8443/j/1'],
    ['another scheme of the page', 'http://zoom.example/j/1'],
    ['a subdomain', 'https://www.zoom.example/j/1'],
    ['a parent domain', 'https://example/j/1'],
    ['a site that ends the same way', 'https://notzoom.example/j/1'],
  ])('is the stored site only: %s asks', async (_what, pageUrl) => {
    const { guard, prompts, request, answer } = setup({ alwaysAllowed: [ZOOM] });

    const outcome = guard.request(request({ pageUrl }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).not.toBeNull();
    await answer({ decision: 'block', remember: false });

    await expect(outcome).resolves.toBe('declined');
  });

  it('matches the site by its origin, whatever the path, query or fragment of the page', async () => {
    const { guard, prompts, launched, request } = setup({ alwaysAllowed: [ZOOM] });

    for (const pageUrl of [
      'https://zoom.example/',
      'https://zoom.example/a/b?c=d#e',
      'https://ZOOM.example:443/x',
    ]) {
      await expect(guard.request(request({ pageUrl }))).resolves.toBe('launched');
    }

    expect(prompts.current('tab-1')).toBeNull();
    expect(launched).toHaveLength(3);
  });

  it('still needs a gesture: a stored answer does not let a page launch on load', async () => {
    const { guard, prompts, launched, request } = setup({ alwaysAllowed: [ZOOM] });

    await expect(guard.request(request({ gesture: false }))).resolves.toBe('blocked');

    expect(prompts.current('tab-1')).toBeNull();
    expect(launched).toEqual([]);
  });

  it('never launches an always-blocked scheme, though one is stored for it', async () => {
    const { guard, launched, request } = setup({
      alwaysAllowed: [
        { site: 'https://zoom.example', scheme: 'ms-msdt' },
        { site: 'https://zoom.example', scheme: 'search-ms' },
        { site: 'https://zoom.example', scheme: 'file' },
      ],
    });

    for (const url of ['ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'file:///C:/x.exe']) {
      await expect(guard.request(request({ url }))).resolves.toBe('blocked');
    }

    expect(launched).toEqual([]);
  });

  it('asks about a typed address, which has no site, whatever is stored', async () => {
    const { guard, prompts, request, answer } = setup({ alwaysAllowed: [ZOOM] });

    const outcome = guard.request(request({ pageUrl: null }));
    await Promise.resolve();
    expect(prompts.current('tab-1')).toMatchObject({ site: null, canRemember: false });
    await answer({ decision: 'block', remember: false });

    await expect(outcome).resolves.toBe('declined');
  });

  it('holds several schemes for one site, and several sites for one scheme', async () => {
    const { guard, prompts, launched, request } = setup({
      alwaysAllowed: [
        { site: 'https://zoom.example', scheme: 'zoommtg' },
        { site: 'https://zoom.example', scheme: 'mailto' },
        { site: 'https://other.example', scheme: 'zoommtg' },
      ],
    });

    await guard.request(request());
    await guard.request(request({ url: 'mailto:a@b.example' }));
    await guard.request(request({ pageUrl: 'https://other.example/' }));

    expect(prompts.current('tab-1')).toBeNull();
    expect(launched).toEqual([
      'zoommtg://zoom.example/join?confno=123',
      'mailto:a@b.example',
      'zoommtg://zoom.example/join?confno=123',
    ]);
  });

  it('asks as usual when nothing is stored', async () => {
    const { guard, prompts, request, answer } = setup({ alwaysAllowed: [] });

    const asked = guard.request(request());
    await Promise.resolve();
    expect(prompts.current('tab-1')).not.toBeNull();
    await answer({ decision: 'block', remember: false });

    await expect(asked).resolves.toBe('declined');
  });

  it('does not report a stored answer to onAlwaysAllowed: it is stored already', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, request } = setup({ alwaysAllowed: [ZOOM], onAlwaysAllowed });

    await guard.request(request());

    expect(onAlwaysAllowed).not.toHaveBeenCalled();
  });
});

describe('ExternalProtocolGuard: onAlwaysAllowed', () => {
  it('is called with the origin of the site and the scheme when the user ticks always allow', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, request, answer } = setup({ onAlwaysAllowed });

    const outcome = guard.request(request({ pageUrl: 'https://zoom.example/j/123?x=1#y' }));
    await answer({ decision: 'allow', remember: true });

    await expect(outcome).resolves.toBe('launched');
    expect(onAlwaysAllowed).toHaveBeenCalledTimes(1);
    expect(onAlwaysAllowed).toHaveBeenCalledWith('https://zoom.example', 'zoommtg');
  });

  it('is not called when the user allows once, without ticking it', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, launched, request, answer } = setup({ onAlwaysAllowed });

    const outcome = guard.request(request());
    await answer({ decision: 'allow', remember: false });

    await expect(outcome).resolves.toBe('launched');
    expect(launched).toHaveLength(1);
    expect(onAlwaysAllowed).not.toHaveBeenCalled();
  });

  it('is not called when the user declines, even with the box ticked', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, request, answer } = setup({ onAlwaysAllowed });

    const outcome = guard.request(request());
    await answer({ decision: 'block', remember: true });

    await expect(outcome).resolves.toBe('declined');
    expect(onAlwaysAllowed).not.toHaveBeenCalled();
  });

  it('is not called when the prompt goes away unanswered', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, prompts, request } = setup({ onAlwaysAllowed });

    const outcome = guard.request(request());
    await Promise.resolve();
    prompts.dismissAll('tab-1');

    await expect(outcome).resolves.toBe('declined');
    expect(onAlwaysAllowed).not.toHaveBeenCalled();
  });

  it('is not called for a typed address, which has no site to remember', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, request, answer } = setup({ onAlwaysAllowed });

    const outcome = guard.request(request({ pageUrl: null, url: 'mailto:a@b.example' }));
    await answer({ decision: 'allow', remember: true });

    await expect(outcome).resolves.toBe('launched');
    expect(onAlwaysAllowed).not.toHaveBeenCalled();
  });

  it('is not called again for a later request the stored answer lets through', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, prompts, request, answer } = setup({ onAlwaysAllowed });
    const first = guard.request(request());
    await answer({ decision: 'allow', remember: true });
    await first;

    await expect(guard.request(request())).resolves.toBe('launched');
    await expect(guard.request(request())).resolves.toBe('launched');

    expect(prompts.current('tab-1')).toBeNull();
    expect(onAlwaysAllowed).toHaveBeenCalledTimes(1);
  });

  it('is called once for each site and scheme the user ticks it for', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, request, answer } = setup({ onAlwaysAllowed });

    for (const [pageUrl, url] of [
      ['https://zoom.example/', 'zoommtg://zoom.example/join'],
      ['https://zoom.example/', 'mailto:a@b.example'],
      ['https://other.example/', 'zoommtg://zoom.example/join'],
    ] as const) {
      const outcome = guard.request(request({ pageUrl, url }));
      await answer({ decision: 'allow', remember: true });
      await outcome;
    }

    expect(onAlwaysAllowed.mock.calls).toEqual([
      ['https://zoom.example', 'zoommtg'],
      ['https://zoom.example', 'mailto'],
      ['https://other.example', 'zoommtg'],
    ]);
  });

  it('is called before the app is launched, so an answer holds even when the launch fails', async () => {
    const order: string[] = [];
    const { guard, request, answer } = setup({
      launchFails: true,
      onAlwaysAllowed: () => order.push('stored'),
    });

    const outcome = guard.request(request());
    await answer({ decision: 'allow', remember: true });

    await expect(outcome).resolves.toBe('failed');
    expect(order).toEqual(['stored']);
  });

  it('is not called for a request that was refused before the prompt', async () => {
    const onAlwaysAllowed = vi.fn();
    const { guard, request } = setup({ onAlwaysAllowed });

    await guard.request(request({ gesture: false }));
    await guard.request(request({ url: 'ms-msdt:/id x' }));
    await guard.request(request({ pageUrl: 'about:blank' }));

    expect(onAlwaysAllowed).not.toHaveBeenCalled();
  });

  it('is optional: remembering works in memory without it', async () => {
    const { guard, prompts, request, answer } = setup();
    const first = guard.request(request());
    await answer({ decision: 'allow', remember: true });
    await first;

    await expect(guard.request(request())).resolves.toBe('launched');
    expect(prompts.current('tab-1')).toBeNull();
  });
});
