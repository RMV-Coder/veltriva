import { describe, expect, it } from 'vitest';

import { DISMISS_UNDO_LABEL, UNDO_LABEL, undoToastText } from './undo-display';

const automated = (shelved: number, archived: number) => ({ automated: true, shelved, archived });
const manual = (shelved: number, archived: number) => ({ automated: false, shelved, archived });

describe('undoToastText', () => {
  it('counts the tabs automation moved to Sleeping', () => {
    expect(undoToastText(automated(3, 0))).toBe('Moved 3 tabs to Sleeping');
    expect(undoToastText(automated(1, 0))).toBe('Moved 1 tab to Sleeping');
  });

  it('counts the tabs automation archived', () => {
    expect(undoToastText(automated(0, 2))).toBe('Archived 2 tabs');
    expect(undoToastText(automated(0, 1))).toBe('Archived 1 tab');
  });

  it('says both when one batch did both', () => {
    expect(undoToastText(automated(3, 1))).toBe('Moved 3 tabs to Sleeping and archived 1');
    expect(undoToastText(automated(1, 12))).toBe('Moved 1 tab to Sleeping and archived 12');
  });

  it('says a batch with nothing in it plainly rather than "Moved 0 tabs"', () => {
    expect(undoToastText(automated(0, 0))).toBe('Tabs were moved');
  });

  it("gives the user's own move without a count", () => {
    expect(undoToastText(manual(1, 0))).toBe('Moved to Sleeping');
    expect(undoToastText(manual(0, 1))).toBe('Archived');
  });

  it("covers a user's move that did both, and one that did neither", () => {
    expect(undoToastText(manual(1, 1))).toBe('Moved to Sleeping and archived');
    expect(undoToastText(manual(0, 0))).toBe('Moved');
  });
});

describe('button names', () => {
  it('are plain', () => {
    expect(UNDO_LABEL).toBe('Undo');
    expect(DISMISS_UNDO_LABEL).toBe('Dismiss undo');
  });
});
