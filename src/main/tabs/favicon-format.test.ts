import { describe, expect, it } from 'vitest';

import {
  decodeDataUrl,
  faviconDataUrl,
  MAX_FAVICON_BYTES,
  sniffRasterType,
} from './favicon-format';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => Uint8Array.from(value, (c) => c.charCodeAt(0));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const ICO = bytes(0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0);
const GIF = text('GIF89a\x01\x00\x01\x00');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const WEBP = text('RIFF\x24\x00\x00\x00WEBPVP8 ');
const BMP = new Uint8Array(30)
  .fill(0)
  .map((value, index) => (index === 0 ? 0x42 : index === 1 ? 0x4d : value));

describe('sniffRasterType', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['ICO', ICO, 'image/x-icon'],
    ['GIF', GIF, 'image/gif'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['WebP', WEBP, 'image/webp'],
    ['BMP', BMP, 'image/bmp'],
  ])('recognizes %s by its bytes', (_label, data, type) => {
    expect(sniffRasterType(data)).toBe(type);
  });

  it.each([
    ['SVG', text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['SVG with an XML prolog', text('<?xml version="1.0"?><svg/>')],
    ['HTML', text('<!doctype html><html>')],
    ['a cursor file (type 2)', bytes(0, 0, 2, 0, 1, 0)],
    ['an ICO with no images', bytes(0, 0, 1, 0, 0, 0)],
    ['a truncated PNG signature', bytes(0x89, 0x50, 0x4e, 0x47)],
    ['RIFF that is not WebP', text('RIFF\x24\x00\x00\x00WAVEfmt ')],
    ['nothing', new Uint8Array(0)],
  ])('refuses %s', (_label, data) => {
    expect(sniffRasterType(data)).toBeUndefined();
  });
});

describe('faviconDataUrl', () => {
  it('encodes a valid image with the type its bytes say, whatever the server claimed', () => {
    expect(faviconDataUrl(PNG)).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);
  });

  it('refuses images over 64 KB', () => {
    const big = new Uint8Array(MAX_FAVICON_BYTES + 1);
    big.set(PNG);
    expect(faviconDataUrl(big)).toBeUndefined();
    const limit = new Uint8Array(MAX_FAVICON_BYTES);
    limit.set(PNG);
    expect(faviconDataUrl(limit)).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses anything that is not a known raster image', () => {
    expect(faviconDataUrl(text('<svg/>'))).toBeUndefined();
    expect(faviconDataUrl(new Uint8Array(0))).toBeUndefined();
  });
});

describe('decodeDataUrl', () => {
  it('decodes base64 data: URLs', () => {
    const url = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;
    expect(decodeDataUrl(url)).toEqual(PNG);
  });

  it('decodes percent-encoded data: URLs', () => {
    expect(decodeDataUrl('data:image/gif,GIF89a%01%00')).toEqual(text('GIF89a\x01\x00'));
  });

  it('ignores the declared type: the bytes still decide', () => {
    const svg = `data:image/png;base64,${btoa('<svg onload="alert(1)"/>')}`;
    const decoded = decodeDataUrl(svg);
    expect(decoded).toBeDefined();
    expect(decoded === undefined ? undefined : faviconDataUrl(decoded)).toBeUndefined();
  });

  it.each([
    ['not a data URL', 'https://example.com/favicon.ico'],
    ['broken base64', 'data:image/png;base64,***'],
    ['a broken escape', 'data:image/png,%E0%A4%A'],
    ['oversized input', `data:image/png;base64,${'A'.repeat(MAX_FAVICON_BYTES * 2)}`],
  ])('refuses %s', (_label, url) => {
    expect(decodeDataUrl(url)).toBeUndefined();
  });
});
