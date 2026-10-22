import { describe, expect, it } from 'vitest';

import { historyHandlers } from './history';
import { siteRuleHandlers } from './site-rules';
import { callerFor, useTestDatabase } from './test-database';

const T0 = 1_700_000_000_000;

describe('site rules (M5.1)', () => {
  const database = useTestDatabase();
  const caller = () => callerFor(siteRuleHandlers(database()));
  const rows = (call: ReturnType<typeof caller>) => call('siteRules.list', { limit: 10_000 }).rules;

  it('is empty before any rule', () => {
    expect(caller()('siteRules.list', { limit: 10 })).toEqual({ rules: [] });
  });

  it('keeps each rule, ordered by site', () => {
    const call = caller();
    call('siteRules.set', { site: 'github.com', protect: true, excludeMemory: false, at: T0 });
    call('siteRules.set', {
      site: 'bank.example',
      protect: false,
      excludeMemory: true,
      at: T0 + 1,
    });

    expect(rows(call)).toEqual([
      { site: 'bank.example', protect: false, excludeMemory: true, createdAt: T0 + 1 },
      { site: 'github.com', protect: true, excludeMemory: false, createdAt: T0 },
    ]);
  });

  it('changes a rule in place, keeping when the site was first added', () => {
    const call = caller();
    call('siteRules.set', { site: 'github.com', protect: true, excludeMemory: false, at: T0 });
    call('siteRules.set', { site: 'github.com', protect: true, excludeMemory: true, at: T0 + 5 });

    expect(rows(call)).toEqual([
      { site: 'github.com', protect: true, excludeMemory: true, createdAt: T0 },
    ]);
  });

  it('removes the row once the site has no rule left', () => {
    const call = caller();
    call('siteRules.set', { site: 'github.com', protect: true, excludeMemory: true, at: T0 });
    call('siteRules.set', { site: 'github.com', protect: false, excludeMemory: false, at: T0 + 1 });
    // Removing a rule the site never had changes nothing.
    call('siteRules.set', { site: 'never.example', protect: false, excludeMemory: false, at: T0 });

    expect(rows(call)).toEqual([]);
    expect(database().prepare('SELECT count(*) FROM site_rules').pluck().get()).toBe(0);
  });

  it('returns no more than the limit, the first sites in order', () => {
    const call = caller();
    for (const site of ['c.example', 'a.example', 'b.example']) {
      call('siteRules.set', { site, protect: true, excludeMemory: false, at: T0 });
    }

    expect(call('siteRules.list', { limit: 2 }).rules.map((rule) => rule.site)).toEqual([
      'a.example',
      'b.example',
    ]);
  });

  it('an excluded site records no visit and no page; protecting it alone does not exclude it', () => {
    const call = caller();
    const history = callerFor(historyHandlers(database()));
    const visit = (site: string) =>
      history('history.recordVisit', {
        page: { urlKey: `https://${site}/`, url: `https://${site}/`, host: site, site, title: '' },
        transition: 'typed',
        visitedAt: T0,
        tabId: null,
      });
    call('siteRules.set', { site: 'bank.example', protect: false, excludeMemory: true, at: T0 });
    call('siteRules.set', { site: 'github.com', protect: true, excludeMemory: false, at: T0 });

    expect(visit('bank.example')).toEqual({ pageId: null });
    expect(visit('github.com').pageId).toEqual(expect.any(Number));
    expect(database().prepare('SELECT site FROM pages').pluck().all()).toEqual(['github.com']);
  });
});
