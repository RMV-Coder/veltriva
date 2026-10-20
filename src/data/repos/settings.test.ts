import { describe, expect, it } from 'vitest';

import { settingsHandlers } from './settings';
import { callerFor, useTestDatabase } from './test-database';

describe('settings', () => {
  const database = useTestDatabase();
  const caller = () => callerFor(settingsHandlers(database()));
  const stored = () => database().prepare('SELECT id, json FROM settings').all();

  it('reads null before anything was saved', () => {
    expect(caller()('settings.get', {})).toEqual({ value: null });
  });

  it('round-trips the document, nested values included', () => {
    const call = caller();
    const value = {
      version: 1,
      privacy: { sendDoNotTrack: true, clearOnExit: ['cookies', 'cache'] },
      search: { engine: 'duckduckgo', suggestions: null },
      zoom: 1.25,
    };

    expect(call('settings.set', { value })).toEqual({});

    expect(call('settings.get', {})).toEqual({ value });
  });

  it('keeps the document in row 1, as JSON text', () => {
    caller()('settings.set', { value: { theme: 'dark' } });

    expect(stored()).toEqual([{ id: 1, json: '{"theme":"dark"}' }]);
  });

  it('replaces the document instead of merging into it', () => {
    const call = caller();
    call('settings.set', { value: { theme: 'dark', zoom: 2 } });

    call('settings.set', { value: { theme: 'light' } });

    expect(call('settings.get', {})).toEqual({ value: { theme: 'light' } });
    expect(stored()).toHaveLength(1);
  });

  it('stores an empty document', () => {
    const call = caller();

    call('settings.set', { value: {} });

    expect(call('settings.get', {})).toEqual({ value: {} });
  });
});
