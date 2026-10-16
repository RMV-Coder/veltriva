// Hardened webPreferences per role (ADR-0002 §5, assessment §6.2).
import { app } from 'electron';
import type { Session, WebPreferences } from 'electron';

import { BROWSING_PARTITION } from '../../shared/constants/app-identity';

/** The trusted shell UI: sandboxed, isolated, no Node, its own session, one preload. */
export function shellWebPreferences(options: {
  readonly session: Session;
  readonly preload: string;
}): WebPreferences {
  return {
    session: options.session,
    preload: options.preload,
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
    // The omnibox and other shell inputs shouldn't be spellchecked.
    spellcheck: false,
    devTools: !app.isPackaged,
  };
}

/**
 * A popup window's address bar (src/main/windows/popup-windows.ts): trusted UI on the shell's
 * session and protocol, but with no preload and so no IPC. Main pushes the text it shows.
 */
export function popupBarWebPreferences(session: Session): WebPreferences {
  return {
    session,
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
    spellcheck: false,
    devTools: !app.isPackaged,
  };
}

/** Untrusted web content. Deliberately no `preload`: tabs have no channel to main. */
export const TAB_WEB_PREFERENCES = {
  partition: BROWSING_PARTITION,
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
  spellcheck: true,
  backgroundThrottling: true,
} as const satisfies WebPreferences;
