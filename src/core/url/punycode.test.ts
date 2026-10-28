import { describe, expect, it } from 'vitest';

import { decodePunycode, hasValidAceLabels, isValidAceLabel } from './punycode';

describe('decodePunycode (RFC 3492)', () => {
  it.each([
    ['bcher-kva', 'bücher'],
    ['mnchen-3ya', 'münchen'],
    ['pple-43d', '\u{430}pple'],
    ['ls8h', '\u{1f4a9}'],
    ['p1ai', 'рф'],
    ['wgv71a119e', '日本語'],
    ['r8jz45g', '例え'],
    // RFC 3492 §7.1 sample (A), Arabic (Egyptian).
    ['egbpdaj6bu4bxfgehfvwxn', 'ليهمابتكلموشعربي؟'],
    // RFC 3492 §7.1 sample (L), mixed scripts: 3<nen>B<gumi><kinpachi><sensei>.
    ['3B-ww4c5e180e575a65lsy2b', '3年B組金八先生'],
  ])('decodes %s to %s', (encoded, decoded) => {
    expect(decodePunycode(encoded)).toBe(decoded);
  });

  it('decodes what the URL parser accepts but no IDN can be', () => {
    // A lone "a" encodes U+0080, a C1 control.
    expect(decodePunycode('a')).toBe('\u{80}');
    expect(decodePunycode('')).toBe('');
  });

  it.each([
    ['a non-ASCII basic code point', 'bü-kva'],
    ['a character that is no digit', 'abc!'],
    ['a number cut short', 'bcher-kv9'],
    ['an overflow', '99999999999999'],
  ])('refuses %s', (_why, encoded) => {
    expect(decodePunycode(encoded)).toBeNull();
  });
});

describe('isValidAceLabel', () => {
  it('accepts real internationalised labels, in either case', () => {
    expect(isValidAceLabel('xn--bcher-kva')).toBe(true);
    expect(isValidAceLabel('XN--PPLE-43D')).toBe(true);
    expect(isValidAceLabel('xn--ls8h')).toBe(true);
  });

  it('leaves labels without the prefix alone', () => {
    expect(isValidAceLabel('example')).toBe(true);
    expect(isValidAceLabel('')).toBe(true);
  });

  it.each([
    ['nothing after the prefix', 'xn--'],
    ['a control character', 'xn--a'],
    ['only ASCII, which is never written as xn--', 'xn--abc-'],
    ['punycode that does not decode', 'xn--abc!'],
  ])('refuses %s', (_why, label) => {
    expect(isValidAceLabel(label)).toBe(false);
  });
});

describe('hasValidAceLabels', () => {
  it('judges every label of a host', () => {
    expect(hasValidAceLabels('www.xn--bcher-kva.de')).toBe(true);
    expect(hasValidAceLabels('example.xn--p1ai')).toBe(true);
    expect(hasValidAceLabels('example.com')).toBe(true);
    expect(hasValidAceLabels('xn--a.com')).toBe(false);
    expect(hasValidAceLabels('www.xn--.com')).toBe(false);
  });
});
