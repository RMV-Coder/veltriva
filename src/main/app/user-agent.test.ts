import { describe, expect, it } from 'vitest';

import { cleanUserAgent } from './user-agent';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.149 Safari/537.36';

describe('cleanUserAgent', () => {
  it.each([
    [
      // Observed in M1.2 with productName "Veltriva Browser" (spaces removed by Electron).
      'the app token and the Electron token',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) VeltrivaBrowser/0.0.0 Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36',
    ],
    [
      // Spike S7: an unnamed development run has no app token.
      'only the Electron token',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36',
    ],
    [
      'an app token with a space and a pre-release version',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Veltriva Browser/1.2.3-beta.1 Chrome/152.0.7977.149 Electron/45.0.0-beta.4 Safari/537.36',
    ],
  ])('removes %s', (_label, userAgent) => {
    expect(cleanUserAgent(userAgent)).toBe(CHROME);
  });

  it('leaves a clean Chrome user agent unchanged', () => {
    expect(cleanUserAgent(CHROME)).toBe(CHROME);
  });

  it('is idempotent', () => {
    const dirty =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) VeltrivaBrowser/0.0.0 Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36';
    expect(cleanUserAgent(cleanUserAgent(dirty))).toBe(CHROME);
  });

  it('never leaves "Electron" or the product name behind', () => {
    const cleaned = cleanUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) VeltrivaBrowser/0.0.0 Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36',
    );
    expect(cleaned).not.toMatch(/electron|veltriva/i);
  });
});
