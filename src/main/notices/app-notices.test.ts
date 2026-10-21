import { describe, expect, it, vi } from 'vitest';

import { AppNotices, MAX_NOTICES } from './app-notices';

describe('AppNotices', () => {
  it('shows notices in order, each with its own id', () => {
    const notices = new AppNotices();
    const first = notices.show({ kind: 'database-reset', corruptFile: 'a' });
    const second = notices.show({ kind: 'database-restored', backupAt: 5, corruptFile: 'b' });
    expect(first).toBe('notice-1');
    expect(second).toBe('notice-2');
    expect(notices.list()).toEqual([
      { id: 'notice-1', kind: 'database-reset', corruptFile: 'a' },
      { id: 'notice-2', kind: 'database-restored', backupAt: 5, corruptFile: 'b' },
    ]);
  });

  it('keeps only the newest few', () => {
    const notices = new AppNotices();
    for (let i = 0; i < MAX_NOTICES + 2; i++) {
      notices.show({ kind: 'database-reset', corruptFile: String(i) });
    }
    expect(
      notices.list().map((notice) => ('corruptFile' in notice ? notice.corruptFile : '')),
    ).toEqual(['2', '3', '4']);
  });

  it('dismisses by id, once', () => {
    const notices = new AppNotices();
    const id = notices.show({ kind: 'database-reset', corruptFile: 'a' });
    expect(notices.dismiss('notice-99')).toBe(false);
    expect(notices.dismiss(id)).toBe(true);
    expect(notices.dismiss(id)).toBe(false);
    expect(notices.list()).toEqual([]);
  });

  it('tells listeners about every change, and stops when they unsubscribe', () => {
    const notices = new AppNotices();
    const listener = vi.fn();
    const unsubscribe = notices.onChange(listener);
    const id = notices.show({ kind: 'database-reset', corruptFile: 'a' });
    notices.dismiss('notice-99');
    notices.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    notices.show({ kind: 'database-reset', corruptFile: 'b' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
