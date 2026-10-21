import { BaseWindow, nativeTheme, screen } from 'electron';
import type { Session, WebContentsView } from 'electron';

import { placeWindow } from '../../core/layout/window-bounds';
import type { SavedWindow } from '../../core/layout/window-bounds';
import { PRODUCT_NAME } from '../../shared/constants/app-identity';
import { createViewWithRole } from '../web/roles';
import { shellWebPreferences } from '../web/web-preferences';

// Matches the shell's CSS background, so the window never flashes a different color first.
const WINDOW_BACKGROUND = { light: '#ffffff', dark: '#0a0a0a' } as const;

export function windowBackground(dark: boolean): string {
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

export interface MainWindow {
  readonly window: BaseWindow;
  readonly shell: WebContentsView;
}

const DEFAULT_SIZE = { width: 1280, height: 800 } as const;
const MIN_SIZE = { width: 640, height: 480 } as const;

/** The window's place and size to save (M2.2a): its normal bounds, even while maximized. */
export function savedWindowOf(window: BaseWindow): SavedWindow {
  return { ...window.getNormalBounds(), maximized: window.isMaximized() };
}

/**
 * The one `BaseWindow` (ADR-0009 D8) and the shell view under everything else. Sizing is the
 * LayoutManager's job; the caller loads the shell once its IPC handlers are in place.
 */
export function createMainWindow(options: {
  readonly shellSession: Session;
  readonly preload: string;
  /** Where the window was last time (app_state `window`), used only if still on a screen. */
  readonly saved?: SavedWindow | null;
}): MainWindow {
  const placed = placeWindow(
    options.saved,
    screen.getAllDisplays().map((display) => display.workArea),
    MIN_SIZE,
  );
  const window = new BaseWindow({
    title: PRODUCT_NAME,
    ...(placed === null
      ? DEFAULT_SIZE
      : { x: placed.x, y: placed.y, width: placed.width, height: placed.height }),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
  });
  if (placed?.maximized === true) {
    window.maximize();
  }

  const shell = createViewWithRole('shell', {
    webPreferences: shellWebPreferences({
      session: options.shellSession,
      preload: options.preload,
    }),
  });
  // Transparent view background (ADR-0006, option A′): CSS paints the opaque state, and an
  // overlay can later clear it to show the tab underneath.
  shell.setBackgroundColor('#00000000');
  window.contentView.addChildView(shell);
  return { window, shell };
}
