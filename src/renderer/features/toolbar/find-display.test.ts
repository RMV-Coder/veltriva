import { describe, expect, it } from 'vitest';

import { canStepMatches, findCountText } from './find-display';

describe('findCountText', () => {
  it('shows the active match out of all matches', () => {
    expect(findCountText({ text: 'cat', activeMatch: 2, matches: 5 })).toBe('2 of 5');
    expect(findCountText({ text: 'cat', activeMatch: 1, matches: 1 })).toBe('1 of 1');
    expect(findCountText({ text: 'a', activeMatch: 120, matches: 1043 })).toBe('120 of 1043');
  });

  it('says there are no results when the search found nothing', () => {
    expect(findCountText({ text: 'zebra', activeMatch: 0, matches: 0 })).toBe('No results');
  });

  it('shows nothing while there is no search', () => {
    expect(findCountText({ text: '', activeMatch: 0, matches: 0 })).toBe('');
  });

  it('shows nothing for an empty search, whatever count is left over from before', () => {
    expect(findCountText({ text: '', activeMatch: 2, matches: 5 })).toBe('');
  });

  it('treats a search for spaces as a search', () => {
    expect(findCountText({ text: ' ', activeMatch: 0, matches: 0 })).toBe('No results');
    expect(findCountText({ text: ' ', activeMatch: 3, matches: 40 })).toBe('3 of 40');
  });

  it('counts the matches when none is highlighted yet', () => {
    expect(findCountText({ text: 'cat', activeMatch: 0, matches: 5 })).toBe('5 matches');
    expect(findCountText({ text: 'cat', activeMatch: 0, matches: 1 })).toBe('1 match');
  });
});

describe('canStepMatches', () => {
  it('is true when there is a match to step to', () => {
    expect(canStepMatches({ matches: 1 })).toBe(true);
    expect(canStepMatches({ matches: 12 })).toBe(true);
  });

  it('is false when there is none', () => {
    expect(canStepMatches({ matches: 0 })).toBe(false);
  });
});
