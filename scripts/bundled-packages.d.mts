// Types for ./bundled-packages.mjs, which electron.vite.config.ts imports.
import type { Plugin } from 'vite';

export function packageRootOf(id: string): string | undefined;
export function bundledPackages(target: 'main' | 'preload' | 'renderer'): Plugin;
