// HTTP authentication (assessment §3.7): Electron cancels it unless the app answers `login`. The
// MVP asks in the toolbar's strip, in trusted UI outside the page area (threat T6), and passes the
// answer to Chromium once. Credentials are never stored, logged or shown again.
//   - Only for a tab's page, and only for a navigation or a request to the page's own origin: a
//     cross-origin image or script asking for a password is a phishing trick Chrome blocks too.
//   - The prompt names the server from main's parse of the request URL. The realm is the server's
//     own text, so it is cleaned and shown as such.
//   - Proxy authentication is cancelled in the MVP (no proxy settings yet).
//   - After three refused tries in a row the server stops getting prompts for that tab.
import type { AuthenticationResponseDetails, AuthInfo, WebContents } from 'electron';

import { isPromptableOrigin, originOf } from '../../core/permissions/permission-policy';
import { originLabel } from '../../core/url/display';
import type { Logger } from '../platform/logger';
import type { PromptManager } from '../prompts/prompt-manager';
import type { TabId } from '../tabs/tab-manager';
import type { LoginHandler } from '../web/session-baseline';

/** Tries in a row (wrong passwords) before a server stops getting prompts for a tab. */
export const MAX_SIGN_IN_ATTEMPTS = 3;
const MAX_REALM_LENGTH = 100;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function cleanRealm(realm: string): string {
  return realm.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REALM_LENGTH);
}

export function createLoginHandler(options: {
  readonly prompts: PromptManager;
  readonly tabIdOf: (contents: WebContents) => TabId | undefined;
  readonly logger: Logger;
}): LoginHandler {
  const attempts = new Map<string, number>();

  return (
    contents: WebContents | null,
    details: AuthenticationResponseDetails,
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void,
  ): boolean => {
    if (authInfo.isProxy) {
      options.logger.warn('auth.proxyCancelled');
      return false;
    }
    const tabId =
      contents === null || contents.isDestroyed() ? undefined : options.tabIdOf(contents);
    const serverOrigin = originOf(details.url);
    if (contents === null || tabId === undefined || serverOrigin === null) {
      return false;
    }
    if (!details.isRequestForNavigation && serverOrigin !== originOf(contents.getURL())) {
      options.logger.warn('auth.crossOriginRefused');
      return false;
    }
    const key = `${tabId} ${serverOrigin}`;
    const tries = details.firstAuthAttempt ? 1 : (attempts.get(key) ?? 0) + 1;
    attempts.set(key, tries);
    if (tries > MAX_SIGN_IN_ATTEMPTS) {
      options.logger.warn('auth.tooManyAttempts');
      return false;
    }

    options.prompts
      .ask(tabId, {
        kind: 'http-auth',
        site: originLabel(details.url),
        realm: cleanRealm(authInfo.realm),
        secure: isPromptableOrigin(serverOrigin),
      })
      .then((answer) => {
        if (answer.decision === 'allow' && answer.credentials !== undefined) {
          callback(answer.credentials.username, answer.credentials.password);
        } else {
          callback();
        }
      })
      .catch(() => {
        callback();
      });
    return true;
  };
}
