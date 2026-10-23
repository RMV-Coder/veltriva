import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

import { bundledPackages } from './scripts/bundled-packages.mjs';

export default defineConfig({
  // Two entries, both CommonJS: main itself (out/main/index.js), and the data worker
  // (out/main/data-worker.js), which main starts as a worker thread and never imports (ADR-0004).
  // better-sqlite3 is a runtime dependency, so it stays external and is loaded from node_modules.
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'data-worker': resolve('src/data/worker.ts'),
        },
      },
    },
    // M6.1: which packages each bundle holds, for THIRD_PARTY_NOTICES.txt.
    plugins: [bundledPackages('main')],
  },
  preload: {
    build: {
      // A sandboxed preload can only require `electron`, so bundle everything else into it.
      externalizeDeps: false,
      rolldownOptions: {
        input: { shell: resolve('src/preload/shell.ts') },
      },
    },
    plugins: [bundledPackages('preload')],
  },
  renderer: {
    // Root: src/renderer (electron-vite's default). Output: out/renderer. Two pages: the shell,
    // and the read-only address bar of popup windows (src/main/windows/popup-windows.ts).
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'popup-bar': resolve('src/renderer/popup-bar.html'),
        },
      },
    },
    resolve: {
      alias: { '@': resolve('src/renderer') },
    },
    plugins: [react(), tailwindcss(), bundledPackages('renderer')],
  },
});
