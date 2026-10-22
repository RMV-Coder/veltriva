import { useCallback, useLayoutEffect, useRef } from 'react';

import { hideOverlay, showOverlay } from '../../state/commands';
import type { ShellOverlay } from '../../state/commands';
import { markRootOverlay } from '../fullscreen/use-root-overlay';

/**
 * The shell's side of an overlay above the page (ADR-0006 A′): the palette, the address bar's
 * suggestions. While `active` it
 *   1. marks `<html data-overlay>`, which makes the shell's document transparent (globals.css),
 *      before the overlay's first paint;
 *   2. waits two animation frames, so the overlay has been painted on that transparent page, and
 *      only then tells main (`overlay.show`), which raises the shell above the tab and gives it
 *      the keyboard. Raised any earlier, the shell's opaque chrome would flash over the page, and
 *      an opaque shell above a page counts as occlusion: the page would go hidden.
 * When it stops being active it sends `overlay.hide` (if `show` was sent) and keeps the document
 * transparent until main has answered, i.e. has lowered the shell: the other order would show an
 * opaque content area for a moment.
 *
 * Returns a function to call, just before the overlay closes, with whether main should give the
 * page the keyboard: true when the user dismissed it without opening anything, false after an
 * open (which focused the page it opened) and for a blur.
 */
export function useShellOverlay(
  overlay: ShellOverlay,
  active: boolean,
): (focusPageOnHide: boolean) => void {
  const focusPage = useRef(false);

  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    const release = markRootOverlay(overlay);
    let shown = false;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        shown = true;
        void showOverlay(overlay);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (shown) {
        const lowering = hideOverlay(overlay, focusPage.current);
        release(lowering);
      } else {
        release();
      }
      focusPage.current = false;
    };
  }, [overlay, active]);

  return useCallback((focusPageOnHide: boolean): void => {
    focusPage.current = focusPageOnHide;
  }, []);
}
