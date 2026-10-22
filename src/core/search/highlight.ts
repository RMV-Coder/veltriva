// Title marks for search results (assessment §5.4): where the user's words start a word of the
// title, as ranges of the title string. The UI renders each range as a <mark>, as text; a title is
// never interpreted as HTML. S5 found SQL's highlight() was 35–40% of a query's cost, so the data
// worker marks only the results it returns, here, in shared JS.
import { foldText } from './query';

/** [start, end) in UTF-16 units of the title as stored. */
export type TextRange = readonly [start: number, end: number];

/** At most this many ranges per title: a title of repeated words can't make a huge reply. */
export const MAX_TITLE_RANGES = 32;

const WORD_CHAR = /[\p{L}\p{N}\p{Co}]/u;

interface FoldedText {
  readonly text: string;
  /** For each UTF-16 unit of `text`, where its character starts and ends in the original. */
  readonly from: readonly number[];
  readonly to: readonly number[];
}

/** Folds character by character, remembering where each folded unit came from. */
function foldWithMap(original: string): FoldedText {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let offset = 0;
  for (const char of original) {
    const folded = foldText(char);
    if (folded.length === 0 && to.length > 0) {
      // A mark folds to nothing: it belongs to the letter before it, so a range that ends on
      // that letter ends after its marks (`Cafe` + U+0301 is marked whole).
      to[to.length - 1] = offset + char.length;
    }
    from.push(...new Array<number>(folded.length).fill(offset));
    to.push(...new Array<number>(folded.length).fill(offset + char.length));
    text += folded;
    offset += char.length;
  }
  return { text, from, to };
}

/** Does a word of the folded text start at `index`? */
function startsWord(text: string, index: number): boolean {
  const here = text.codePointAt(index);
  if (here === undefined || !WORD_CHAR.test(String.fromCodePoint(here))) {
    return false;
  }
  if (index === 0) {
    return true;
  }
  // The character before: one unit back, or two for a surrogate pair.
  const before = text.charCodeAt(index - 1);
  const start = before >= 0xdc00 && before <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  const previous = text.codePointAt(start);
  return previous === undefined || !WORD_CHAR.test(String.fromCodePoint(previous));
}

/** Where each folded word starts a word of the folded text. */
function* wordStarts(folded: FoldedText, word: string): Generator<[number, number]> {
  if (word.length === 0) {
    return;
  }
  for (
    let index = folded.text.indexOf(word);
    index !== -1;
    index = folded.text.indexOf(word, index + 1)
  ) {
    if (startsWord(folded.text, index)) {
      yield [folded.from[index] ?? 0, folded.to[index + word.length - 1] ?? 0];
    }
  }
}

/**
 * The ranges of `title` where one of `words` (folded, as SearchQuery.words) starts a word, sorted
 * and merged. Matching is by word start, as FTS5's prefix queries match.
 */
export function titleRanges(title: string, words: readonly string[]): TextRange[] {
  if (title.length === 0 || words.length === 0) {
    return [];
  }
  const folded = foldWithMap(title);
  const found: [number, number][] = [];
  for (const word of words) {
    for (const range of wordStarts(folded, word)) {
      found.push(range);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged.slice(0, MAX_TITLE_RANGES);
}

/** Does every word start a word of the title? (§5.4's `titleExact`.) */
export function titleHasEveryWord(title: string, words: readonly string[]): boolean {
  if (words.length === 0) {
    return false;
  }
  const folded = foldWithMap(title);
  return words.every((word) => !wordStarts(folded, word).next().done);
}
