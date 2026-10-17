// The download routes of the fixture server (M1.4b). Every file has known bytes, so a spec can
// compare what landed on disk with `fixtureBytes(size)`:
//   /dl/file?name=&size=&type=&style=   `Content-Disposition: attachment` with that file name
//                                       (`style=plain` sends it as `filename="…"`, the default as
//                                       `filename*=UTF-8''…`, which can carry any character)
//   /dl/inline/<name>                   `size` bytes of plain ASCII text (`fixtureText`) as `text/plain`,
//                                       with no disposition: a link to it opens in the tab, unless
//                                       the user Alt+clicks it. It has to be real text: Chromium
//                                       sniffs binary bytes labeled text/plain as a download
//   /dl/gated?name=&size=&first=&key=   sends the headers and `first` bytes, then holds the rest
//                                       until the test calls `releaseGate(key)`: a download that is
//                                       in progress for exactly as long as a test needs
import type { ServerResponse } from 'node:http';

/** `size` bytes that depend only on their position, so any slice can be recomputed. */
export function fixtureBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + 7) & 0xff;
  }
  return bytes;
}

/** `size` bytes of printable ASCII text in lines, so a browser shows it instead of saving it. */
export function fixtureText(size: number): Buffer {
  const line = 'The fixture text, line by line, for a download that is a page.\n';
  return Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size), 'ascii');
}

const MAX_SIZE = 8 * 1024 * 1024;
const DEFAULT_SIZE = 1_024;
const DEFAULT_FIRST_CHUNK = 64 * 1024;

function sizeFrom(params: URLSearchParams, name = 'size', fallback = DEFAULT_SIZE): number {
  const requested = Number(params.get(name));
  return params.has(name) && Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, MAX_SIZE)
    : fallback;
}

/**
 * A `Content-Disposition` for `name`. The extended form (RFC 6266) carries any character, so a
 * path separator, a right-to-left override or a device name reaches the browser exactly as given.
 * The plain form is for the names a server would write by hand.
 */
function disposition(name: string, style: string | null): string {
  if (style === 'plain') {
    return `attachment; filename="${name.replace(/"/g, '_')}"`;
  }
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Downloads a test holds open: each `key` waits for `release(key)`. */
export interface Gates {
  /** Calls `resume` once `key` is released (at once if it already was). */
  hold(key: string, response: ServerResponse, resume: () => void): void;
  release(key: string): void;
}

export function createGates(): Gates {
  const pending = new Map<string, Set<() => void>>();
  const released = new Set<string>();
  return {
    hold(key, response, resume) {
      if (released.has(key)) {
        resume();
        return;
      }
      const waiting = pending.get(key) ?? new Set<() => void>();
      pending.set(key, waiting);
      waiting.add(resume);
      // A client that went away (a cancelled download) takes its wait with it.
      response.once('close', () => {
        waiting.delete(resume);
      });
    },
    release(key) {
      released.add(key);
      for (const resume of pending.get(key) ?? []) {
        resume();
      }
      pending.delete(key);
    },
  };
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Answers a `/dl/…` request. Returns false for a path that is not a download route. */
export function handleDownloadRoute(
  pathname: string,
  params: URLSearchParams,
  response: ServerResponse,
  gates: Gates,
): boolean {
  if (pathname === '/dl/file') {
    const body = fixtureBytes(sizeFrom(params));
    response.writeHead(200, {
      'Content-Type': params.get('type') ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Content-Disposition': disposition(params.get('name') ?? 'file.bin', params.get('style')),
      ...NO_STORE,
    });
    response.end(body);
    return true;
  }
  if (pathname.startsWith('/dl/inline/')) {
    const body = fixtureText(sizeFrom(params));
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      ...NO_STORE,
    });
    response.end(body);
    return true;
  }
  if (pathname === '/dl/gated') {
    const size = sizeFrom(params);
    const first = Math.min(size, sizeFrom(params, 'first', DEFAULT_FIRST_CHUNK));
    const body = fixtureBytes(size);
    response.on('error', () => undefined);
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'Content-Disposition': disposition(params.get('name') ?? 'gated.bin', params.get('style')),
      ...NO_STORE,
    });
    response.write(body.subarray(0, first));
    gates.hold(params.get('key') ?? '', response, () => {
      if (!response.destroyed) {
        response.end(body.subarray(first));
      }
    });
    return true;
  }
  return false;
}
