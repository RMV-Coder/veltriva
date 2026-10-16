import { useEffect } from 'react';

import { FullscreenNotice } from '../features/fullscreen/FullscreenNotice';
import { startWorkspaceSync, useFullscreenNotice } from '../state/workspace-store';
import { BrowserShell } from './BrowserShell';

/**
 * The shell is advisory. It renders the workspace snapshots main sends and answers with typed
 * commands; main decides every tab and navigation outcome (ADR-0005).
 *
 * Normally it draws the browser UI (`BrowserShell`). While a page is fullscreen and main wants the
 * notice shown, it draws only the notice: main raises the shell above the page for that, and
 * toolbar, sidebar and content area would cover the page (ADR-0006 A′).
 */
export function App() {
  const notice = useFullscreenNotice();

  useEffect(() => startWorkspaceSync(), []);

  // Keyed by tab: a notice for another tab is a new notice, which main waits to see painted.
  return notice === null ? (
    <BrowserShell />
  ) : (
    <FullscreenNotice key={notice.tabId} origin={notice.origin} />
  );
}
