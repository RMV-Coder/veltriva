import { describe, expect, it, vi } from 'vitest';

import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type { DataMethod } from '../../shared/contracts/data-rpc';
import { MAX_SITE_RULES, SiteRules } from './site-rules';
import type { SiteRule } from './site-rules';

const T0 = 1_700_000_000_000;

function setup(stored: readonly SiteRule[] = [], failWrites = false) {
  const writes: unknown[] = [];
  const call = vi.fn((method: DataMethod, input: unknown) => {
    DATA_METHODS[method].input.parse(input);
    writes.push(input);
    return failWrites ? Promise.reject(new Error('full')) : Promise.resolve({});
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  const onChange = vi.fn();
  const rules = new SiteRules({
    data: { call: call as never },
    logger,
    stored,
    now: () => T0,
    onChange,
  });
  return { rules, writes, logger, onChange };
}

describe('SiteRules (M5.1)', () => {
  it('starts with the stored rules, by site', () => {
    const { rules } = setup([
      { site: 'github.com', protect: true, excludeMemory: false },
      { site: 'bank.example', protect: false, excludeMemory: true },
    ]);

    expect(rules.list()).toEqual([
      { site: 'bank.example', protect: false, excludeMemory: true },
      { site: 'github.com', protect: true, excludeMemory: false },
    ]);
    expect(rules.isProtected('github.com')).toBe(true);
    expect(rules.isExcluded('github.com')).toBe(false);
    expect(rules.isExcluded('bank.example')).toBe(true);
    expect(rules.isProtected('example.com')).toBe(false);
  });

  it('ignores a stored row with no rule', () => {
    const { rules } = setup([{ site: 'empty.example', protect: false, excludeMemory: false }]);
    expect(rules.list()).toEqual([]);
  });

  it('answers for a page by its site: any host of it, http or https', () => {
    const { rules } = setup([{ site: 'example.co.uk', protect: true, excludeMemory: true }]);

    expect(rules.protectsUrl('https://mail.example.co.uk/inbox')).toBe(true);
    expect(rules.excludesUrl('http://www.example.co.uk/')).toBe(true);
    expect(rules.protectsUrl('https://example.com/')).toBe(false);
    expect(rules.excludesUrl('')).toBe(false);
    expect(rules.excludesUrl('file:///C:/example.co.uk')).toBe(false);
  });

  it('sets one rule and keeps the other, and writes both', () => {
    const { rules, writes, onChange } = setup([
      { site: 'github.com', protect: true, excludeMemory: false },
    ]);

    expect(rules.set('github.com', { excludeMemory: true })).toBe(true);

    expect(rules.list()).toEqual([{ site: 'github.com', protect: true, excludeMemory: true }]);
    expect(writes).toEqual([{ site: 'github.com', protect: true, excludeMemory: true, at: T0 }]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('removes the site once it has no rule left', () => {
    const { rules, writes } = setup([{ site: 'github.com', protect: true, excludeMemory: false }]);

    rules.set('github.com', { protect: false });

    expect(rules.list()).toEqual([]);
    expect(writes).toEqual([{ site: 'github.com', protect: false, excludeMemory: false, at: T0 }]);
  });

  it('writes nothing and announces nothing when nothing changes', () => {
    const { rules, writes, onChange } = setup([
      { site: 'github.com', protect: true, excludeMemory: false },
    ]);

    rules.set('github.com', { protect: true });
    rules.set('unknown.example', { protect: false, excludeMemory: false });

    expect(writes).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it(`holds at most ${String(MAX_SITE_RULES)} sites: one more is refused, a change to one is not`, () => {
    const stored = Array.from({ length: MAX_SITE_RULES }, (_, index) => ({
      site: `site-${String(index)}.example`,
      protect: true,
      excludeMemory: false,
    }));
    const { rules, writes } = setup(stored);

    expect(rules.set('one-more.example', { protect: true })).toBe(false);
    expect(rules.isProtected('one-more.example')).toBe(false);
    expect(rules.set('site-5.example', { excludeMemory: true })).toBe(true);
    expect(rules.set('site-6.example', { protect: false })).toBe(true);
    expect(rules.set('one-more.example', { protect: true })).toBe(true);
    expect(writes).toHaveLength(3);
  });

  it('logs a failed write by code, and the rule holds for the run', async () => {
    const { rules, logger } = setup([], true);

    rules.set('github.com', { protect: true });
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith('siteRules.writeFailed');
    });

    expect(rules.isProtected('github.com')).toBe(true);
  });
});
