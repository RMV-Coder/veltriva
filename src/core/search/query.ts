// The memory's search input (assessment §5.4). The user's words become an FTS5 MATCH expression
// that can only ever mean "every word, as the start of a word": each word is double-quoted and
// prefix-starred, `"postgre"* "index"*`, which FTS5 reads as quoted text, never as syntax. The
// characters FTS5 gives a meaning to (`"`, `*`, `^`, `:`, `(`, `)`, `+`, `-`, `{`, `}`, `,`) all
// separate words here, so none of them reaches the expression, and a word like NEAR, AND, OR or
// NOT is only quoted text.
//
// Words follow FTS5's unicode61 tokenizer (0001_init.sql): letters, numbers, marks and private-use
// characters make words, everything else separates them. Inside the quotes FTS5 tokenizes again
// with its own (Unicode 6.1) tables: where the two disagree, a word becomes a phrase of FTS5's
// words, which is still only text. A word FTS5 would see as empty (marks alone) is dropped,
// because one empty phrase in the implicit AND would match nothing.
//
// Pure, so every rule is unit-tested; the data worker runs it (src/data/repos/search.ts).

/** Full-text search needs a word of at least this many characters (S5: one is 17–79 ms at 50k). */
export const MIN_WORD_CHARS = 2;
/** The input is cut to this many characters: a search box, not a document. */
export const MAX_SEARCH_INPUT = 256;
/** At most this many words count. */
export const MAX_SEARCH_WORDS = 12;
/** A longer word is cut to its first characters, which is still a prefix of it. */
export const MAX_WORD_CHARS = 64;

const WORD = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;
const MARK = /\p{M}/gu;
/** What FTS5 keeps of a word: without its marks, something must be left. */
const KEPT = /[\p{L}\p{N}\p{Co}]/u;

export interface SearchQuery {
  /** The words, folded by `foldText`: what scoring and title marks compare. */
  readonly words: readonly string[];
  /**
   * The FTS5 MATCH expression, or null when no word has MIN_WORD_CHARS characters: the caller
   * shows the recent-and-frequent list instead.
   */
  readonly match: string | null;
}

/**
 * Lower case, without marks: close to FTS5's `remove_diacritics 2`, which folds Latin letters
 * (`Café` and `cafe` are one word). It is more lenient than FTS5 with other scripts' marks, which
 * only matters for marking titles and the exact-title bonus, never for which pages match.
 */
export function foldText(text: string): string {
  // A word-final capital sigma lowers to ς, a lone one to σ: one letter, folded alike, so a
  // title folded a character at a time still matches a word folded whole.
  return text
    .normalize('NFD')
    .replace(MARK, '')
    .toLowerCase()
    .replace(MARK, '')
    .replaceAll('ς', 'σ');
}

/** Characters, not UTF-16 units: an emoji or a CJK extension character counts once. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

function firstChars(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const char of text) {
    if (count === max) {
      break;
    }
    end += char.length;
    count += 1;
  }
  return text.slice(0, end);
}

/** The user's words as typed (NFC), without repeats, in order, at most MAX_SEARCH_WORDS. */
export function searchWords(input: string): string[] {
  const text = firstChars(input.normalize('NFC'), MAX_SEARCH_INPUT);
  const words: string[] = [];
  const seen = new Set<string>();
  for (const [raw] of text.matchAll(WORD)) {
    if (!KEPT.test(raw)) {
      continue;
    }
    const word = firstChars(raw, MAX_WORD_CHARS);
    const key = foldText(word);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    words.push(word);
    if (words.length === MAX_SEARCH_WORDS) {
      break;
    }
  }
  return words;
}

/**
 * The search for `input`. A word shorter than MIN_WORD_CHARS still counts for scoring and title
 * marks, but stays out of the MATCH: as a prefix, one character matches nearly every page. With no
 * longer word, `match` is null.
 */
export function parseSearchInput(input: string): SearchQuery {
  const words = searchWords(input);
  const long = words.filter((word) => charCount(word) >= MIN_WORD_CHARS);
  return {
    words: words.map(foldText),
    // A word holds no `"` (a separator), so quoting needs no escaping.
    match: long.length === 0 ? null : long.map((word) => `"${word}"*`).join(' '),
  };
}
