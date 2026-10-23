// Reads an Electron binary's fuse wire (M6.1, assessment §6.2 and §9.2: fuse state read back from
// the packaged binary). The wire is a sentinel string, a version byte, a length byte, then one
// byte per fuse: '0' off, '1' on, 'r' removed. Read in chunks, so a 200 MB executable is never
// held in memory at once. No dependency: @electron/fuses (electron-builder's) knows only the fuses
// of its release, and this reads whatever the binary has.
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { open } from 'node:fs/promises';
import process from 'node:process';

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
const CHUNK = 8 * 1024 * 1024;

/** Electron's fuse names, in wire order (electron/build/fuses/fuses.json5). */
export const FUSES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];

/** { version, fuses: { [name]: 'on' | 'off' | 'removed' | 'unknown' } } for the binary at `path`. */
export async function readFuseWire(path) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK + SENTINEL.length + 2 + 64);
    let position = 0;
    let carried = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, carried, CHUNK, position);
      if (bytesRead === 0) {
        throw new Error(`${path}: no fuse wire found`);
      }
      const filled = carried + bytesRead;
      const at = buffer.subarray(0, filled).indexOf(SENTINEL);
      if (at !== -1) {
        const start = at + SENTINEL.length;
        // Make sure the version, length and fuse bytes are in the buffer.
        const header = Buffer.alloc(2 + 64);
        await file.read(header, 0, header.length, position - carried + start);
        const version = header[0];
        const length = header[1];
        const fuses = {};
        for (let index = 0; index < length; index += 1) {
          const byte = String.fromCharCode(header[2 + index]);
          const state =
            byte === '1' ? 'on' : byte === '0' ? 'off' : byte === 'r' ? 'removed' : 'unknown';
          fuses[FUSES[index] ?? `fuse${String(index)}`] = state;
        }
        return { version, fuses };
      }
      // Keep the tail, in case the sentinel straddles two chunks.
      carried = Math.min(SENTINEL.length - 1, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
}

if (import.meta.url === `file:///${process.argv[1]?.split('\\').join('/')}`) {
  console.log(JSON.stringify(await readFuseWire(process.argv[2]), null, 2));
}
