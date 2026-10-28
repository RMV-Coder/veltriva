// Draws Veltriva's app icon and writes build/icon.ico and build/icon.png (M6.3, ADR-0007), with no
// image tool or dependency, so the icon is reproducible from this file:
//   node scripts/make-icon.mjs
//
// The mark: a white "V" on a rounded square shaded from indigo to violet. Shapes are measured as
// distances and sampled 4×4 per pixel, so the edges are smooth at every size.
//
// The .ico holds 16, 20, 24, 32, 40, 48 and 64 px as 32-bit bitmaps (what NSIS and older shell
// views read best) and 128 and 256 px as PNG, as Windows' own icons do.
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const BITMAP_SIZES = [16, 20, 24, 32, 40, 48, 64];
const PNG_SIZES = [128, 256];
const SAMPLES = 4;

const TOP = [79, 70, 229]; // indigo
const BOTTOM = [124, 58, 237]; // violet

/** Distance from (x, y) to the segment a–b. */
function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Signed distance to a rounded square inset by `inset`, corner radius `radius` (unit square). */
function roundedSquare(x, y, inset, radius) {
  const half = 0.5 - inset;
  const qx = Math.abs(x - 0.5) - (half - radius);
  const qy = Math.abs(y - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** RGBA of the mark at a point of the unit square: [r, g, b, a] with a in 0..1. */
function shade(x, y) {
  if (roundedSquare(x, y, 0.04, 0.2) > 0) {
    return [0, 0, 0, 0];
  }
  const stroke = 0.065;
  const v = Math.min(
    segmentDistance(x, y, 0.29, 0.3, 0.5, 0.72),
    segmentDistance(x, y, 0.71, 0.3, 0.5, 0.72),
  );
  if (v <= stroke) {
    return [255, 255, 255, 1];
  }
  const t = y;
  return [0, 1, 2].map((i) => TOP[i] + (BOTTOM[i] - TOP[i]) * t).concat(1);
}

/** The icon at `size` px as straight (not premultiplied) RGBA, top row first. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const [cr, cg, cb, ca] = shade(
            (px + (sx + 0.5) / SAMPLES) / size,
            (py + (sy + 0.5) / SAMPLES) / size,
          );
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const offset = (py * size + px) * 4;
      pixels[offset] = a === 0 ? 0 : Math.round(r / a);
      pixels[offset + 1] = a === 0 ? 0 : Math.round(g / a);
      pixels[offset + 2] = a === 0 ? 0 : Math.round(b / a);
      pixels[offset + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(size) {
  const rgba = render(size);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 32-bit BMP icon image: BITMAPINFOHEADER, bottom-up BGRA, then an empty AND mask. */
function bitmap(size) {
  const rgba = render(size);
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8); // the color and mask heights together
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([info, pixels, Buffer.alloc(maskRow * size)]);
}

const images = [
  ...BITMAP_SIZES.map((size) => ({ size, data: bitmap(size) })),
  ...PNG_SIZES.map((size) => ({ size, data: png(size) })),
];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // an icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ size, data }) => {
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;
  return entry;
});

const folder = 'build';
mkdirSync(folder, { recursive: true });
writeFileSync(
  join(folder, 'icon.ico'),
  Buffer.concat([header, ...entries, ...images.map((image) => image.data)]),
);
writeFileSync(join(folder, 'icon.png'), png(512));
console.log(
  `Wrote ${join(folder, 'icon.ico')} (${images.map((image) => image.size).join(', ')} px) and ${join(folder, 'icon.png')} (512 px).`,
);
