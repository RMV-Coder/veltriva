// ADR-0006 A′ and ADR-0008 4a: while the transparent shell is raised above a page (the fullscreen
// notice, later the memory palette), the page stays visible and live. Chromium hides a page under
// an opaque view (spike S1); this checks that a transparent shell doesn't count, on every run,
// so an Electron upgrade that breaks it is caught (option B is the fallback).
import { describe, expect, it } from 'vitest';

import { runScenario } from './harness';

interface Reading {
  readonly ticks: number;
  readonly visibility: string;
}

describe('a page under the raised shell', () => {
  it('stays visible and is not throttled', async () => {
    const { result } = await runScenario<{
      windowMs: number;
      raised: Reading;
      stillRaised: boolean;
    }>('raised-shell-keeps-page-visible');

    // Measured while the notice was up, with the shell above the page.
    expect(result.stillRaised).toBe(true);
    expect(result.raised.visibility).toBe('visible');
    // About 30 ticks of a 100 ms interval in 3 s; throttled would be about 3.
    expect(result.raised.ticks).toBeGreaterThanOrEqual(result.windowMs / 100 / 2);
  });
});

describe('a page under the memory palette (M4.2)', () => {
  it('stays visible and is not throttled while Ctrl+Shift+K raises the shell', async () => {
    const { result } = await runScenario<{
      windowMs: number;
      raised: Reading;
      stillRaised: boolean;
    }>('palette-keeps-page-visible');

    // Measured while the palette was open, with the shell above the page.
    expect(result.stillRaised).toBe(true);
    expect(result.raised.visibility).toBe('visible');
    expect(result.raised.ticks).toBeGreaterThanOrEqual(result.windowMs / 100 / 2);
  });
});
