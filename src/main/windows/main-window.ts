import { BaseWindow, nativeTheme } from 'electron';
import type { Session, WebContentsView } from 'electron';

import { fillRect } from '../../core/layout/rect';
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

/** One `BaseWindow` holding the shell view. Tabs arrive in M1.3. */
export function createMainWindow(options: {
  readonly shellSession: Session;
  readonly shellUrl: string;
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

  const layout = (): void => {
    const { width, height } = window.getContentBounds();
    shell.setBounds(fillRect({ width, height }));
  };
  layout();
  window.on('resize', layout);

  // A BaseWindow never destroys its views' web contents (ADR-0002 §2): close them explicitly.
  window.on('closed', () => {
    shell.webContents.close();
  });

  shell.webContents.loadURL(options.shellUrl).catch((error: unknown) => {
    console.error('The shell UI failed to load:', error);
  });
  return { window, shell };
}
