import { describe, expect, it } from 'vitest';

import { PromptManager } from '../prompts/prompt-manager';
import type { PromptAnswer } from '../prompts/prompt-manager';
import { ExternalProtocolGuard } from './protocol-guard';
import type { ExternalRequest } from './protocol-guard';

const PAGE = 'https://zoom.example/j/123';

function setup(options: { appName?: string; launchFails?: boolean } = {}) {
  const launched: string[] = [];
  const warnings: string[] = [];
  const prompts = new PromptManager({ onChange: () => undefined });
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
