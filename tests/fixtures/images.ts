// Images built in code, so a fixture is valid by construction. The favicon specs need a PNG that
// Chromium decodes, and one that is too big to be accepted (the limit is 64 KB, threat T5).
import { crc32, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The most a favicon may weigh (src/main/tabs/favicon-format.ts). Hard-coded: this is a fixture. */
const FAVICON_LIMIT_BYTES = 64 * 1024;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** A solid-color square PNG (8-bit RGBA). The default is a visible, opaque blue 16x16 icon. */
export function buildPng(
  size = 16,
  rgba: readonly [number, number, number, number] = [0, 90, 200, 255],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  // Compression, filter and interlace methods stay 0.

  // Each row starts with a filter-type byte (0 = none), then one RGBA pixel per column.
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x += 1) {
    row.set(rgba, 1 + x * 4);
  }
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A PNG with a valid start whose size is over the favicon limit. A comment chunk (tEXt) of
 * incompressible-looking filler pads it, so the file stays a well-formed PNG.
 */
export function buildOversizedPng(): Buffer {
  const png = buildPng();
  const iend = png.subarray(png.length - 12);
  const rest = png.subarray(0, png.length - 12);
  const filler = Buffer.concat([
    Buffer.from('Comment\0', 'latin1'),
    Buffer.alloc(FAVICON_LIMIT_BYTES, 0x61),
  ]);
  return Buffer.concat([rest, chunk('tEXt', filler), iend]);
}
