import { useEffect } from 'react';

import { useUiStore } from '../../state/ui-store';
import { MemoryPalette } from './MemoryPalette';

/**
 * Opens the memory palette when main says so (`ui.openPalette`, after Ctrl+Shift+K: main has
 * given the shell the keyboard already) and draws it while the store says it is open. It lives in
 * the browser shell, so a palette that is open stays open when the selected tab changes.
 */
export function PaletteHost() {
  const open = useUiStore((state) => state.paletteOpen);
  const openPalette = useUiStore((state) => state.openPalette);

  useEffect(() => window.veltriva.on('ui.openPalette', openPalette), [openPalette]);

  return open ? <MemoryPalette /> : null;
}
