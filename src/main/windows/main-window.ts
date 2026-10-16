import { BaseWindow, nativeTheme } from 'electron';
import type { Session, WebContentsView } from 'electron';

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

/**
 * The one `BaseWindow` (ADR-0009 D8) and the shell view under everything else. Sizing is the
 * LayoutManager's job; the caller loads the shell once its IPC handlers are in place.
 */
export function createMainWindow(options: {
  readonly shellSession: Session;
  readonly preload: string;
}): MainWindow {
  const window = new BaseWindow({
    title: PRODUCT_NAME,
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
  });

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
