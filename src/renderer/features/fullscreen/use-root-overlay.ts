import { useLayoutEffect } from 'react';

/** The overlays that hold `<html data-overlay>` right now, oldest first. */
const marks: string[] = [];

function applyMarks(): void {
  const root = document.documentElement;
  if (marks.length === 0) {
    delete root.dataset.overlay;
  } else {
    // A list of names: globals.css matches with `~=`. One name reads as it always did.
    root.dataset.overlay = marks.join(' ');
  }
}

/**
 * Marks `<html>` with `data-overlay="<name>"`: globals.css makes the shell's document transparent
 * while any name is set (ADR-0006 A′). Several overlays may hold a mark at once (the palette
 * opens while the address bar's suggestions are still up), so the marks are counted: the last one
 * released clears the attribute.
 *
 * Returns the function that releases the mark. `after` delays the release until a promise has
 * settled: a shell that main has not lowered yet must stay transparent until it is, or it would
 * flash an opaque content area over the page.
 */
export function markRootOverlay(name: string): (after?: Promise<unknown>) => void {
  marks.push(name);
  applyMarks();
  return (after) => {
    const release = (): void => {
      const index = marks.indexOf(name);
      if (index >= 0) {
        marks.splice(index, 1);
      }
      applyMarks();
    };
    if (after === undefined) {
      release();
    } else {
      after.then(release, release);
    }
  };
}

/**
 * Marks `<html>` with `data-overlay="<name>"` while the calling component is mounted. The mark is
 * set before the first paint and removed in the same commit that unmounts the component, so the
 * shell never paints a frame between its overlay state and its normal one.
 */
export function useRootOverlay(name: string): void {
  useLayoutEffect(() => markRootOverlay(name), [name]);
}
