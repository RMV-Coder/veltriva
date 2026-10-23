// The demo web for the README's screenshots (M6.4, `npm run docs:images`): ten small pages on
// `*.example` hosts, served over TLS from this machine with a throwaway identity
// (tests/fixtures/certificate.ts). The words are written for this project, so the images show no
// one else's site or content. `--host-resolver-rules` maps the hosts to 127.0.0.1, and the server
// listens on 443 when it can, so the address bar shows `https://kyoto.example/` with no port.
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';

import type { ServerIdentity } from '../fixtures/certificate';

export interface DemoPage {
  readonly host: string;
  readonly title: string;
  /** The site's name, shown above the title. */
  readonly site: string;
  /** The icon's two colors: the tile and the dot. */
  readonly colors: readonly [RGB, RGB];
  readonly paragraphs: readonly string[];
}

type RGB = readonly [number, number, number];

export const DEMO_PAGES: readonly DemoPage[] = [
  {
    host: 'kyoto.example',
    site: 'Slow Travel Journal',
    title: 'Kyoto in four days: an unhurried itinerary',
    colors: [
      [196, 64, 52],
      [255, 236, 214],
    ],
    paragraphs: [
      'Start early on the first morning, before the tour groups, and walk from the river up through the old lanes. The light is soft until nine, and the tea houses are just opening their shutters.',
      'Day two belongs to the northern temples. Take the bus as far as it goes, then follow the canal path back down; it is downhill all the way and lined with small cafés.',
      'Keep the third day free. Rain is likely in November, and a free day lets you swap a garden visit for a museum without rearranging everything else.',
      'On the last day, buy your souvenirs in the covered market near the station, where the shops ship to your hotel, and leave the afternoon for one last long walk.',
    ],
  },
  {
    host: 'sourdough.example',
    site: 'Home Bakery',
    title: 'Sourdough starter: feeding notes for a cold kitchen',
    colors: [
      [176, 124, 60],
      [250, 240, 220],
    ],
    paragraphs: [
      'A starter slows down below twenty degrees. Feed it once a day with equal weights of flour and water, and keep the jar somewhere steady rather than somewhere warm.',
      'It is ready when it doubles within six to eight hours and smells sweet and yeasty, not sharp. Mark the level with a rubber band after each feeding.',
      'If you bake only at weekends, keep it in the fridge during the week and give it two feedings at room temperature before mixing your dough.',
    ],
  },
  {
    host: 'trailrun.example',
    site: 'Trail Running Club',
    title: 'Trail running for beginners: an eight-week plan',
    colors: [
      [46, 125, 80],
      [222, 247, 230],
    ],
    paragraphs: [
      'Weeks one and two are about time on your feet, not distance: three outings of thirty minutes, walking every climb.',
      'From week three, add one longer outing each weekend and practise descending with short, quick steps and your eyes a few metres ahead.',
      'Rest weeks matter. Weeks four and eight are lighter on purpose, so your legs absorb the work of the weeks before them.',
    ],
  },
  {
    host: 'rustnotes.example',
    site: 'Systems Reading Group',
    title: 'Ownership and borrowing: study notes',
    colors: [
      [190, 90, 30],
      [255, 230, 205],
    ],
    paragraphs: [
      'Every value has exactly one owner, and the value is dropped when its owner goes out of scope. Moving a value transfers ownership; the old binding can no longer be used.',
      'A reference borrows without taking ownership. You may have many shared references, or one mutable reference, but never both at once.',
      'Most borrow-checker errors are the compiler pointing at a real question: who is responsible for this data, and for how long?',
    ],
  },
  {
    host: 'budget.example',
    site: 'Household Planner',
    title: 'Household budget 2026: the plan for the year',
    colors: [
      [40, 96, 170],
      [220, 234, 252],
    ],
    paragraphs: [
      'Fixed costs first: rent, utilities, insurance and transport. Everything else is planned from what remains, in four envelopes for the four seasons.',
      'Set aside a small, boring amount every month for the things that happen once a year, so a car service or a new laptop battery is never a surprise.',
    ],
  },
  {
    host: 'garden.example',
    site: 'Balcony Garden',
    title: 'What to plant in November on a small balcony',
    colors: [
      [92, 140, 50],
      [236, 248, 220],
    ],
    paragraphs: [
      'Garlic and broad beans go in now, in deep pots, and sit quietly through the winter. Spring bulbs can share a pot if you layer them.',
      'Bring tender herbs indoors before the first frost, and wrap the larger pots in burlap so their roots stay dry.',
    ],
  },
  {
    host: 'meteors.example',
    site: 'Night Sky Notes',
    title: 'Meteor shower viewing notes for mid-November',
    colors: [
      [44, 52, 110],
      [210, 214, 255],
    ],
    paragraphs: [
      'The shower peaks after midnight, when your side of the Earth faces into the stream. Give your eyes twenty minutes in the dark before you start counting.',
      'Lie back and look about halfway up the sky, not at the radiant: the longest trails appear away from it.',
    ],
  },
  {
    host: 'ramen.example',
    site: 'Weeknight Kitchen',
    title: 'Weeknight miso ramen in thirty minutes',
    colors: [
      [214, 140, 30],
      [255, 244, 214],
    ],
    paragraphs: [
      'Warm the stock while the noodles cook, then whisk the miso into a ladle of it off the heat, so it stays fragrant.',
      'Soft-boiled eggs, spring onions and a spoon of chilli oil turn a quick bowl into dinner.',
    ],
  },
  {
    host: 'fts.example',
    site: 'Database Field Notes',
    title: 'SQLite full-text search: FTS5 notes',
    colors: [
      [60, 70, 80],
      [226, 232, 238],
    ],
    paragraphs: [
      'An FTS5 table indexes tokens, not substrings. Prefix queries such as "doc*" are fast when the table is created with a prefix index.',
      'Rank with bm25(), and weight the columns: a match in a title says more than a match deep in the body.',
    ],
  },
  {
    host: 'filmphoto.example',
    site: 'Darkroom Diary',
    title: 'Film photography: exposure notes for overcast days',
    colors: [
      [120, 70, 140],
      [244, 228, 252],
    ],
    paragraphs: [
      'Overcast light is even and forgiving. Meter for the shadows, then open up one stop: negative film prefers too much light to too little.',
      'Keep a small notebook of every frame, its aperture and its shutter speed; the contact sheet teaches more when you know what you meant to do.',
    ],
  },
];

export interface DemoSite {
  /** `https://<host>/`, with the port when 443 wasn't free. */
  url(host: string): string;
  /** The port, for the host-resolver rule. */
  readonly port: number;
  close(): Promise<void>;
}

/** Starts the demo web on 127.0.0.1, on port 443 when it is free, else on any port. */
export async function startDemoSite(identity: ServerIdentity): Promise<DemoSite> {
  const byHost = new Map(DEMO_PAGES.map((page) => [page.host, page]));
  const server: Server = createServer(
    { key: identity.key, cert: identity.cert },
    (request, response) => {
      const host = (request.headers.host ?? '').replace(/:\d+$/u, '');
      const page = byHost.get(host);
      const path = new URL(request.url ?? '/', 'https://demo.invalid').pathname;
      if (page === undefined) {
        response.writeHead(404).end();
        return;
      }
      if (path === '/favicon.png') {
        const icon = paintIcon(page.colors);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': icon.length });
        response.end(icon);
        return;
      }
      const body = renderPage(page);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
    },
  );
  const port = await listen(server, 443).catch(() => listen(server, 0));
  return {
    port,
    url: (host) => (port === 443 ? `https://${host}/` : `https://${host}:${String(port)}/`),
    close: () =>
      new Promise<void>((resolveClosed) => {
        server.close(() => {
          resolveClosed();
        });
        server.closeAllConnections();
      }),
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListening, rejectListening) => {
    const onError = (error: Error): void => {
      rejectListening(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolveListening((server.address() as AddressInfo).port);
    });
  });
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/gu, (char) => `&#${String(char.charCodeAt(0))};`);

function renderPage(page: DemoPage): string {
  const [tile] = page.colors;
  const accent = `rgb(${tile.join(' ')})`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.title)}</title>
<link rel="icon" href="/favicon.png" type="image/png">
<style>
  :root { color-scheme: light dark; --ink: #1d2126; --soft: #5b6470; --paper: #fbfaf7; --rule: #e6e2da; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e9e6e0; --soft: #a6adb7; --paper: #1b1d21; --rule: #33363c; } }
  html { background: var(--paper); }
  body { margin: 0; font: 17px/1.65 "Segoe UI", system-ui, sans-serif; color: var(--ink); }
  header { border-bottom: 1px solid var(--rule); padding: 18px 48px; display: flex; gap: 12px; align-items: center; }
  header .mark { width: 22px; height: 22px; border-radius: 6px; background: ${accent}; }
  header .site { font-weight: 600; letter-spacing: 0.01em; }
  main { max-width: 720px; padding: 36px 48px 64px; }
  h1 { font: 600 34px/1.2 Georgia, "Times New Roman", serif; margin: 0 0 8px; }
  .byline { color: var(--soft); font-size: 14px; margin-bottom: 28px; }
  p { margin: 0 0 18px; }
</style>
</head>
<body>
<header><span class="mark"></span><span class="site">${escapeHtml(page.site)}</span></header>
<main>
<h1>${escapeHtml(page.title)}</h1>
<div class="byline">A demo page for Veltriva's screenshots</div>
${page.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('\n')}
</main>
</body>
</html>
`;
}

// ── A 32-pixel icon: a rounded tile with a dot, painted pixel by pixel ────────────────────────────

const ICON_SIZE = 32;

function paintIcon([tile, dot]: readonly [RGB, RGB]): Buffer {
  const rows: Buffer[] = [];
  const center = (ICON_SIZE - 1) / 2;
  for (let y = 0; y < ICON_SIZE; y += 1) {
    const row = Buffer.alloc(1 + ICON_SIZE * 4);
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const inTile = roundedRectCoverage(x, y, ICON_SIZE, 7);
      const inDot = circleCoverage(x - center, y - center, 7.5);
      const color = mix(tile, dot, inDot);
      row.set([...color, Math.round(255 * inTile)], 1 + x * 4);
    }
    rows.push(row);
  }
  return png(ICON_SIZE, Buffer.concat(rows));
}

/** How much of pixel (x, y) a circle of radius r around the origin covers, 0 to 1 (4×4 samples). */
function circleCoverage(dx: number, dy: number, radius: number): number {
  return supersample((sx, sy) => (dx + sx) ** 2 + (dy + sy) ** 2 <= radius ** 2);
}

/** How much of pixel (x, y) a size×size square with corner radius r covers, 0 to 1. */
function roundedRectCoverage(x: number, y: number, size: number, radius: number): number {
  return supersample((sx, sy) => {
    const px = x + 0.5 + sx;
    const py = y + 0.5 + sy;
    const cx = Math.min(Math.max(px, radius), size - radius);
    const cy = Math.min(Math.max(py, radius), size - radius);
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
  });
}

function supersample(inside: (sx: number, sy: number) => boolean): number {
  let hits = 0;
  for (const sx of [-0.375, -0.125, 0.125, 0.375]) {
    for (const sy of [-0.375, -0.125, 0.125, 0.375]) {
      hits += inside(sx, sy) ? 1 : 0;
    }
  }
  return hits / 16;
}

function mix(from: RGB, to: RGB, amount: number): RGB {
  return [0, 1, 2].map((i) =>
    Math.round((from[i] ?? 0) * (1 - amount) + (to[i] ?? 0) * amount),
  ) as [number, number, number];
}

/** An 8-bit RGBA PNG from filtered rows (each row starts with filter byte 0). */
function png(size: number, rows: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
