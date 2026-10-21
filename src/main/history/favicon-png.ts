// A favicon as the memory stores it (§5.3): a PNG Veltriva encoded itself, at most 64×64. The
// input is a `data:` URL the favicon service built from bytes it sniffed and size-capped
// (../tabs/favicon-format.ts), so this never sees SVG or anything over 64 KiB. Re-encoding means
// the file holds pixels Chromium decoded, never the bytes a server sent.
import { nativeImage } from 'electron';

import { MAX_FAVICON_PNG_BASE64 } from '../../shared/contracts/data-rpc';

export const STORED_FAVICON_SIZE = 64;

const DATA_URL = /^data:image\/[a-z.+-]{1,20};base64,([A-Za-z0-9+/]+={0,2})$/;

/** The part of Electron's nativeImage this uses, so tests can stand in for it. */
export interface FaviconImages {
  createFromBuffer(buffer: Buffer): {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    resize(options: { width: number; height: number; quality: 'best' }): { toPNG(): Buffer };
    toPNG(): Buffer;
  };
}

/** The icon as a base64 PNG of at most 64×64, or null if Chromium can't decode it. */
export function encodeFaviconPng(
  dataUrl: string,
  images: FaviconImages = nativeImage,
): string | null {
  const match = DATA_URL.exec(dataUrl);
  if (match?.[1] === undefined) {
    return null;
  }
  const image = images.createFromBuffer(Buffer.from(match[1], 'base64'));
  if (image.isEmpty()) {
    return null; // GIF, WebP and BMP among others: nativeImage decodes PNG, JPEG and ICO only.
  }
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) {
    return null;
  }
  const scale = Math.min(1, STORED_FAVICON_SIZE / Math.max(width, height));
  const png = (
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'best',
        })
      : image
  )
    .toPNG()
    .toString('base64');
  return png.length === 0 || png.length > MAX_FAVICON_PNG_BASE64 ? null : png;
}
