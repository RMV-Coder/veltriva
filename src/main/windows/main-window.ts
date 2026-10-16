import { join } from 'node:path';

import { app, BaseWindow, nativeTheme, WebContentsView } from 'electron';
import type { WebPreferences } from 'electron';

import { fillRect } from '../../core/layout/rect';
import { PRODUCT_NAME } from '../../shared/constants/app-identity';

// Matches the shell's CSS background, so the window never flashes a different colour first.
const WINDOW_BACKGROUND = { light: '#ffffff', dark: '#0a0a0a' } as const;

// The trusted shell UI (ADR-0002 §5, assessment §6.2). The renderer is sandboxed and isolated
// and has no Node; its only bridge to main is the preload's frozen `window.veltriva` object.
const SHELL_WEB_PREFERENCES = {
  preload: join(__dirname, '../preload/shell.js'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  devTools: !app.isPackaged,
} as const satisfies WebPreferences;

/** One `BaseWindow` holding the shell view. Tabs arrive in M1.3. */
export function createMainWindow(): BaseWindow {
  const window = new BaseWindow({
    title: PRODUCT_NAME,
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: nativeTheme.shouldUseDarkColors
      ? WINDOW_BACKGROUND.dark
      : WINDOW_BACKGROUND.light,
  });

  const shell = createShellView();
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

  loadShell(shell);
  return window;
}

function createShellView(): WebContentsView {
  const view = new WebContentsView({ webPreferences: SHELL_WEB_PREFERENCES });
  // Transparent view background (ADR-0006, option A′): CSS paints the opaque state, and an
  // overlay can later clear it to show the tab underneath.
  view.setBackgroundColor('#00000000');

  // The shell never navigates or opens windows. M1.2 replaces this with the global
  // web-contents guard, which assigns every web contents a role and its policy.
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  return view;
}

function loadShell(view: WebContentsView): void {
  // `import.meta.env.DEV` is a build-time constant: production builds don't contain this branch.
  const devServerUrl =
    import.meta.env.DEV && !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

  const loading =
    devServerUrl === undefined
      ? view.webContents.loadFile(join(__dirname, '../renderer/index.html'))
      : view.webContents.loadURL(checkDevServerUrl(devServerUrl));

  loading.catch((error: unknown) => {
    console.error('The shell UI failed to load:', error);
  });
}

/** The privileged shell only ever loads the local Vite dev server in development. */
function checkDevServerUrl(raw: string): string {
  const url = new URL(raw);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !isLoopback) {
    throw new Error(`Refusing to load the shell from a non-local dev server: ${url.origin}`);
  }
  return url.href;
}
