// Shortcuts a page may claim first (assessment §3.9): find, zoom and print (M5.0). They are accelerators of a
// window menu that is never shown. Electron runs a menu accelerator only for a key event that the
// renderer did not handle (no preventDefault), so a page with its own Ctrl+F (Google Docs) keeps
// it, and every other page gets the browser's. The same holds while the shell has focus (Ctrl+F
// in the address bar opens find). Checked on Electron 44 with BaseWindow and WebContentsView.
import { Menu } from 'electron';
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';

import type { ZoomDirection } from '../../core/layout/zoom';

export interface PageMenuActions {
  find(): void;
  /** Ctrl+P (M5.0): the system print dialog for the selected tab's page. */
  print(): void;
  findNext(forward: boolean): void;
  zoom(direction: ZoomDirection): void;
}

export function installPageMenu(window: BaseWindow, actions: PageMenuActions): void {
  const item = (
    label: string,
    accelerator: string,
    click: () => void,
  ): MenuItemConstructorOptions => ({ label, accelerator, click });
  const findNext = (): void => {
    actions.findNext(true);
  };
  const findPrevious = (): void => {
    actions.findNext(false);
  };
  const zoomIn = (): void => {
    actions.zoom('in');
  };
  const zoomOut = (): void => {
    actions.zoom('out');
  };
  const resetZoom = (): void => {
    actions.zoom('reset');
  };

  const menu = Menu.buildFromTemplate([
    {
      label: 'Page',
      submenu: [
        item('Find…', 'CommandOrControl+F', () => {
          actions.find();
        }),
        item('Find next', 'F3', findNext),
        item('Find next', 'CommandOrControl+G', findNext),
        item('Find previous', 'Shift+F3', findPrevious),
        item('Find previous', 'CommandOrControl+Shift+G', findPrevious),
        item('Zoom in', 'CommandOrControl+=', zoomIn),
        item('Zoom in', 'CommandOrControl+Plus', zoomIn),
        item('Zoom in', 'CommandOrControl+numadd', zoomIn),
        item('Zoom out', 'CommandOrControl+-', zoomOut),
        item('Zoom out', 'CommandOrControl+numsub', zoomOut),
        item('Actual size', 'CommandOrControl+0', resetZoom),
        item('Actual size', 'CommandOrControl+num0', resetZoom),
        item('Print…', 'CommandOrControl+P', () => {
          actions.print();
        }),
      ],
    },
  ]);
  window.setMenu(menu);
  // Never shown: with autoHideMenuBar off (the default), Alt doesn't reveal it either.
  window.setMenuBarVisibility(false);
}
