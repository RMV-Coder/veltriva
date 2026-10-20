import { describe, expect, it } from 'vitest';

import { appStateHandlers } from './app-state';
import { callerFor, useTestDatabase } from './test-database';

describe('appState', () => {
  const database = useTestDatabase();
  const caller = () => callerFor(appStateHandlers(database()));
  const stored = () => database().prepare('SELECT key, json FROM app_state ORDER BY key').all();

  it('reads a key that was never set as null', () => {
    expect(caller()('appState.get', { key: 'session' })).toEqual({ value: null });
  });

  it('round-trips documents of every JSON shape', () => {
    const call = caller();
    const documents = {
      session: { selected: 'abc', tabs: [{ id: 1, pinned: false, note: null }], nested: { a: [] } },
      list: [1, 'two', true, null, { three: 3 }],
      text: 'ünïcode, "quotes" and 😀',
      count: 42.5,
      flag: false,
    };

    for (const [key, value] of Object.entries(documents)) {
      expect(call('appState.set', { key, value })).toEqual({});
    }

    for (const [key, value] of Object.entries(documents)) {
      expect(call('appState.get', { key })).toEqual({ value });
    }
  });

  it('stores the document as JSON text under its key', () => {
    caller()('appState.set', { key: 'window', value: { x: 1, y: [2] } });

    expect(stored()).toEqual([{ key: 'window', json: '{"x":1,"y":[2]}' }]);
  });

  it('replaces the whole document when a key is set again', () => {
    const call = caller();
    call('appState.set', { key: 'session', value: { a: 1, b: 2 } });

    call('appState.set', { key: 'session', value: { b: 3 } });

    expect(call('appState.get', { key: 'session' })).toEqual({ value: { b: 3 } });
    expect(stored()).toHaveLength(1);
  });

  it('keeps keys independent of each other', () => {
    const call = caller();
    call('appState.set', { key: 'session', value: 'one' });
    call('appState.set', { key: 'window', value: 'two' });

    expect(call('appState.get', { key: 'session' })).toEqual({ value: 'one' });
    expect(call('appState.get', { key: 'window' })).toEqual({ value: 'two' });
  });

  it('refuses a null document, which would read back like a missing key', () => {
    const call = caller();
    expect(() => call('appState.set', { key: 'session', value: null })).toThrow();
    expect(stored()).toEqual([]);
  });

  it('round-trips a document at the size limit', () => {
    const call = caller();
    const value = 'x'.repeat(1_048_576 - 2);

    call('appState.set', { key: 'big', value });

    expect(call('appState.get', { key: 'big' })).toEqual({ value });
  });

  it('deletes a key and reports whether it was there', () => {
    const call = caller();
    call('appState.set', { key: 'session', value: { a: 1 } });
    call('appState.set', { key: 'window', value: { b: 2 } });

    expect(call('appState.delete', { key: 'session' })).toEqual({ count: 1 });
    expect(call('appState.delete', { key: 'session' })).toEqual({ count: 0 });
    expect(call('appState.get', { key: 'session' })).toEqual({ value: null });
    expect(call('appState.get', { key: 'window' })).toEqual({ value: { b: 2 } });
  });
});
