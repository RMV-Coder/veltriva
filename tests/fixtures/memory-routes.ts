// The memory routes of the fixture server (M2.2b: history, favicons, stored decisions). Pages and
// images are made from the query, so a spec asks for exactly the page it needs:
//   /memory/page?title=&icon=&link=&animate=&final=   an HTML page. `title` is its <title>; `icon`
//                                       is a path and query for <link rel="icon">; each `link` is an
//                                       <a id="link-N"> with that href; `animate=N` flips the title
//                                       N times, 100 ms apart, and ends on `final` (a page that
//                                       animates its title, as a ticker does)
//   /memory/redirect?to=&status=        a redirect (302 by default) to `to`
//   /memory/icon.png?w=&h=&c=r,g,b      a solid PNG of that size (16x16 blue by default)
//   /memory/icon.ico?size=              a solid ICO holding one 32-bit bitmap, as favicon.ico files do
//   /memory/icon.gif                    a 1x1 GIF
// Every response is `no-store`, so each visit reaches the server and reads the same answer.
import type { ServerResponse } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const HTML = 'text/html; charset=utf-8';
/** The most an image route will draw: a solid color compresses to almost nothing. */
const MAX_SIDE = 1024;

type Rgba = readonly [number, number, number, number];
const DEFAULT_COLOR: Rgba = [0, 90, 200, 255];

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${String(character.charCodeAt(0))};`);
}

function sideFrom(params: URLSearchParams, name: string, fallback: number): number {
  const requested = Number(params.get(name));
  return params.has(name) && Number.isInteger(requested) && requested >= 1 && requested <= MAX_SIDE
    ? requested
    : fallback;
}

function colorFrom(params: URLSearchParams): Rgba {
  const parts = (params.get('c') ?? '').split(',').map(Number);
  const [red, green, blue] = parts;
  return parts.length === 3 &&
    [red, green, blue].every(
      (part) => Number.isInteger(part) && (part ?? -1) >= 0 && (part ?? 256) <= 255,
    )
    ? [red ?? 0, green ?? 0, blue ?? 0, 255]
    : DEFAULT_COLOR;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** A solid-color PNG of any size (8-bit RGBA). */
export function buildSolidPng(width: number, height: number, rgba: Rgba = DEFAULT_COLOR): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  const row = Buffer.alloc(1 + width * 4); // a filter-type byte (0), then one pixel per column
  for (let x = 0; x < width; x += 1) {
    row.set(rgba, 1 + x * 4);
  }
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A solid-color ICO with one 32-bit bitmap (a BITMAPINFOHEADER, bottom-up BGRA, an empty mask). */
export function buildSolidIco(size: number, rgba: Rgba = DEFAULT_COLOR): Buffer {
  const maskRow = Math.ceil(size / 32) * 4;
  const pixelBytes = size * size * 4;
  const imageBytes = 40 + pixelBytes + maskRow * size;

  const directory = Buffer.alloc(6 + 16);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(1, 4); // one image
  directory[6] = size === 256 ? 0 : size; // width
  directory[7] = size === 256 ? 0 : size; // height
  directory.writeUInt16LE(1, 10); // planes
  directory.writeUInt16LE(32, 12); // bits per pixel
  directory.writeUInt32LE(imageBytes, 14);
  directory.writeUInt32LE(22, 18); // where the image starts

  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8); // the height counts the mask too
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  info.writeUInt32LE(pixelBytes, 20);

  const [red, green, blue, alpha] = rgba;
  const pixels = Buffer.alloc(pixelBytes);
  for (let pixel = 0; pixel < size * size; pixel += 1) {
    pixels.set([blue, green, red, alpha], pixel * 4);
  }
  return Buffer.concat([directory, info, pixels, Buffer.alloc(maskRow * size)]);
}

/** The smallest GIF: one transparent pixel. */
export const GIF_1X1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...NO_STORE,
  });
  response.end(body);
}

/** The animation: `count` titles 100 ms apart, then `final`. */
function animationScript(count: number, final: string): string {
  return `<script>
      let tick = 0;
      const timer = setInterval(() => {
        tick += 1;
        if (tick >= ${String(count)}) {
          clearInterval(timer);
          document.title = ${JSON.stringify(final).replaceAll('<', '\\u003c')};
        } else {
          document.title = 'Tick ' + tick;
        }
      }, 100);
    </script>`;
}

function memoryPage(params: URLSearchParams): string {
  const title = params.get('title') ?? 'Memory page';
  const icon = params.get('icon');
  const links = params
    .getAll('link')
    .map(
      (href, index) =>
        `<p><a id="link-${String(index)}" href="${escapeHtml(href)}">link ${String(index)}</a></p>`,
    )
    .join('\n    ');
  const count = Number(params.get('animate'));
  const animate =
    Number.isInteger(count) && count >= 2 && count <= 100
      ? animationScript(count, params.get('final') ?? 'Final')
      : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>${
      icon === null ? '' : `\n    <link rel="icon" href="${escapeHtml(icon)}" />`
    }
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${links}
    ${animate}
  </body>
</html>
`;
}

/** Answers a `/memory/…` request. Returns false for a path that is not a memory route. */
export function handleMemoryRoute(
  pathname: string,
  params: URLSearchParams,
  response: ServerResponse,
): boolean {
  switch (pathname) {
    case '/memory/page':
      send(response, 200, HTML, memoryPage(params));
      return true;
    case '/memory/redirect': {
      const status = Number(params.get('status') ?? 302);
      response.writeHead([301, 302, 303, 307, 308].includes(status) ? status : 302, {
        Location: params.get('to') ?? '/',
        'Content-Length': 0,
        ...NO_STORE,
      });
      response.end();
      return true;
    }
    case '/memory/icon.png':
      send(
        response,
        200,
        'image/png',
        buildSolidPng(sideFrom(params, 'w', 16), sideFrom(params, 'h', 16), colorFrom(params)),
      );
      return true;
    case '/memory/icon.ico':
      send(
        response,
        200,
        'image/x-icon',
        buildSolidIco(sideFrom(params, 'size', 16), colorFrom(params)),
      );
      return true;
    case '/memory/icon.gif':
      send(response, 200, 'image/gif', GIF_1X1);
      return true;
    default:
      return false;
  }
}
