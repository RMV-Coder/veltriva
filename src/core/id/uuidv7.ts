// UUIDv7 (RFC 9562): a 48-bit Unix-millisecond timestamp followed by random bits, so ids sort by
// creation time. Pure: the caller supplies the clock and the randomness, so tests are exact.

const RANDOM_BYTES = 10;

export function uuidv7(unixMs: number, random: Uint8Array): string {
  if (!Number.isInteger(unixMs) || unixMs < 0 || unixMs >= 2 ** 48) {
    throw new RangeError('unixMs must be a whole number of milliseconds that fits in 48 bits');
  }
  if (random.length < RANDOM_BYTES) {
    throw new RangeError(`uuidv7 needs ${String(RANDOM_BYTES)} random bytes`);
  }
  const randomByte = (index: number): number => random[index] ?? 0;

  const bytes = new Uint8Array(16);
  // Big-endian timestamp. Division, not bit shifts: JavaScript shifts are 32-bit.
  let remaining = unixMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (randomByte(0) & 0x0f); // version 7
  bytes[7] = randomByte(1);
  bytes[8] = 0x80 | (randomByte(2) & 0x3f); // variant 0b10
  for (let index = 9; index < 16; index += 1) {
    bytes[index] = randomByte(index - 6);
  }

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
