// Keeps addresses out of the log while diagnostic logging is off (assessment §6.6, M6.1). Field
// names alone aren't enough: an error's message, a Chromium reason or a page-supplied scheme is
// free text, and it can hold an address (an `openExternal` failure names the URL it couldn't
// open). So every string value is scrubbed word by word: a word that looks like an address, a
// path or a host is replaced with "[hidden]". It errs on the side of hiding, since a log loses
// little when a stray file name or `a.b` token goes. Our own method and command names are kept:
// they look like host names (`session.save`) and are what makes a log useful. Pure.
import { COMMAND_NAMES } from '../../shared/contracts/ipc';
import { DATA_METHODS } from '../../shared/contracts/data-rpc';

/** What an address is written as while diagnostic logging is off. */
export const HIDDEN = '[hidden]';

/** Dotted names that are ours, never the user's: data-worker methods and shell commands. */
const OWN_NAMES: ReadonlySet<string> = new Set<string>([
  ...COMMAND_NAMES,
  ...Object.keys(DATA_METHODS),
]);

/** Wrapping characters peeled off a word before it is judged, and kept around "[hidden]". */
const LEADING = /^[("'`[{<]+/u;
const TRAILING = /[)"'`\]}>,;.!?:]+$/u;

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

/** Whether a word (wrapping punctuation already peeled) is an address, a path or a host. */
export function isAddressLike(word: string): boolean {
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

/** The text with every address-like word replaced with "[hidden]", keeping what wraps it. */
export function scrubAddresses(text: string): string {
  return text
    .split(/(\s+)/u)
    .map((part) => {
      const leading = LEADING.exec(part)?.[0] ?? '';
      const rest = part.slice(leading.length);
      const trailing = TRAILING.exec(rest)?.[0] ?? '';
      const word = rest.slice(0, rest.length - trailing.length);
      if (isAddressLike(word)) {
        return `${leading}${HIDDEN}${trailing}`;
      }
      // What looked like trailing punctuation can be part of it (`fe80::`).
      return isAddressLike(rest) ? `${leading}${HIDDEN}` : part;
    })
    .join('');
}
