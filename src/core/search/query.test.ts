import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  charCount,
  foldText,
  MAX_SEARCH_INPUT,
  MAX_SEARCH_WORDS,
  MAX_WORD_CHARS,
  MIN_WORD_CHARS,
  parseSearchInput,
  searchWords,
} from './query';
import type { SearchQuery } from './query';

/** The one shape a MATCH expression may have: quoted words, each prefix-starred, joined by a space. */
const SAFE_MATCH = /^"[^"]+"\*( "[^"]+"\*)*$/u;
/** Every character FTS5 gives a meaning to inside or outside quotes. */
const FTS5_SYNTAX = /["*^:(){}+\-,]/u;
const WORD_CHARS = /^[\p{L}\p{N}\p{M}\p{Co}]+$/u;
const FOLDED_WORD_CHARS = /^[\p{L}\p{N}\p{Co}]+$/u;

function termsOf(match: string): string[] {
  return match.slice(1, -2).split('"* "');
}

/** Everything the search box promises about an expression, whatever was typed. */
function expectSafe(query: SearchQuery): void {
  expect(query.words.length).toBeLessThanOrEqual(MAX_SEARCH_WORDS);
  for (const word of query.words) {
    expect(word).toMatch(FOLDED_WORD_CHARS);
  }
  if (query.match === null) {
    return;
  }

  expect(query.match).toMatch(SAFE_MATCH);
  const terms = termsOf(query.match);
  expect(terms.length).toBeGreaterThanOrEqual(1);
  expect(terms.length).toBeLessThanOrEqual(MAX_SEARCH_WORDS);
  // Two quotes and one star per term: no quote inside a term, no star but after a closing quote.
  expect(query.match.split('"').length - 1).toBe(terms.length * 2);
  expect(query.match.split('*').length - 1).toBe(terms.length);
  for (const term of terms) {
    expect(term).not.toMatch(FTS5_SYNTAX);
    expect(term).toMatch(WORD_CHARS);
    expect(term).toBe(term.normalize('NFC'));
    expect(charCount(term)).toBeGreaterThanOrEqual(MIN_WORD_CHARS);
    expect(charCount(term)).toBeLessThanOrEqual(MAX_WORD_CHARS);
  }
}

interface Row {
  readonly name: string;
  readonly input: string;
  readonly match: string | null;
  readonly words: readonly string[];
}

const A64 = 'a'.repeat(64);

const ADVERSARIAL: readonly Row[] = [
  // FTS5 operators and column filters
  {
    name: 'NEAR(a b) is the word NEAR and two letters',
    input: 'NEAR(a b)',
    match: '"NEAR"*',
    words: ['near', 'a', 'b'],
  },
  {
    name: 'NEAR(postgres index, 5) loses its group, its comma and its distance',
    input: 'NEAR(postgres index, 5)',
    match: '"NEAR"* "postgres"* "index"*',
    words: ['near', 'postgres', 'index', '5'],
  },
  {
    name: 'a NEAR/3 b has no distance operator left',
    input: 'a NEAR/3 b',
    match: '"NEAR"*',
    words: ['a', 'near', '3', 'b'],
  },
  { name: '-x is a lone letter', input: '-x', match: null, words: ['x'] },
  {
    name: '-postgres is not an exclusion',
    input: '-postgres',
    match: '"postgres"*',
    words: ['postgres'],
  },
  { name: 'a OR b quotes OR', input: 'a OR b', match: '"OR"*', words: ['a', 'or', 'b'] },
  {
    name: 'foo AND bar quotes AND',
    input: 'foo AND bar',
    match: '"foo"* "AND"* "bar"*',
    words: ['foo', 'and', 'bar'],
  },
  {
    name: 'NOT secret quotes NOT',
    input: 'NOT secret',
    match: '"NOT"* "secret"*',
    words: ['not', 'secret'],
  },
  {
    name: 'an unterminated quote is dropped',
    input: '"unterminated',
    match: '"unterminated"*',
    words: ['unterminated'],
  },
  { name: '"a" "b" is two single letters', input: '"a" "b"', match: null, words: ['a', 'b'] },
  {
    name: 'a quoted phrase becomes two words',
    input: '"exact phrase"',
    match: '"exact"* "phrase"*',
    words: ['exact', 'phrase'],
  },
  {
    name: 'post* loses its star to the one we add',
    input: 'post*',
    match: '"post"*',
    words: ['post'],
  },
  { name: 'post** is still one prefix', input: 'post**', match: '"post"*', words: ['post'] },
  { name: 'a lone star is nothing', input: '*', match: null, words: [] },
  {
    name: '^start loses its initial-token anchor',
    input: '^start',
    match: '"start"*',
    words: ['start'],
  },
  {
    name: 'title:foo has no column filter',
    input: 'title:foo',
    match: '"title"* "foo"*',
    words: ['title', 'foo'],
  },
  {
    name: '{title url}: foo has no column set',
    input: '{title url}: foo',
    match: '"title"* "url"* "foo"*',
    words: ['title', 'url', 'foo'],
  },
  {
    name: '- title : x has no negated filter',
    input: '- title : x',
    match: '"title"*',
    words: ['title', 'x'],
  },
  {
    name: 'col1 : x keeps the digit in col1',
    input: 'col1 : x',
    match: '"col1"*',
    words: ['col1', 'x'],
  },
  {
    name: '(a OR b) AND c has no grouping',
    input: '(a OR b) AND c',
    match: '"OR"* "AND"*',
    words: ['a', 'or', 'b', 'and', 'c'],
  },
  { name: '+plus is not a phrase joiner', input: '+plus', match: '"plus"*', words: ['plus'] },
  { name: 'a,b is two letters', input: 'a,b', match: null, words: ['a', 'b'] },
  { name: 'ab,cd is two words', input: 'ab,cd', match: '"ab"* "cd"*', words: ['ab', 'cd'] },
  {
    name: 'every FTS5 operator character on its own is nothing',
    input: '"*^:(){}+-,',
    match: null,
    words: [],
  },
  {
    name: 'operators around a word fall away',
    input: '"^:(){}+-,postgres*"',
    match: '"postgres"*',
    words: ['postgres'],
  },

  // SQL, escapes and quotes
  {
    name: 'a backslash splits a word',
    input: 'back\\slash',
    match: '"back"* "slash"*',
    words: ['back', 'slash'],
  },
  { name: 'backslashes alone are nothing', input: '\\\\\\', match: null, words: [] },
  {
    name: 'a backslash escape is only the letters after it',
    input: '\\u0022*',
    match: '"u0022"*',
    words: ['u0022'],
  },
  { name: 'two single quotes are nothing', input: "''", match: null, words: [] },
  { name: 'an apostrophe splits a word', input: "it's", match: '"it"*', words: ['it', 's'] },
  {
    name: 'a SQL injection attempt is only words',
    input: "'; DROP TABLE pages; --",
    match: '"DROP"* "TABLE"* "pages"*',
    words: ['drop', 'table', 'pages'],
  },
  {
    name: 'a tautology is a repeated digit',
    input: '" OR 1=1 --',
    match: '"OR"*',
    words: ['or', '1'],
  },
  {
    name: 'percent-encoding is digits',
    input: '10%25',
    match: '"10"* "25"*',
    words: ['10', '25'],
  },

  // Control characters and invisible characters
  {
    name: 'a NUL splits a word',
    input: 'foo\u0000bar',
    match: '"foo"* "bar"*',
    words: ['foo', 'bar'],
  },
  {
    name: 'control characters split a word',
    input: 'foo\u0001\u001f\u007fbar',
    match: '"foo"* "bar"*',
    words: ['foo', 'bar'],
  },
  {
    name: 'tabs and newlines are spaces',
    input: 'foo\tbar\nbaz\r\nqux',
    match: '"foo"* "bar"* "baz"* "qux"*',
    words: ['foo', 'bar', 'baz', 'qux'],
  },
  {
    name: 'a zero-width space splits a word',
    input: 'in​dex',
    match: '"in"* "dex"*',
    words: ['in', 'dex'],
  },
  {
    name: 'a zero-width joiner splits a word',
    input: 'ab‍cd',
    match: '"ab"* "cd"*',
    words: ['ab', 'cd'],
  },
  {
    name: 'a soft hyphen splits a word',
    input: 'co­operate',
    match: '"co"* "operate"*',
    words: ['co', 'operate'],
  },
  {
    name: 'a byte-order mark is nothing',
    input: '﻿postgres',
    match: '"postgres"*',
    words: ['postgres'],
  },
  {
    name: 'left-to-right and right-to-left marks split words',
    input: 'abc‏def‎',
    match: '"abc"* "def"*',
    words: ['abc', 'def'],
  },
  {
    name: 'a right-to-left override is nothing',
    input: '‮evil',
    match: '"evil"*',
    words: ['evil'],
  },
  {
    name: 'a lone surrogate splits a word',
    input: 'ab\uD800cd',
    match: '"ab"* "cd"*',
    words: ['ab', 'cd'],
  },
  {
    name: 'a trailing high surrogate is nothing',
    input: 'abc\uD83D',
    match: '"abc"*',
    words: ['abc'],
  },
  {
    name: 'full-width quotes and stars are not syntax and not letters',
    input: '＂ａｂ＂＊',
    match: '"ａｂ"*',
    words: ['ａｂ'],
  },

  // Symbols and emoji
  { name: 'emoji alone are nothing', input: '\u{1F680}\u{1F525}', match: null, words: [] },
  {
    name: 'an emoji between words splits them',
    input: 'rocket\u{1F680}ship',
    match: '"rocket"* "ship"*',
    words: ['rocket', 'ship'],
  },
  {
    name: 'a family emoji with joiners is nothing',
    input: '\u{1F468}‍\u{1F469}‍\u{1F467}',
    match: null,
    words: [],
  },
  { name: 'a flag is nothing', input: '\u{1F1F5}\u{1F1ED}', match: null, words: [] },
  {
    name: 'a keycap emoji is a digit with two marks, which is still text',
    input: '1️⃣',
    match: '"1️⃣"*',
    words: ['1'],
  },

  // Combining marks and normalization
  { name: 'a lone combining mark is nothing', input: '́', match: null, words: [] },
  {
    name: 'words made only of marks are dropped',
    input: '́̂ postgres',
    match: '"postgres"*',
    words: ['postgres'],
  },
  {
    name: 'a letter and its combining mark are one letter, which is too short',
    input: 'é',
    match: null,
    words: ['e'],
  },
  {
    name: 'a decomposed word is composed',
    input: 'café',
    match: '"café"*',
    words: ['cafe'],
  },
  {
    name: 'a mark after a space joins the word after it',
    input: 'a ́bc',
    match: '"́bc"*',
    words: ['a', 'bc'],
  },
  {
    name: 'a composed and a decomposed spelling are one word',
    input: 'café café',
    match: '"café"*',
    words: ['cafe'],
  },
  { name: 'a superscript digit is a number', input: 'x²', match: '"x²"*', words: ['x²'] },
  {
    name: 'private-use characters are letters',
    input: '',
    match: '""*',
    words: [''],
  },

  // Scripts
  {
    name: 'Japanese is one word',
    input: '東京タワー',
    match: '"東京タワー"*',
    words: ['東京タワー'],
  },
  {
    name: 'English and Chinese are two words',
    input: 'Tokyo 東京',
    match: '"Tokyo"* "東京"*',
    words: ['tokyo', '東京'],
  },
  {
    name: 'Arabic words stay as typed',
    input: 'مرحبا بالعالم',
    match: '"مرحبا"* "بالعالم"*',
    words: ['مرحبا', 'بالعالم'],
  },
  {
    name: 'Arabic vowel marks stay in the match and fold out of the words',
    input: 'مَرْحَبًا',
    match: '"مَرْحَبًا"*',
    words: ['مرحبا'],
  },
  {
    name: 'a Devanagari word keeps its vowel signs in the match and folds them out of the words',
    input: 'नमस्ते',
    match: '"नमस्ते"*',
    words: ['नमसत'],
  },
  {
    name: 'a capital Turkish I with a dot',
    input: 'İstanbul',
    match: '"İstanbul"*',
    words: ['istanbul'],
  },
  { name: 'German sharp s stays', input: 'Straße', match: '"Straße"*', words: ['straße'] },
  {
    name: 'a ligature is not expanded',
    input: 'ﬁle',
    match: '"ﬁle"*',
    words: ['ﬁle'],
  },
  {
    name: 'full-width letters are letters',
    input: 'ＰＯＳＴ',
    match: '"ＰＯＳＴ"*',
    words: ['ｐｏｓｔ'],
  },
  {
    name: 'one character outside the BMP is one character, too short on its own',
    input: '\u{20BB7}',
    match: null,
    words: ['\u{20BB7}'],
  },
  {
    name: 'two characters outside the BMP are enough',
    input: '\u{20BB7}\u{91CE}',
    match: '"\u{20BB7}\u{91CE}"*',
    words: ['\u{20BB7}\u{91CE}'],
  },

  // Real searches
  {
    name: 'upper case is kept in the match',
    input: 'POSTGRES',
    match: '"POSTGRES"*',
    words: ['postgres'],
  },
  { name: 'a decimal number is two words', input: '3.14', match: '"14"*', words: ['3', '14'] },
  { name: 'C++ is a lone letter', input: 'C++', match: null, words: ['c'] },
  {
    name: 'c programming drops the lone letter from the match',
    input: 'c programming',
    match: '"programming"*',
    words: ['c', 'programming'],
  },
  { name: 'node.js is two words', input: 'node.js', match: '"node"* "js"*', words: ['node', 'js'] },
  {
    name: 'an underscore splits a word',
    input: 'snake_case',
    match: '"snake"* "case"*',
    words: ['snake', 'case'],
  },
  {
    name: 'a whole address is its words',
    input: 'https://github.com/foo?bar=1&x=2',
    match: '"https"* "github"* "com"* "foo"* "bar"*',
    words: ['https', 'github', 'com', 'foo', 'bar', '1', 'x', '2'],
  },

  // Repeats
  {
    name: 'one word in three spellings is one word',
    input: 'Café cafe CAFE',
    match: '"Café"*',
    words: ['cafe'],
  },
  {
    name: 'the first spelling of a repeated word is the one that is kept',
    input: 'cafe Café',
    match: '"cafe"*',
    words: ['cafe'],
  },
  {
    name: 'sharp s and double s are different words',
    input: 'Straße STRASSE',
    match: '"Straße"* "STRASSE"*',
    words: ['straße', 'strasse'],
  },
  {
    name: 'repeats do not use up the twelve words',
    input: `${'aa '.repeat(30)}bb`,
    match: '"aa"* "bb"*',
    words: ['aa', 'bb'],
  },
  {
    name: 'two long words that agree for 64 characters are one word',
    input: `${A64}1 ${A64}2`,
    match: `"${A64}"*`,
    words: [A64],
  },

  // Lengths
  {
    name: 'single letters only give no match',
    input: 'a b c',
    match: null,
    words: ['a', 'b', 'c'],
  },
  { name: 'whitespace only is nothing', input: '   \t\n  ', match: null, words: [] },
  { name: 'the empty string is nothing', input: '', match: null, words: [] },
  {
    name: 'a 10,000-character word is cut to 64 characters',
    input: 'x'.repeat(10_000),
    match: `"${'x'.repeat(64)}"*`,
    words: ['x'.repeat(64)],
  },
  {
    name: 'a 100-character word is cut to 64 characters',
    input: 'y'.repeat(100),
    match: `"${'y'.repeat(64)}"*`,
    words: ['y'.repeat(64)],
  },
  {
    name: 'characters outside the BMP are cut as whole characters',
    input: '\u{20BB7}'.repeat(300),
    match: `"${'\u{20BB7}'.repeat(64)}"*`,
    words: ['\u{20BB7}'.repeat(64)],
  },
  {
    name: '10,000 characters of repeated words are two words',
    input: 'ab cdef '.repeat(1250),
    match: '"ab"* "cdef"*',
    words: ['ab', 'cdef'],
  },
  {
    name: '10,000 characters of different words keep the first twelve',
    input: Array.from({ length: 1500 }, (_, index) => `term${String(index)}`).join(' '),
    match:
      '"term0"* "term1"* "term2"* "term3"* "term4"* "term5"* "term6"* "term7"* "term8"* ' +
      '"term9"* "term10"* "term11"*',
    words: [
      'term0',
      'term1',
      'term2',
      'term3',
      'term4',
      'term5',
      'term6',
      'term7',
      'term8',
      'term9',
      'term10',
      'term11',
    ],
  },
  {
    name: 'twenty words keep the first twelve',
    input: Array.from({ length: 20 }, (_, index) => `word${String.fromCharCode(97 + index)}`).join(
      ' ',
    ),
    match:
      '"worda"* "wordb"* "wordc"* "wordd"* "worde"* "wordf"* "wordg"* "wordh"* "wordi"* ' +
      '"wordj"* "wordk"* "wordl"*',
    words: [
      'worda',
      'wordb',
      'wordc',
      'wordd',
      'worde',
      'wordf',
      'wordg',
      'wordh',
      'wordi',
      'wordj',
      'wordk',
      'wordl',
    ],
  },
  {
    name: 'the 256th character counts and the 257th does not',
    input: `${'a'.repeat(254)} bc`,
    match: `"${A64}"*`,
    words: [A64, 'b'],
  },
  {
    name: 'a word that ends on the 256th character is whole',
    input: `${'a'.repeat(253)} bc`,
    match: `"${A64}"* "bc"*`,
    words: [A64, 'bc'],
  },
];

describe('the adversarial inputs', () => {
  it('are at least forty', () => {
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(40);
  });

  it('have a distinct name each', () => {
    expect(new Set(ADVERSARIAL.map((row) => row.name)).size).toBe(ADVERSARIAL.length);
  });

  it.each(ADVERSARIAL)('$name', ({ input, match, words }) => {
    expect(parseSearchInput(input)).toEqual({ match, words });
  });

  it.each(ADVERSARIAL)('$name: and the expression is safe', ({ input }) => {
    expectSafe(parseSearchInput(input));
  });

  it.each(ADVERSARIAL)(
    '$name: and searching for its own terms gives the same search',
    ({ input }) => {
      const { match } = parseSearchInput(input);
      if (match === null) {
        return;
      }
      expect(parseSearchInput(termsOf(match).join(' ')).match).toBe(match);
    },
  );
});

/** Text that is mostly what an attacker would type, with some of what a person would. */
const SOUP = [
  'NEAR',
  'AND',
  'OR',
  'NOT',
  '"',
  '*',
  '^',
  ':',
  '(',
  ')',
  '+',
  '-',
  '{',
  '}',
  ',',
  ' ',
  '\t',
  '\n',
  '\\',
  "'",
  ';',
  'a',
  'b',
  'é',
  'é',
  '́',
  'postgres',
  'index',
  '東京',
  '\u{1F680}',
  '​',
  '­',
  '\u0000',
  'İ',
  'ß',
  'ﬁ',
  'Ａ',
  '\uD800',
  '\uDC00',
  '',
  '1',
];

const loneSurrogate = fc
  .integer({ min: 0xd800, max: 0xdfff })
  .map((unit) => String.fromCharCode(unit));

const anyInput: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.array(fc.constantFrom(...SOUP), { maxLength: 80 }).map((parts) => parts.join('')),
  },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 400 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'grapheme', maxLength: 120 }) },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.oneof(loneSurrogate, fc.string({ unit: 'binary', maxLength: 6 })), {
        maxLength: 60,
      })
      .map((parts) => parts.join('')),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', minLength: 250, maxLength: 1200 }) },
);

describe('whatever is typed', () => {
  it('gives an expression of quoted, prefix-starred words and nothing else', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        expectSafe(parseSearchInput(input));
      }),
      { numRuns: 600 },
    );
  });

  it('gives a match exactly when a word has two characters, with those words in order', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const long = searchWords(input).filter((word) => charCount(word) >= MIN_WORD_CHARS);
        const { match } = parseSearchInput(input);

        expect(match === null).toBe(long.length === 0);
        if (match !== null) {
          expect(termsOf(match)).toEqual(long);
        }
      }),
      { numRuns: 600 },
    );
  });

  it('gives words without repeats once folded', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const { words } = parseSearchInput(input);
        const typed = searchWords(input);

        expect(new Set(words).size).toBe(words.length);
        expect(words).toEqual(typed.map(foldText));
      }),
      { numRuns: 400 },
    );
  });

  it('is the same search when only its own terms are searched for', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const { match } = parseSearchInput(input);
        if (match === null) {
          return;
        }
        expect(parseSearchInput(termsOf(match).join(' ')).match).toBe(match);
      }),
      { numRuns: 400 },
    );
  });

  it('is the same search whichever Unicode form it was typed in', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const composed = parseSearchInput(input.normalize('NFC'));
        const decomposed = parseSearchInput(input.normalize('NFD'));

        // NFD can lengthen the text past the 256 characters the cut allows, so compare what both
        // forms found within the cut of the shorter one.
        if (charCount(input.normalize('NFD')) <= MAX_SEARCH_INPUT) {
          expect(decomposed).toEqual(composed);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('never grows what it keeps past the limits, however long the text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 1000, maxLength: 4000 }), (input) => {
        const { words, match } = parseSearchInput(input);

        expect(words.length).toBeLessThanOrEqual(MAX_SEARCH_WORDS);
        expect((match ?? '').length).toBeLessThanOrEqual(
          MAX_SEARCH_WORDS * (MAX_WORD_CHARS * 2 + 5),
        );
      }),
      { numRuns: 100 },
    );
  });
});

describe('the limits', () => {
  it('are the ones the search relies on', () => {
    expect(MIN_WORD_CHARS).toBe(2);
    expect(MAX_SEARCH_INPUT).toBe(256);
    expect(MAX_SEARCH_WORDS).toBe(12);
    expect(MAX_WORD_CHARS).toBe(64);
  });
});

describe('foldText', () => {
  it.each([
    ['Café', 'cafe'],
    ['CAFÉ', 'cafe'],
    ['café', 'cafe'],
    ['Crème Brûlée', 'creme brulee'],
    ['Ñandú', 'nandu'],
    ['Zürich', 'zurich'],
    ['Å', 'a'],
    ['Ế', 'e'],
    ['İstanbul', 'istanbul'],
    ['POSTGRES', 'postgres'],
    ['already lower', 'already lower'],
    ['Straße', 'straße'],
    ['東京タワー', '東京タワー'],
    ['ＰＯ', 'ｐｏ'],
    ['ﬁ', 'ﬁ'],
    ['́̂', ''],
    ['', ''],
  ])('folds %j to %j', (text, folded) => {
    expect(foldText(text)).toBe(folded);
  });

  it('does not change anything but case and marks', () => {
    expect(foldText('NEAR(a b) -x "q" *')).toBe('near(a b) -x "q" *');
  });

  it('folds a composed and a decomposed spelling to the same text', () => {
    expect(foldText('café')).toBe(foldText('café'));
    expect(foldText('Ångström')).toBe(foldText('Ångström'));
  });

  it('is its own fixed point for Latin text', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.integer({ min: 0x20, max: 0x24f }).map((code) => String.fromCodePoint(code)),
          maxLength: 40,
        }),
        (text) => {
          expect(foldText(foldText(text))).toBe(foldText(text));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('charCount', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['\u{1F680}', 1],
    ['\u{20BB7}', 1],
    ['a\u{1F680}b', 3],
    ['é', 2],
    ['\u{1F1F5}\u{1F1ED}', 2],
    ['\u{1F468}‍\u{1F469}‍\u{1F467}', 5],
    ['\uD800', 1],
    ['東京', 2],
  ])('counts %j as %i', (text, count) => {
    expect(charCount(text)).toBe(count);
  });

  it('counts a surrogate pair once although it is two UTF-16 units', () => {
    const rocket = '\u{1F680}';
    expect(rocket.length).toBe(2);
    expect(charCount(rocket)).toBe(1);
    expect(charCount(rocket.repeat(10))).toBe(10);
  });

  it('is the length of the code points for any text without lone surrogates', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 100 }), (text) => {
        expect(charCount(text)).toBe(Array.from(text).length);
      }),
      { numRuns: 200 },
    );
  });
});

describe('searchWords', () => {
  it('gives the words as typed, composed, without repeats, in order', () => {
    expect(searchWords('Postgres  Index, postgres')).toEqual(['Postgres', 'Index']);
    expect(searchWords('Café café')).toEqual(['Café']);
  });

  it('keeps one-character words, which parseSearchInput leaves out of the match', () => {
    expect(searchWords('c programming')).toEqual(['c', 'programming']);
  });

  it('gives nothing for text without a letter, number or private-use character', () => {
    expect(searchWords('"*^:(){}+-, \u{1F680}́')).toEqual([]);
  });

  it('cuts to 256 characters, 12 words and 64 characters a word', () => {
    expect(searchWords('x'.repeat(1000))).toEqual(['x'.repeat(64)]);
    expect(
      searchWords(Array.from({ length: 40 }, (_, index) => `w${String(index)}`).join(' ')),
    ).toHaveLength(12);
  });
});
