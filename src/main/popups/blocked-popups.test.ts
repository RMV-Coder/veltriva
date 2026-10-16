import { describe, expect, it } from 'vitest';

import { BlockedPopups } from './blocked-popups';

function setup() {
  let changes = 0;
  const blocked = new BlockedPopups({
    onChange: () => {
      changes += 1;
    },
  });
  return { blocked, changes: () => changes };
}

describe('BlockedPopups', () => {
  it('counts per tab and keeps the latest URL', () => {
    const { blocked, changes } = setup();
    blocked.record('tab-1', 'https://a.example/1');
    blocked.record('tab-1', 'https://a.example/2');
    expect(blocked.get('tab-1')).toEqual({ count: 2, latestUrl: 'https://a.example/2' });
    expect(blocked.get('tab-2')).toBeNull();
    expect(changes()).toBe(2);
  });

  it('hands out the latest one once, and the indicator goes', () => {
    const { blocked } = setup();
    blocked.record('tab-1', 'https://a.example/1');
    expect(blocked.take('tab-1')).toBe('https://a.example/1');
    expect(blocked.get('tab-1')).toBeNull();
    expect(blocked.take('tab-1')).toBeNull();
  });

  it('clears a tab (a new document), and only reports a change when there was one', () => {
    const { blocked, changes } = setup();
    blocked.clear('tab-1');
    expect(changes()).toBe(0);
    blocked.record('tab-1', 'https://a.example/1');
    blocked.clear('tab-1');
    expect(blocked.get('tab-1')).toBeNull();
    expect(changes()).toBe(2);
  });
});
