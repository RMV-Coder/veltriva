import { describe, expect, it } from 'vitest';

import { feedProblem, updateStatusText } from './update-display';
import type { UpdateView } from './update-display';

const view = (change: Partial<UpdateView> = {}): UpdateView => ({
  enabled: true,
  feedUrl: 'https://api.github.com/repos/RMV-Coder/veltriva/releases/latest',
  currentVersion: '0.1.0',
  lastCheckedAt: null,
  lastStatus: null,
  available: null,
  checking: false,
  ...change,
});
const format = { locale: 'en-US', timeZone: 'UTC' };
const AT = Date.UTC(2026, 9, 23, 8, 30);

describe('updateStatusText (M6.3)', () => {
  it('says the check is off, and that nothing is contacted', () => {
    expect(updateStatusText(view({ enabled: false }), format)).toBe(
      'Off. Veltriva never contacts the release feed while this is off.',
    );
  });

  it('says what the last check found', () => {
    expect(updateStatusText(view(), format)).toMatch(/^Not checked yet/);
    expect(updateStatusText(view({ checking: true }), format)).toBe('Checking…');
    expect(
      updateStatusText(
        view({
          lastCheckedAt: AT,
          lastStatus: 'available',
          available: { version: '0.2.0', url: 'https://github.com/x/y/releases/tag/v0.2.0' },
        }),
        format,
      ),
    ).toBe('Veltriva 0.2.0 is available. You have 0.1.0.');
    expect(updateStatusText(view({ lastCheckedAt: AT, lastStatus: 'up-to-date' }), format)).toBe(
      'Veltriva 0.1.0 is the newest version (checked Oct 23, 2026, 8:30 AM).',
    );
    expect(updateStatusText(view({ lastCheckedAt: AT, lastStatus: 'failed' }), format)).toBe(
      "The last check didn't get an answer (Oct 23, 2026, 8:30 AM). Veltriva tries again a day later.",
    );
  });
});

describe('feedProblem (M6.3)', () => {
  it('asks for an http(s) address; main checks the rest', () => {
    expect(feedProblem('  ')).toBe('Enter the address of a release feed.');
    expect(feedProblem('ftp://example.com/feed')).toMatch(/^Use an https address/);
    expect(feedProblem('https://example.com/feed.json')).toBeNull();
    expect(feedProblem('http://127.0.0.1:8080/feed')).toBeNull();
  });
});
