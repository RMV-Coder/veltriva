import { describe, expect, it } from 'vitest';

import { checkShellSender } from './sender';
import type { SenderFacts } from './sender';

const SHELL_ONLY = new Set(['app://shell']);
const shellMainFrame: SenderFacts = {
  role: 'shell',
  hasFrame: true,
  isMainFrame: true,
  origin: 'app://shell',
};

describe('checkShellSender', () => {
  it('trusts the main frame of the shell on app://shell', () => {
    expect(checkShellSender(shellMainFrame, SHELL_ONLY)).toEqual({ trusted: true });
  });

  it.each([['tab'], ['popup'], ['devtools'], ['unknown'], [undefined]] as const)(
    'rejects a %s sender even on the shell origin',
    (role) => {
      expect(checkShellSender({ ...shellMainFrame, role }, SHELL_ONLY)).toEqual({
        trusted: false,
        reason: 'not-shell',
      });
    },
  );

  it('rejects a shell message whose frame is gone', () => {
    expect(
      checkShellSender(
        { ...shellMainFrame, hasFrame: false, isMainFrame: false, origin: undefined },
        SHELL_ONLY,
      ),
    ).toEqual({ trusted: false, reason: 'no-frame' });
  });

  it('rejects a subframe of the shell', () => {
    expect(checkShellSender({ ...shellMainFrame, isMainFrame: false }, SHELL_ONLY)).toEqual({
      trusted: false,
      reason: 'not-main-frame',
    });
  });

  it.each([
    ['a web origin', 'https://example.com'],
    ['the dev server, when only app://shell is allowed', 'http://localhost:5173'],
    ['an opaque origin', 'null'],
    ['a look-alike host', 'app://shell.evil'],
    ['a different scheme', 'veltriva://shell'],
    ['no origin', undefined],
  ])('rejects %s', (_label, origin) => {
    expect(checkShellSender({ ...shellMainFrame, origin }, SHELL_ONLY)).toEqual({
      trusted: false,
      reason: 'origin-not-allowed',
    });
  });

  it('accepts the dev-server origin only when it is in the allowed set', () => {
    const dev = new Set(['app://shell', 'http://localhost:5173']);
    expect(checkShellSender({ ...shellMainFrame, origin: 'http://localhost:5173' }, dev)).toEqual({
      trusted: true,
    });
  });
});
