// Punycode (RFC 3492) decoding, to tell a real internationalised host label (`xn--bcher-kva`)
// from an `xn--` label that only looks like one (`xn--a`, `xn--`).
//
// The WHATWG URL parser should refuse invalid punycode, but how strictly depends on its version:
// Node 24.13's (ada 3.3) refuses `https://xn--a.com/`; Electron 45's Node 24.22 (ada 4.0) accepts
// it. The omnibox can't depend on which parser the runtime ships, so it checks the labels itself.
// Pure: no Node or browser APIs.

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 0x80;
const MAX_INT = 0x7fffffff;
const ACE_PREFIX = 'xn--';

/** The digit a code unit stands for (a–z 0–25, A–Z 0–25, 0–9 26–35), or -1. */
function digitOf(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30 + 26;
  }
  if (code >= 0x41 && code <= 0x5a) {
    return code - 0x41;
  }
  if (code >= 0x61 && code <= 0x7a) {
    return code - 0x61;
  }
  return -1;
}

function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

/**
 * Decodes the part of an ACE label after `xn--` (RFC 3492 §6.2). Returns null for input that
 * isn't valid punycode: a non-ASCII basic code point, a bad digit, a truncated number, an
 * overflow, or a result outside Unicode.
 */
export function decodePunycode(input: string): string | null {
  const output: number[] = [];
  const delimiter = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(delimiter, 0); j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) {
      return null;
    }
    output.push(code);
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  let index = delimiter > 0 ? delimiter + 1 : 0;
  while (index < input.length) {
    const oldI = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) {
        return null;
      }
      const digit = digitOf(input.charCodeAt(index));
      index += 1;
      if (digit < 0 || digit > Math.floor((MAX_INT - i) / w)) {
        return null;
      }
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) {
        break;
      }
      if (w > Math.floor(MAX_INT / (BASE - t))) {
        return null;
      }
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - oldI, length, oldI === 0);
    if (Math.floor(i / length) > MAX_INT - n) {
      return null;
    }
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
      return null;
    }
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

/** A C0 or C1 control character, which no host label may hold. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Whether an `xn--` label is a real internationalised label: it decodes, to something that isn't
 * empty, has at least one non-ASCII character (an all-ASCII label is never written as `xn--`),
 * and holds no control character. A label without the prefix is not judged here.
 */
export function isValidAceLabel(label: string): boolean {
  if (!label.toLowerCase().startsWith(ACE_PREFIX)) {
    return true;
  }
  const decoded = decodePunycode(label.slice(ACE_PREFIX.length));
  if (decoded === null || decoded === '') {
    return false;
  }
  const codes = Array.from(decoded, (char) => char.codePointAt(0) ?? 0);
  return codes.some((code) => code >= 0x80) && !codes.some(isControl);
}

/** Whether every `xn--` label of a host (as the URL parser writes it) is a real one. */
export function hasValidAceLabels(host: string): boolean {
  return host.split('.').every(isValidAceLabel);
}
