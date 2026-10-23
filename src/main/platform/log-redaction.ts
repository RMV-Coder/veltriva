// Keeps addresses out of the log while diagnostic logging is off (assessment §6.6, M6.1). Field
// names alone aren't enough: an error's message, a Chromium reason or a page-supplied scheme is
// free text, and it can hold an address (an `openExternal` failure names the URL it couldn't
// open). So every string value is scrubbed word by word: a word that looks like an address, a
// path or a host is replaced with "[hidden]". It errs on the side of hiding, since a log loses
// little when a stray file name or `a.b` token goes. Our own method and command names are kept:
// they look like host names (`session.save`) and are what makes a log useful. Pure.
//
// The text can be long and page-influenced, so the work is bounded (M6.2 review): a value is
// scrubbed up to MAX_SCRUBBED_CHARS and cut there; a word longer than MAX_WORD_CHARS is hidden
// without being judged; wrapping punctuation is peeled with loops over a character set, never an
// unanchored regex (`[…]+$` retried from every position was quadratic: 288 ms at 16k characters).
// Every regex below is anchored at both ends and runs only on a word of at most 256 characters.
import { COMMAND_NAMES } from '../../shared/contracts/ipc';
import { DATA_METHODS } from '../../shared/contracts/data-rpc';

/** What an address is written as while diagnostic logging is off. */
export const HIDDEN = '[hidden]';
/** A value is scrubbed up to this many characters; the rest is cut, with TRUNCATED after it. */
export const MAX_SCRUBBED_CHARS = 2048;
export const TRUNCATED = '…[truncated]';
/** A word longer than this is hidden outright: no address the log needs to keep is that long. */
export const MAX_WORD_CHARS = 256;

/** Dotted names that are ours, never the user's: data-worker methods and shell commands. */
const OWN_NAMES: ReadonlySet<string> = new Set<string>([
  ...COMMAND_NAMES,
  ...Object.keys(DATA_METHODS),
]);

/** Wrapping characters peeled off a word before it is judged, and kept around "[hidden]". */
const LEADING: ReadonlySet<string> = new Set(['(', '"', "'", '`', '[', '{', '<']);
const TRAILING: ReadonlySet<string> = new Set([
  ')',
  '"',
  "'",
  '`',
  ']',
  '}',
  '>',
  ',',
  ';',
  '.',
  '!',
  '?',
  ':',
]);

/** Chromium's network error names (`net::ERR_NAME_NOT_RESOLVED`): codes, not addresses. */
const NET_ERROR = /^net::ERR_[A-Z0-9_]+$/u;
/** `scheme:` followed by anything: https:, mailto:, file:, javascript:, and drive paths (C:\). */
const SCHEME = /^[a-z][a-z0-9+.-]*:\S/iu;
/** Paths, URLs without a scheme, and user@host or e-mail addresses. */
const PATH_OR_USER = /[\\/@]/u;
/** An IPv4 address, with an optional port. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/u;
/**
 * An IPv6 address, its opening bracket already peeled: hex groups, colons and dots (a mapped
 * IPv4), an optional zone (`%eth0`), and an optional `]:port`.
 */
const IPV6 = /^[0-9a-f:.]+(?:%[\p{L}\p{N}_.-]+)?(?:\](?::\d{1,5})?)?$/iu;
/**
 * A host name: two or more labels, the last starting with a letter and at least two characters
 * long (so `1.5` and `45.0.0` stay), in any script (`bücher.de`) or punycode, with an optional
 * trailing dot and port.
 */
const HOST =
  /^(?:[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?\.)+\p{L}[\p{L}\p{N}-]*[\p{L}\p{N}]\.?(?::\d{1,5})?$/u;

/**
 * Whether a word (wrapping punctuation already peeled) is an address, a path or a host. A word
 * over MAX_WORD_CHARS counts as one, unjudged.
 */
export function isAddressLike(word: string): boolean {
  if (word.length > MAX_WORD_CHARS) {
    return true;
  }
  if (word === '' || OWN_NAMES.has(word) || NET_ERROR.test(word)) {
    return false;
  }
  if (SCHEME.test(word) || PATH_OR_USER.test(word) || IPV4.test(word) || HOST.test(word)) {
    return true;
  }
  // `::1`, `2001:db8::1` and full eight-group forms; `12:30:00` stays.
  // An embedded IPv4 (`::ffff:1.2.3.4`) counts as two groups.
  const groups = word.split(':').length + (word.includes('.') ? 1 : 0);
  return IPV6.test(word) && (word.includes('::') || groups >= 8);
}

/** One word with its wrapping punctuation apart: `leading + word + trailing === part`. */
function peel(part: string): { leading: string; word: string; trailing: string } {
  let start = 0;
  while (start < part.length && LEADING.has(part.charAt(start))) {
    start += 1;
  }
  let end = part.length;
  while (end > start && TRAILING.has(part.charAt(end - 1))) {
    end -= 1;
  }
  return {
    leading: part.slice(0, start),
    word: part.slice(start, end),
    trailing: part.slice(end),
  };
}

/**
 * The text with every address-like word replaced with "[hidden]", keeping what wraps it. Text past
 * MAX_SCRUBBED_CHARS is cut, so the work stays small whatever the field holds.
 */
export function scrubAddresses(text: string): string {
  if (text.length > MAX_SCRUBBED_CHARS) {
    // The marker goes on after the scrub, apart, so it can't join the cut word and shield it.
    return `${scrubAddresses(text.slice(0, MAX_SCRUBBED_CHARS))} ${TRUNCATED}`;
  }
  return text
    .split(/(\s+)/u)
    .map((part) => {
      const { leading, word, trailing } = peel(part);
      if (isAddressLike(word)) {
        return `${leading}${HIDDEN}${trailing}`;
      }
      // What looked like trailing punctuation can be part of it (`fe80::`).
      return isAddressLike(word + trailing) ? `${leading}${HIDDEN}` : part;
    })
    .join('');
}
