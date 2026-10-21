// Favicon validation (threat T5). The shell never loads remote images: main fetches each favicon
// and hands the shell a `data:` URL it built itself, only for small raster images identified by
// their bytes, never by a server's Content-Type. SVG is refused outright (it can carry script and
// external references). Pure, so the checks are unit-tested, and shared: main runs them on what
// it fetched, and the data worker again on what main asks it to store (M2.2b). Nothing in main
// ever decodes the image; only the sandboxed shell renderer draws it.

export const MAX_FAVICON_BYTES = 64 * 1024;

/** The raster types a favicon may be, as stored in `favicons.mime` (migration 0002's CHECK). */
export const RASTER_TYPES = [
  'image/png',
  'image/x-icon',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'image/bmp',
] as const;
export type RasterType = (typeof RASTER_TYPES)[number];

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + prefix.length &&
  prefix.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string): number[] => Array.from(text, (character) => character.charCodeAt(0));

/** Identifies a raster image by its magic number. */
export function sniffRasterType(bytes: Uint8Array): RasterType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  // ICO: reserved 0, type 1 (icon), then at least one image.
  if (
    startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) &&
    bytes.length >= 6 &&
    (bytes[4] ?? 0) + (bytes[5] ?? 0) > 0
  ) {
    return 'image/x-icon';
  }
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return 'image/gif';
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return 'image/webp';
  }
  if (startsWith(bytes, ascii('BM')) && bytes.length >= 26) {
    return 'image/bmp';
  }
  return undefined;
}

/** A `data:` URL for a valid favicon, or undefined if the bytes aren't one. */
export function faviconDataUrl(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) {
    return undefined;
  }
  const type = sniffRasterType(bytes);
  return type === undefined ? undefined : `data:${type};base64,${toBase64(bytes)}`;
}

const DATA_URL = /^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,(.*)$/is;

/**
 * Pages often inline their favicon as a `data:` URL. Decode it (base64 or percent-encoded) and
 * apply the same checks; the declared media type is ignored, the bytes decide.
 */
export function decodeDataUrl(url: string): Uint8Array | undefined {
  // Bound the work before decoding: base64 is 4/3 of the bytes.
  if (url.length > MAX_FAVICON_BYTES * 2) {
    return undefined;
  }
  const match = DATA_URL.exec(url);
  if (match === null) {
    return undefined;
  }
  const [, , , base64, payload = ''] = match;
  try {
    if (base64 !== undefined) {
      const clean = payload.replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
        return undefined;
      }
      return Uint8Array.from(atob(clean), (character) => character.charCodeAt(0));
    }
    const text = decodeURIComponent(payload);
    return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
  } catch {
    return undefined;
  }
}

/**
 * A favicon `data:` URL as the memory stores it (M2.2b): its bytes, as base64, and the type the
 * bytes say they are. The same checks as above: undefined unless it is a small raster image.
 * Nothing is decoded as an image.
 */
export function storedFavicon(
  url: string,
): { readonly mime: RasterType; readonly bytes: string } | undefined {
  const bytes = decodeDataUrl(url);
  if (bytes === undefined || bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) {
    return undefined;
  }
  const mime = sniffRasterType(bytes);
  return mime === undefined ? undefined : { mime, bytes: toBase64(bytes) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
