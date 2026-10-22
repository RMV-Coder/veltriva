import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MAX_TITLE_RANGES, titleHasEveryWord, titleRanges } from './highlight';
import type { TextRange } from './highlight';
import { parseSearchInput } from './query';

/** The text each range marks, read from the original title. */
function marked(title: string, words: readonly string[]): string[] {
  return titleRanges(title, words).map(([start, end]) => title.slice(start, end));
}

describe('titleRanges', () => {
  describe('where a word marks', () => {
    it('marks a word at the start of a title word, and only that part of it', () => {
      expect(titleRanges('Postgres Indexes', ['index'])).toEqual([[9, 14]]);
      expect(marked('Postgres Indexes', ['index'])).toEqual(['Index']);
    });

    it('marks the first word of the title', () => {
      expect(titleRanges('Index tuning', ['index'])).toEqual([[0, 5]]);
    });

    it('marks a whole word when the word is the whole title word', () => {
      expect(marked('Postgres Indexes', ['indexes'])).toEqual(['Indexes']);
    });

    it('does not mark a word in the middle of a title word', () => {
      expect(titleRanges('Indexes', ['dex'])).toEqual([]);
      expect(titleRanges('Postgres Indexes', ['dex'])).toEqual([]);
      expect(titleRanges('Indexes', ['ndexes'])).toEqual([]);
    });

    it('does not mark the end of a title word', () => {
      expect(titleRanges('Indexes', ['xes'])).toEqual([]);
    });

    it.each([
      ['foo-index', 'a hyphen'],
      ['foo_index', 'an underscore'],
      ['foo/index', 'a slash'],
      ['foo.index', 'a dot'],
      ['(index)', 'brackets'],
      ["foo's index", 'a space after an apostrophe'],
      ['foo index', 'a no-break space'],
      ['foo\u{1F680}index', 'an emoji'],
    ])('starts a word after %j, which has %s before it', (title) => {
      expect(marked(title, ['index'])).toEqual(['index']);
    });

    it.each([
      ['fooindex', 'a letter'],
      ['foo1index', 'a digit'],
      ['fooindex', 'a private-use letter'],
      ['\u{10428}index', 'a letter outside the BMP'],
      ['東index', 'a CJK letter'],
    ])('does not start a word after %j, which has %s before it', (title) => {
      expect(titleRanges(title, ['index'])).toEqual([]);
    });

    it('marks a number the way it marks a word', () => {
      expect(marked('Top 10 results of 2010', ['10'])).toEqual(['10']);
      expect(titleRanges('Top 10 results of 2010', ['10'])).toEqual([[4, 6]]);
    });

    it('marks a CJK word at the start of the title and after a space', () => {
      expect(marked('東京タワー 東京', ['東京'])).toEqual(['東京', '東京']);
    });

    it('does not mark inside a run of CJK letters, which have no spaces between words', () => {
      expect(titleRanges('大東京', ['東京'])).toEqual([]);
    });
  });

  describe('case and diacritics', () => {
    it('ignores the case of the title', () => {
      expect(titleRanges('INDEX', ['index'])).toEqual([[0, 5]]);
      expect(marked('PostgreSQL', ['postgres'])).toEqual(['PostgreS']);
    });

    it('marks the original text, not the folded text', () => {
      expect(marked('Café', ['cafe'])).toEqual(['Café']);
      expect(marked('Crème Brûlée', ['creme', 'brulee'])).toEqual(['Crème', 'Brûlée']);
    });

    it('matches a precomposed letter and a decomposed one alike', () => {
      expect(marked('Café au lait', ['cafe'])).toEqual(['Café']);
      expect(titleRanges('Café', ['cafe'])).toEqual([[0, 4]]);
    });

    it('matches a Turkish capital I with a dot to an i', () => {
      expect(marked('İstanbul Guide', ['istan'])).toEqual(['İstan']);
      expect(titleRanges('İstanbul Guide', ['istan'])).toEqual([[0, 5]]);
    });

    it('does not fold a sharp s to double s', () => {
      expect(marked('Straße 12', ['straße'])).toEqual(['Straße']);
      expect(titleRanges('Straße 12', ['strasse'])).toEqual([]);
    });

    it('takes folded words: it does not fold them again', () => {
      expect(titleRanges('Index', ['Index'])).toEqual([]);
      expect(titleRanges('Café', ['café'])).toEqual([]);
    });

    it('works with the words the search gives it', () => {
      const { words } = parseSearchInput('CAFÉ Crème');

      expect(marked('Café de la Crème', words)).toEqual(['Café', 'Crème']);
    });

    it('marks capital letters outside the BMP from their lower-case words', () => {
      const title = '\u{10400}\u{10401} x \u{10400}\u{10401}';

      expect(titleRanges(title, ['\u{10428}\u{10429}'])).toEqual([
        [0, 4],
        [7, 11],
      ]);
    });
  });

  describe('several words', () => {
    it('marks each word at its place, in title order', () => {
      expect(titleRanges('Postgres Index Tuning', ['postgres', 'tuning'])).toEqual([
        [0, 8],
        [15, 21],
      ]);
    });

    it('gives the same ranges whatever the order of the words', () => {
      const title = 'Postgres Index Tuning Guide';

      expect(titleRanges(title, ['guide', 'index', 'postgres'])).toEqual(
        titleRanges(title, ['postgres', 'index', 'guide']),
      );
    });

    it('merges ranges that overlap into the longer one', () => {
      expect(titleRanges('Indexes', ['index', 'indexes'])).toEqual([[0, 7]]);
      expect(titleRanges('Indexes', ['indexes', 'index'])).toEqual([[0, 7]]);
      expect(titleRanges('Indexes', ['in', 'ind', 'index'])).toEqual([[0, 5]]);
    });

    it('merges ranges that touch', () => {
      // Words from the search never end on a space, so this is the only way two ranges meet.
      expect(titleRanges('foo bar', ['foo ', 'bar'])).toEqual([[0, 7]]);
    });

    it('keeps ranges that do not touch apart', () => {
      expect(titleRanges('foo bar', ['foo', 'bar'])).toEqual([
        [0, 3],
        [4, 7],
      ]);
    });

    it('marks a word given twice once', () => {
      expect(titleRanges('Index', ['index', 'index'])).toEqual([[0, 5]]);
    });

    it('marks every occurrence of a word', () => {
      const title = 'index of index of index';

      expect(titleRanges(title, ['index'])).toEqual([
        [0, 5],
        [9, 14],
        [18, 23],
      ]);
      expect(marked(title, ['index'])).toEqual(['index', 'index', 'index']);
    });

    it('marks the occurrences that start a word and not the ones that do not', () => {
      expect(titleRanges('dexdex dex', ['dex'])).toEqual([
        [0, 3],
        [7, 10],
      ]);
    });

    it('marks a word that is also the start of another', () => {
      expect(marked('ab abc abcd', ['ab'])).toEqual(['ab', 'ab', 'ab']);
    });
  });

  describe('offsets', () => {
    it('counts UTF-16 units of the title, not characters, before a match', () => {
      const title = '\u{1F680} Rocket launch';

      expect(titleRanges(title, ['rocket'])).toEqual([[3, 9]]);
      expect(marked(title, ['rocket', 'launch'])).toEqual(['Rocket', 'launch']);
    });

    it('counts two emoji before a match', () => {
      const title = '\u{1F680}\u{1F525} index';

      expect(titleRanges(title, ['index'])).toEqual([[5, 10]]);
      expect(marked(title, ['index'])).toEqual(['index']);
    });

    it('starts a word right after an emoji', () => {
      expect(titleRanges('\u{1F680}bc', ['bc'])).toEqual([[2, 4]]);
    });

    it('does not start a word right after a letter outside the BMP', () => {
      // 𐐨bc bc: the first bc follows a letter, the second a space.
      expect(titleRanges('\u{10428}bc bc', ['bc'])).toEqual([[5, 7]]);
    });

    it('marks a word made of characters outside the BMP as a whole', () => {
      const title = 'x \u{20BB7}\u{91CE}家';

      expect(titleRanges(title, ['\u{20BB7}\u{91CE}'])).toEqual([[2, 5]]);
      expect(marked(title, ['\u{20BB7}\u{91CE}'])).toEqual(['\u{20BB7}\u{91CE}']);
    });

    it('marks through a combining mark inside the match', () => {
      const title = 'éclair au chocolat';

      expect(titleRanges(title, ['eclair'])).toEqual([[0, 7]]);
      expect(marked(title, ['eclair'])).toEqual(['éclair']);
    });

    it('marks through a combining mark inside a longer word', () => {
      expect(marked('Cafés', ['cafes'])).toEqual(['Cafés']);
    });

    it('counts a decomposed accent in the offsets of what follows', () => {
      const title = 'Café au lait';

      expect(titleRanges(title, ['au'])).toEqual([[6, 8]]);
      expect(titleRanges(title, ['lait'])).toEqual([[9, 13]]);
      expect(marked(title, ['au', 'lait'])).toEqual(['au', 'lait']);
    });

    it('does not mark the letters before a combining mark that is outside the match', () => {
      expect(marked('Café', ['caf'])).toEqual(['Caf']);
    });

    it('does not start a word at a combining mark', () => {
      expect(titleRanges('́̂', ['a'])).toEqual([]);
    });

    // BUG (src/core/search/highlight.ts, `foldWithMap`): a combining mark folds to nothing, so it
    // has no folded unit and a match that ends on its base letter ends before the mark. The
    // range cuts the grapheme in two: <mark>Cafe</mark>◌́. It should extend over the marks that
    // follow the last matched letter.
    it('marks the combining marks that follow the last letter of a match', () => {
      const title = 'Café au lait';

      expect(titleRanges(title, ['cafe'])).toEqual([[0, 5]]);
      expect(marked(title, ['cafe'])).toEqual(['Café']);
    });

    it('does not cut a decomposed letter off its accent in the middle of the title', () => {
      expect(marked('Amélie', ['ame'])).toEqual(['Amé']);
    });
  });

  describe('what it does not mark', () => {
    it('gives nothing for an empty title', () => {
      expect(titleRanges('', ['index'])).toEqual([]);
    });

    it('gives nothing for no words', () => {
      expect(titleRanges('Postgres Indexes', [])).toEqual([]);
    });

    it('gives nothing for an empty word', () => {
      expect(titleRanges('Postgres Indexes', [''])).toEqual([]);
      expect(titleRanges('Postgres Indexes', ['', 'index'])).toEqual([[9, 14]]);
    });

    it('gives nothing for an empty title and no words', () => {
      expect(titleRanges('', [])).toEqual([]);
    });

    it('gives nothing for words that never match', () => {
      expect(titleRanges('Postgres Indexes', ['mysql', 'zzz'])).toEqual([]);
    });

    it('gives nothing for a word longer than the title', () => {
      expect(titleRanges('Index', ['indexes'])).toEqual([]);
    });

    it('gives nothing for a title of spaces and punctuation', () => {
      expect(titleRanges('  - ... -  ', ['a'])).toEqual([]);
    });

    it('does not match across two title words', () => {
      expect(titleRanges('post gres', ['postgres'])).toEqual([]);
    });

    it('marks a title that looks like HTML as plain text', () => {
      const title = '<b>bold</b>';

      expect(marked(title, ['bold'])).toEqual(['bold']);
      expect(titleRanges(title, ['bold'])).toEqual([[3, 7]]);
      expect(marked(title, ['b'])).toEqual(['b', 'b', 'b']);
    });
  });

  describe('the cap', () => {
    it('is 32', () => {
      expect(MAX_TITLE_RANGES).toBe(32);
    });

    it('gives the first 32 ranges of a title with more', () => {
      const title = 'ab '.repeat(40);
      const ranges = titleRanges(title, ['ab']);

      expect(ranges).toHaveLength(32);
      expect(ranges[0]).toEqual([0, 2]);
      expect(ranges[31]).toEqual([93, 95]);
    });

    it('gives all of 32', () => {
      expect(titleRanges('ab '.repeat(32), ['ab'])).toHaveLength(32);
    });

    it('gives 32 when there are 33', () => {
      expect(titleRanges('ab '.repeat(33), ['ab'])).toHaveLength(32);
    });

    it('counts ranges after merging, not before', () => {
      // 20 words, 2 matches each, merged to 20 ranges: under the cap.
      expect(titleRanges('ab '.repeat(20), ['a', 'ab'])).toHaveLength(20);
      expect(titleRanges('ab '.repeat(100), ['a', 'ab'])).toHaveLength(32);
    });

    it('keeps the ranges in order, so the cap drops the last ones', () => {
      const ranges = titleRanges('index '.repeat(100), ['index']);

      expect(ranges.map(([start]) => start)).toEqual(Array.from({ length: 32 }, (_, i) => i * 6));
    });
  });

  describe('for any title and words', () => {
    const PIECES = [
      'a',
      'b',
      'ab',
      'Ab',
      'AB',
      'É',
      'é',
      'é',
      '́',
      ' ',
      '-',
      '_',
      '\u{1F680}',
      '\u{10428}',
      '\u{10400}',
      'İ',
      'ß',
      '1',
      '東',
      '',
      '<b>',
    ];
    const FOLDED_WORDS = [
      'a',
      'b',
      'ab',
      'e',
      'i',
      'ss',
      'ß',
      '1',
      'abab',
      '東',
      '\u{10428}',
      'ae',
    ];
    const title = fc.array(fc.constantFrom(...PIECES), { maxLength: 60 }).map((p) => p.join(''));
    const words = fc.array(fc.constantFrom(...FOLDED_WORDS), { maxLength: 4 });

    it('gives sorted ranges, apart from each other, inside the title, at most 32', () => {
      fc.assert(
        fc.property(title, words, (text, wanted) => {
          const ranges = titleRanges(text, wanted);

          expect(ranges.length).toBeLessThanOrEqual(MAX_TITLE_RANGES);
          let previousEnd = -1;
          for (const [start, end] of ranges) {
            expect(start).toBeGreaterThan(previousEnd);
            expect(end).toBeGreaterThan(start);
            expect(end).toBeLessThanOrEqual(text.length);
            previousEnd = end;
          }
        }),
        { numRuns: 500 },
      );
    });

    it('never cuts a surrogate pair in two', () => {
      fc.assert(
        fc.property(title, words, (text, wanted) => {
          for (const [start, end] of titleRanges(text, wanted)) {
            const first = text.charCodeAt(start);
            const last = text.charCodeAt(end - 1);

            expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
            expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
          }
        }),
        { numRuns: 500 },
      );
    });

    it('marks something for a lone word exactly when the title has that word', () => {
      fc.assert(
        fc.property(title, fc.constantFrom(...FOLDED_WORDS), (text, word) => {
          expect(titleRanges(text, [word]).length > 0).toBe(titleHasEveryWord(text, [word]));
        }),
        { numRuns: 500 },
      );
    });

    it('marks at least what each word marks alone', () => {
      fc.assert(
        fc.property(title, words, (text, wanted) => {
          const together = titleRanges(text, wanted);
          if (together.length === MAX_TITLE_RANGES) {
            return;
          }
          for (const word of wanted) {
            for (const [start, end] of titleRanges(text, [word])) {
              expect(together.some(([from, to]: TextRange) => from <= start && end <= to)).toBe(
                true,
              );
            }
          }
        }),
        { numRuns: 500 },
      );
    });
  });

  // BUG (src/core/search/highlight.ts + query.ts): the title is folded one character at a time, but
  // the search words are folded as a whole string, and JavaScript lower-cases a capital sigma at
  // the end of a word to the final sigma ς. A title in capitals (ΟΔΟΣ) folds to ...σ and the
  // search for it (οδος, from foldText of the whole word) never matches.
  describe('Greek capitals with a final sigma', () => {
    it('marks an all-capitals Greek title for the same word typed in capitals', () => {
      const { words } = parseSearchInput('ΟΔΟΣ');

      expect(titleRanges('ΟΔΟΣ', words)).toEqual([[0, 4]]);
    });

    it('finds every word in an all-capitals Greek title', () => {
      const { words } = parseSearchInput('ΟΔΟΣ');

      expect(titleHasEveryWord('ΟΔΟΣ', words)).toBe(true);
    });

    it('marks a Greek title with a lower-case final sigma', () => {
      const { words } = parseSearchInput('Οδός');

      expect(marked('Οδός Αθηνών', words)).toEqual(['Οδός']);
    });
  });
});

describe('titleHasEveryWord', () => {
  it('is true when the one word starts a word of the title', () => {
    expect(titleHasEveryWord('Postgres Indexes', ['index'])).toBe(true);
  });

  it('is true when every word starts a word of the title', () => {
    expect(titleHasEveryWord('Postgres Indexes', ['index', 'postgres'])).toBe(true);
    expect(titleHasEveryWord('Postgres Indexes', ['postgres', 'index'])).toBe(true);
  });

  it('is false when one word is missing', () => {
    expect(titleHasEveryWord('Postgres Indexes', ['postgres', 'mysql'])).toBe(false);
    expect(titleHasEveryWord('Postgres Indexes', ['mysql'])).toBe(false);
  });

  it('is false when a word is only inside a title word', () => {
    expect(titleHasEveryWord('Postgres Indexes', ['dex'])).toBe(false);
    expect(titleHasEveryWord('Postgres Indexes', ['index', 'gres'])).toBe(false);
  });

  it('ignores case and Latin diacritics', () => {
    expect(titleHasEveryWord('CAFÉ Crème', ['cafe', 'creme'])).toBe(true);
    expect(titleHasEveryWord('Café au lait', ['cafe', 'lait'])).toBe(true);
    expect(titleHasEveryWord('İstanbul', ['istan'])).toBe(true);
  });

  it('is true when one title word satisfies two words', () => {
    expect(titleHasEveryWord('Indexes', ['in', 'index'])).toBe(true);
  });

  it('is true when the same word is given twice', () => {
    expect(titleHasEveryWord('Index', ['index', 'index'])).toBe(true);
  });

  it('does not need the words in the order of the title', () => {
    expect(titleHasEveryWord('Tuning Postgres Index', ['index', 'tuning'])).toBe(true);
  });

  it('is false for no words, which would otherwise be true of every title', () => {
    expect(titleHasEveryWord('Postgres Indexes', [])).toBe(false);
    expect(titleHasEveryWord('', [])).toBe(false);
  });

  it('is false for an empty word', () => {
    expect(titleHasEveryWord('Postgres', [''])).toBe(false);
    expect(titleHasEveryWord('Postgres', ['postgres', ''])).toBe(false);
  });

  it('is false for an empty title', () => {
    expect(titleHasEveryWord('', ['index'])).toBe(false);
  });

  it('is false for a title of the same letters in one word', () => {
    expect(titleHasEveryWord('postgres', ['post', 'gres'])).toBe(false);
  });

  it('counts a word after an emoji', () => {
    expect(titleHasEveryWord('\u{1F680}launch', ['launch'])).toBe(true);
  });

  it('counts a number', () => {
    expect(titleHasEveryWord('Top 10', ['top', '10'])).toBe(true);
    expect(titleHasEveryWord('Top 100', ['top', '10'])).toBe(true);
    expect(titleHasEveryWord('Top 2010', ['top', '10'])).toBe(false);
  });
});
