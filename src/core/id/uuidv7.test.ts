import { describe, expect, it } from 'vitest';

import { UUID_V7_PATTERN, uuidv7 } from './uuidv7';

const ZEROS = new Uint8Array(10);
const ONES = new Uint8Array(10).fill(0xff);

describe('uuidv7', () => {
  it('encodes the timestamp big-endian in the first 48 bits', () => {
    // 1792022400000 ms = 0x01a1_3cdb_cc00
    expect(uuidv7(1_792_022_400_000, ZEROS)).toBe('01a13cdb-cc00-7000-8000-000000000000');
  });

  it('sets the version and variant bits whatever the randomness', () => {
    expect(uuidv7(0, ONES)).toBe('00000000-0000-7fff-bfff-ffffffffffff');
    expect(uuidv7(0, ZEROS)).toMatch(UUID_V7_PATTERN);
    expect(uuidv7(0, ONES)).toMatch(UUID_V7_PATTERN);
  });

  it('sorts by creation time', () => {
    const earlier = uuidv7(1_000, ONES);
    const later = uuidv7(1_001, ZEROS);
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('handles the largest 48-bit timestamp', () => {
    expect(uuidv7(2 ** 48 - 1, ZEROS)).toBe('ffffffff-ffff-7000-8000-000000000000');
  });

  it.each([-1, 2 ** 48, 1.5, Number.NaN])('rejects the timestamp %s', (ms) => {
    expect(() => uuidv7(ms, ZEROS)).toThrow(RangeError);
  });

  it('rejects too little randomness', () => {
    expect(() => uuidv7(0, new Uint8Array(9))).toThrow(RangeError);
  });
});
