// Records which npm packages a build put into its bundle (M6.1, the license audit). Each of
// electron-vite's three builds (main, preload, renderer) writes out/third-party/<target>.json: the
// packages whose modules ended up in its chunks, by name and version. scripts/third-party-notices.mjs
// turns those lists, plus the runtime dependencies electron-builder copies, into
// THIRD_PARTY_NOTICES.txt. The lists themselves aren't shipped (electron-builder.yml leaves
// out/third-party out).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The package directory a module id lies in (the last node_modules segment), or undefined. */
export function packageRootOf(id) {
  const path = id.replace(/^\0+/, '').split('?')[0].split('\\').join('/');
  const marker = '/node_modules/';
  const at = path.lastIndexOf(marker);
  if (at === -1) {
    return undefined;
  }
  const rest = path.slice(at + marker.length).split('/');
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= depth) {
    return undefined;
  }
  return path.slice(0, at + marker.length) + rest.slice(0, depth).join('/');
}

/** A Vite plugin for one electron-vite target: 'main', 'preload' or 'renderer'. */
export function bundledPackages(target) {
  return {
    name: 'veltriva:bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const roots = new Set();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') {
          continue;
        }
        for (const id of output.moduleIds) {
          const root = packageRootOf(id);
          if (root !== undefined) {
            roots.add(root);
          }
        }
      }
      const packages = new Map();
      for (const root of roots) {
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        packages.set(`${manifest.name}@${manifest.version}`, {
          name: manifest.name,
          version: manifest.version,
        });
      }
      const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
      const folder = join('out', 'third-party');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${target}.json`), `${JSON.stringify(list, null, 2)}\n`);
    },
  };
}
