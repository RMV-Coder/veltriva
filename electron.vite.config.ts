import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  // Entry: src/main/index.ts (electron-vite's default). Output: out/main/index.js (CommonJS).
  main: {},
  preload: {
    build: {
      // A sandboxed preload can only require `electron`, so bundle everything else into it.
      externalizeDeps: false,
      rolldownOptions: {
        input: { shell: resolve('src/preload/shell.ts') },
      },
    },
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
    plugins: [react(), tailwindcss()],
  },
});
