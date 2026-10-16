// The permission broker (ADR-0002 §4, assessment §6.4): the request and check handlers of the
// browsing session. It replaces M1.2's deny-all with the allow-list in
// src/core/permissions/permission-policy.ts:
//   - granted without asking: `clipboard-sanitized-write`, and `fullscreen` in tabs (with its
//     origin notice, src/main/windows/fullscreen.ts);
//   - asked in the toolbar, remembered per origin for the session: camera and microphone
//     (`media`), `geolocation`, `notifications`, `clipboard-read`;
//   - `openExternal`: always refused. A page's link to another app is cancelled earlier, in
//     `will-frame-navigate` or `will-redirect`, and handed to the external-protocol guard with
//     its real frame (measured on Electron 44: no `openExternal` request follows). The request
//     itself can't be trusted to name the frame (spike S7: an iframe's arrives as the main
//     frame's), so it is only a backstop and never launches anything;
//   - everything else, pointer lock included: denied.
// An embedded page from another site never gets a prompt: it would appear in the name of the site
// in the address bar (measured on Electron 44: such a request arrives with `isMainFrame: false`
// and the frame's own URL). Popup windows don't prompt either; there's no trusted place for it
// in them yet.
import type { Session, WebContents } from 'electron';

import { PermissionDecisions } from '../../core/permissions/permission-decisions';
import {
  classifyRequest,
  isPermissionGranted,
  originOf,
} from '../../core/permissions/permission-policy';
import type { RequesterRole } from '../../core/permissions/permission-policy';
import { originLabel } from '../../core/url/display';
import type { Logger } from '../platform/logger';
import type { PromptManager } from '../prompts/prompt-manager';
import type { TabId } from '../tabs/tab-manager';
import { roleOf } from '../web/roles';

export interface PermissionBrokerOptions {
  readonly prompts: PromptManager;
  readonly decisions?: PermissionDecisions;
  /** The tab a web contents belongs to, if it's a tab's. */
  readonly tabIdOf: (contents: WebContents) => TabId | undefined;
  readonly logger: Logger;
}

function requesterRole(contents: WebContents | null): RequesterRole {
  if (contents === null || contents.isDestroyed()) {
    return 'other';
  }
  switch (roleOf(contents)) {
    case 'tab':
      return 'tab';
    case 'popup':
      return 'popup';
    default:
      return 'other';
  }
}

/** Installs the broker on the browsing session. Call before any tab exists. */
export function installPermissionBroker(
  session: Session,
  options: PermissionBrokerOptions,
): PermissionDecisions {
  const decisions = options.decisions ?? new PermissionDecisions();
  const { prompts, logger } = options;

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const role = requesterRole(contents);
    const pageUrl = role === 'other' ? '' : contents.getURL();
    const topOrigin = originOf(pageUrl) ?? 'null';
    const requestingOrigin = originOf(details.requestingUrl) ?? 'null';
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const verdict = classifyRequest({
      permission,
      ...(mediaTypes === undefined ? {} : { mediaTypes }),
      requestingOrigin,
      topOrigin,
      role,
    });

    switch (verdict.kind) {
      case 'grant':
        callback(true);
        return;
      case 'deny':
        logger.warn('permission.denied', { permission, reason: verdict.reason, role });
        callback(false);
        return;
      case 'external':
        logger.warn('permission.openExternalRefused', { role, mainFrame: details.isMainFrame });
        callback(false);
        return;
      case 'prompt':
        break;
    }

    const tabId = options.tabIdOf(contents);
    if (tabId === undefined) {
      callback(false);
      return;
    }
    const { origin, permissions } = verdict;
    if (permissions.some((asked) => decisions.get(origin, asked) === 'block')) {
      callback(false);
      return;
    }
    const undecided = permissions.filter((asked) => decisions.get(origin, asked) === undefined);
    if (undecided.length === 0) {
      callback(true);
      return;
    }
    prompts
      .ask(tabId, { kind: 'permission', site: originLabel(pageUrl), permissions: undecided })
      .then((answer) => {
        switch (answer.decision) {
          case 'allow':
            decisions.set(origin, undecided, 'allow');
            callback(true);
            return;
          case 'block':
            decisions.set(origin, undecided, 'block');
            callback(false);
            return;
          case 'dismiss':
            decisions.dismissed(origin, undecided);
            callback(false);
            return;
          case 'gone':
            callback(false);
            return;
        }
      })
      .catch(() => {
        callback(false);
      });
  });

  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const role = requesterRole(contents);
    if (contents === null || role === 'other') {
      return false;
    }
    const topOrigin = originOf(details.embeddingOrigin ?? contents.getURL()) ?? 'null';
    return isPermissionGranted(
      {
        permission,
        ...(details.mediaType === undefined ? {} : { mediaType: details.mediaType }),
        requestingOrigin: originOf(requestingOrigin) ?? 'null',
        topOrigin,
        role,
      },
      (origin, asked) => decisions.get(origin, asked),
    );
  });

  return decisions;
}
