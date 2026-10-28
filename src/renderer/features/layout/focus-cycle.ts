// F6 inside the shell (M6.2, assessment §3.9): the keyboard's three stops are the address bar, the
// sidebar's selected tab and the page, in that order, as Chrome's F6 cycles its panes. From a web
// page main moves to the address bar itself; once the shell has the keyboard only the shell knows
// where it is, so main sends `ui.cycleFocus` and the shell takes the next step. Pure.

/** Where the shell's keyboard focus is now. */
export type FocusRegion = 'sidebar' | 'page' | 'elsewhere';
/** Where F6 sends it. */
export type FocusStop = 'sidebar' | 'page' | 'address-bar';

/**
 * The next stop: from the sidebar to the page, from a page the shell draws (Settings, an error
 * page) to the address bar, and from anywhere else in the shell (the address bar, the toolbar, a
 * prompt) to the sidebar.
 */
export function nextFocusStop(region: FocusRegion): FocusStop {
  switch (region) {
    case 'sidebar':
      return 'page';
    case 'page':
      return 'address-bar';
    case 'elsewhere':
      return 'sidebar';
  }
}
