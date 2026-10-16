/**
 * The shell's focus ring. The theme's `ring` token is too faint for the 3:1 contrast a focus
 * indicator needs on a white background, so the shell's own controls use the text color instead.
 */
export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-foreground/60';

/** The same ring for a container that holds the focused control (`:focus-within`). */
export const FOCUS_WITHIN_RING = 'focus-within:ring-2 focus-within:ring-foreground/60';
