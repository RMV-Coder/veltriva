import { describe, expect, it } from 'vitest';

import { suggestionsAnnouncement } from './suggestion-display';

describe('suggestionsAnnouncement (M6.2)', () => {
  it('says how many suggestions there are, and how to reach them', () => {
    expect(suggestionsAnnouncement(true, 1)).toBe('1 suggestion. Use Up and Down to choose.');
    expect(suggestionsAnnouncement(true, 6)).toBe('6 suggestions. Use Up and Down to choose.');
  });

  it('says nothing while the list is closed or empty', () => {
    expect(suggestionsAnnouncement(false, 4)).toBe('');
    expect(suggestionsAnnouncement(true, 0)).toBe('');
  });
});
