// How a search result's title is drawn: main sends the title and the ranges of its matched words
// ([start, end) in UTF-16 units, assessment §5.4), and the shell draws the matched parts in
// `<mark>` elements. The title is a page's text, so it only ever becomes text nodes: this turns it
// into plain segments and the component renders each as a string. Pure, so Vitest covers it.

export interface TextSegment {
  readonly text: string;
  /** The segment is a matched word: drawn in a `<mark>`. */
  readonly marked: boolean;
}

/** Controls and invisible formatting (bidi overrides and isolates, zero-width marks, tags). */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Replaces what must never reach the screen with spaces, one space per UTF-16 unit, so the ranges
 * main computed still fit the text. (The sidebar's `cleanText` also trims and collapses spaces,
 * which would move them.)
 */
export function neutralizeText(text: string): string {
  return text.replace(UNSAFE_TEXT, (found) => ' '.repeat(found.length));
}

export type MarkRange = readonly [start: number, end: number];

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The ranges as the text can take them: whole numbers inside the text, sorted, with overlapping
 * or touching ranges merged, empty ones dropped, and no edge in the middle of a surrogate pair
 * (the range grows to hold the character). Main's ranges already satisfy this; the shell does not
 * rely on it.
 */
export function normalizeRanges(text: string, ranges: readonly MarkRange[]): MarkRange[] {
  const length = text.length;
  const valid: [number, number][] = [];
  for (const [rawStart, rawEnd] of ranges) {
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      continue;
    }
    let start = Math.min(Math.max(Math.floor(rawStart), 0), length);
    let end = Math.min(Math.max(Math.ceil(rawEnd), 0), length);
    if (isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
      start -= 1;
    }
    if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      end += 1;
    }
    if (end > start) {
      valid.push([start, end]);
    }
  }
  valid.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: [number, number][] = [];
  for (const [start, end] of valid) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * The text cut into alternating plain and marked segments. The segments, put together, are the text
 * with its unsafe characters replaced (`neutralizeText`); none is empty. A text with no usable
 * range is one plain segment, and an empty text has none.
 */
export function splitMarks(text: string, ranges: readonly MarkRange[]): TextSegment[] {
  const safe = neutralizeText(text);
  if (safe.length === 0) {
    return [];
  }
  const segments: TextSegment[] = [];
  let at = 0;
  for (const [start, end] of normalizeRanges(safe, ranges)) {
    if (start > at) {
      segments.push({ text: safe.slice(at, start), marked: false });
    }
    segments.push({ text: safe.slice(start, end), marked: true });
    at = end;
  }
  if (at < safe.length) {
    segments.push({ text: safe.slice(at), marked: false });
  }
  return segments;
}
