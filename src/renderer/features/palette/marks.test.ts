import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { neutralizeText, normalizeRanges, splitMarks } from './marks';
import type { MarkRange } from './marks';

/** A character by code point, so this file holds no invisible character itself. */
const char = (codePoint: number): string => String.fromCodePoint(codePoint);

const RIGHT_TO_LEFT_OVERRIDE = char(0x202e);
const ZERO_WIDTH_SPACE = char(0x200b);

describe('neutralizeText', () => {
  it('leaves ordinary text as it is', () => {
    expect(neutralizeText('PostgreSQL: Indexes — a ünïcode title')).toBe(
      'PostgreSQL: Indexes — a ünïcode title',
    );
  });

  it('replaces controls, bidi overrides and zero-width characters with spaces, one per unit', () => {
    expect(neutralizeText(`a${RIGHT_TO_LEFT_OVERRIDE}b${ZERO_WIDTH_SPACE}c\nd${char(0)}e`)).toBe(
      'a b c d e',
    );
    // A tag character is two UTF-16 units, so two spaces keep the ranges where they were.
    const tag = char(0xe0041);
    expect(tag).toHaveLength(2);
    expect(neutralizeText(`x${tag}y`)).toBe('x  y');
  });
});

describe('normalizeRanges', () => {
  it('keeps ranges that are already sorted and disjoint', () => {
    expect(
      normalizeRanges('hello big world', [
        [0, 5],
        [10, 15],
      ]),
    ).toEqual([
      [0, 5],
      [10, 15],
    ]);
  });

  it('sorts them', () => {
    expect(
      normalizeRanges('hello big world', [
        [10, 15],
        [0, 5],
      ]),
    ).toEqual([
      [0, 5],
      [10, 15],
    ]);
  });

  it('merges ranges that overlap or touch', () => {
    expect(
      normalizeRanges('abcdefghij', [
        [0, 3],
        [2, 5],
        [5, 6],
        [8, 9],
      ]),
    ).toEqual([
      [0, 6],
      [8, 9],
    ]);
  });

  it('drops empty, backwards and non-numeric ranges', () => {
    expect(
      normalizeRanges('abcdef', [
        [2, 2],
        [4, 1],
        [Number.NaN, 3],
        [1, Number.POSITIVE_INFINITY],
      ]),
    ).toEqual([]);
  });

  it('clamps ranges to the text', () => {
    expect(
      normalizeRanges('abcdef', [
        [-5, 2],
        [4, 99],
      ]),
    ).toEqual([
      [0, 2],
      [4, 6],
    ]);
    expect(normalizeRanges('abc', [[7, 9]])).toEqual([]);
  });

  it('rounds fractions outward', () => {
    expect(normalizeRanges('abcdef', [[1.5, 3.2]])).toEqual([[1, 4]]);
  });

  it('never leaves an edge between the two halves of a surrogate pair', () => {
    const text = `a${char(0x1f600)}b`; // a, two units, b
    expect(text).toHaveLength(4);
    expect(normalizeRanges(text, [[2, 4]])).toEqual([[1, 4]]);
    expect(normalizeRanges(text, [[0, 2]])).toEqual([[0, 3]]);
    expect(normalizeRanges(text, [[1, 3]])).toEqual([[1, 3]]);
  });
});

describe('splitMarks', () => {
  it('is one plain segment when nothing matched', () => {
    expect(splitMarks('PostgreSQL Documentation', [])).toEqual([
      { text: 'PostgreSQL Documentation', marked: false },
    ]);
  });

  it('is nothing for an empty text', () => {
    expect(splitMarks('', [])).toEqual([]);
    expect(splitMarks('', [[0, 3]])).toEqual([]);
  });

  it('marks a range at the start, in the middle and at the end', () => {
    expect(splitMarks('postgres index guide', [[0, 8]])).toEqual([
      { text: 'postgres', marked: true },
      { text: ' index guide', marked: false },
    ]);
    expect(splitMarks('postgres index guide', [[9, 14]])).toEqual([
      { text: 'postgres ', marked: false },
      { text: 'index', marked: true },
      { text: ' guide', marked: false },
    ]);
    expect(splitMarks('postgres index guide', [[15, 20]])).toEqual([
      { text: 'postgres index ', marked: false },
      { text: 'guide', marked: true },
    ]);
  });

  it('marks several words', () => {
    expect(
      splitMarks('PostgreSQL: Indexes', [
        [0, 10],
        [12, 19],
      ]),
    ).toEqual([
      { text: 'PostgreSQL', marked: true },
      { text: ': ', marked: false },
      { text: 'Indexes', marked: true },
    ]);
  });

  it('marks the whole text', () => {
    expect(splitMarks('abc', [[0, 3]])).toEqual([{ text: 'abc', marked: true }]);
  });

  it('keeps markup as plain text: nothing is interpreted', () => {
    const title = '<img src=x onerror=alert(1)> match';
    expect(splitMarks(title, [[29, 34]])).toEqual([
      { text: '<img src=x onerror=alert(1)> ', marked: false },
      { text: 'match', marked: true },
    ]);
  });

  it('hides bidi overrides without moving the marks', () => {
    // The override would reverse what follows it; it is a space now, and "world" is still marked.
    expect(splitMarks(`hello${RIGHT_TO_LEFT_OVERRIDE} world`, [[7, 12]])).toEqual([
      { text: 'hello  ', marked: false },
      { text: 'world', marked: true },
    ]);
  });

  it('puts the segments back together as the (neutralized) text, whatever the ranges are', () => {
    const range = fc.tuple(fc.integer({ min: -5, max: 60 }), fc.integer({ min: -5, max: 60 }));
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), fc.array(range, { maxLength: 8 }), (text, raw) => {
        const ranges: MarkRange[] = raw;
        const segments = splitMarks(text, ranges);
        expect(segments.map((segment) => segment.text).join('')).toBe(neutralizeText(text));
        // No empty segment, and plain and marked alternate.
        for (const [index, segment] of segments.entries()) {
          expect(segment.text.length).toBeGreaterThan(0);
          if (index > 0) {
            expect(segment.marked).not.toBe(segments[index - 1]?.marked);
          }
        }
      }),
    );
  });
});
