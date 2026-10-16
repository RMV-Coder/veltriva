import { useEffect } from 'react';
import type { RefObject } from 'react';

import { setLayoutInsets } from '../../state/commands';
import { computeInsets, insetsEqual } from './insets';
import type { Insets } from './insets';

/**
 * Tells main how far the shell's chrome reaches into the window, so it can place the selected
 * tab's native view exactly over `ref`'s element (`layout.setInsets`). The element's box must be
 * the rectangle the tab should occupy. Sends once on mount, then whenever the measurement changes.
 */
export function useContentInsets(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }

    let sent: Insets | undefined;
    const report = (): void => {
      const insets = computeInsets(element.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      if (sent !== undefined && insetsEqual(sent, insets)) {
        return;
      }
      sent = insets;
      void setLayoutInsets(insets).then((accepted) => {
        // Send it again next time, even if the measurement hasn't changed.
        if (!accepted && sent === insets) {
          sent = undefined;
        }
      });
    };

    report();
    // The box changes size when the window or the chrome around it does; the window listener also
    // covers zoom, which moves the box without resizing it in CSS pixels.
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [ref]);
}
