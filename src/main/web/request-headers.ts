// The browsing session's header rules. Electron allows one `webRequest` listener per event and
// session, so every rule that changes a page's request or reads its response goes through here:
//   1. client hints Chromium leaves out (./client-hints.ts);
//   2. the per-site user agent, Firefox's for Google's sign-in (src/core/net/site-user-agent.ts).
import type { Session } from 'electron';

import { userAgentOverride } from '../../core/net/site-user-agent';
import type { ClientHints } from './client-hints';

export interface RequestHeaderRules {
  readonly clientHints: ClientHints;
  readonly now?: () => number;
}

/** Installs the rules on `session`. It must have no other listener for these events. */
export function installRequestHeaders(session: Session, rules: RequestHeaderRules): void {
  const now = rules.now ?? Date.now;

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const hints = rules.clientHints.headersFor(details);
    const userAgent = userAgentOverride(details.url, now());
    if (Object.keys(hints).length === 0 && userAgent === null) {
      callback({});
      return;
    }
    const headers: Record<string, string> = { ...details.requestHeaders, ...hints };
    callback({
      requestHeaders:
        userAgent === null
          ? headers
          : {
              // Whatever case Chromium used for it, the one User-Agent is Firefox's.
              ...Object.fromEntries(
                Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'user-agent'),
              ),
              'User-Agent': userAgent,
            },
    });
  });

  session.webRequest.onHeadersReceived((details, callback) => {
    rules.clientHints.noteResponse(details);
    callback({});
  });
}
