import { useLayoutEffect } from 'react';

/**
 * Marks `<html>` with `data-overlay="<name>"` while the calling component is mounted. The mark is
 * set before the first paint and removed in the same commit that unmounts the component, so the
 * shell never paints a frame between its overlay state and its normal one.
 */
export function useRootOverlay(name: string): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.overlay = name;
    return () => {
      delete root.dataset.overlay;
    };
  }, [name]);
}
