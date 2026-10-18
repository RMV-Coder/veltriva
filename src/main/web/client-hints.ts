// User-agent client hints for the browsing session (src/core/net/client-hints.ts has the rules).
// Electron's Chromium sends no `Sec-CH-UA*` on navigations and ignores `Accept-CH`, so main adds
// what Chrome would send, from the values Chromium itself reports: the shell (a secure context on
// the same Chromium) reads `navigator.userAgentData` once it has loaded. That happens before the
// user can reach any web page: the first tab is the internal new-tab page, and every web
// navigation starts from the shell. Until then, requests go out as Chromium makes them.
import type { OnBeforeSendHeadersListenerDetails, Session, WebContents } from 'electron';
import { z } from 'zod';

import { ClientHintOptIns, hintsToAdd } from '../../core/net/client-hints';
import type { UserAgentData } from '../../core/net/client-hints';
import type { Logger } from '../platform/logger';

const text = z.string().max(200);
const brands = z.array(z.object({ brand: text, version: text })).max(10);

/** What the shell reports, checked before it reaches a header (the shell is trusted, not exempt). */
const userAgentDataSchema = z.object({
  brands,
  mobile: z.boolean(),
  platform: text,
  architecture: text,
  bitness: text,
  formFactors: z.array(text).max(10),
  fullVersionList: brands,
  uaFullVersion: text,
  model: text,
  platformVersion: text,
  wow64: z.boolean(),
});

const READ_USER_AGENT_DATA = `navigator.userAgentData.getHighEntropyValues([
  'architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion',
  'uaFullVersion', 'wow64',
])`;

function isDocument(resourceType: OnBeforeSendHeadersListenerDetails['resourceType']): boolean {
  return resourceType === 'mainFrame' || resourceType === 'subFrame';
}

/** A response header's value, whatever the case of its name; repeated headers are joined. */
function headerValue(
  headers: Record<string, string[]> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const values = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, value]) => value);
  return values.length === 0 ? undefined : values.join(', ');
}

export class ClientHints {
  readonly #logger: Logger;
  readonly #optIns = new ClientHintOptIns();
  #data: UserAgentData | null = null;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** Whether Chromium's values are known, so requests get the hints. */
  ready(): boolean {
    return this.#data !== null;
  }

  /** Adds the hints to `session`'s requests. It must have no other listener for these events. */
  attach(session: Session): void {
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const added = hintsToAdd(
        {
          url: details.url,
          isDocument: isDocument(details.resourceType),
          headers: details.requestHeaders,
        },
        this.#data,
        this.#optIns.for(details.url),
      );
      callback(
        Object.keys(added).length === 0
          ? {}
          : { requestHeaders: { ...details.requestHeaders, ...added } },
      );
    });
    session.webRequest.onHeadersReceived((details, callback) => {
      // As in Chrome, only a top-level page's Accept-CH counts.
      if (details.resourceType === 'mainFrame') {
        const acceptCh = headerValue(details.responseHeaders, 'accept-ch');
        if (acceptCh !== undefined) {
          this.#optIns.remember(details.url, acceptCh);
        }
      }
      callback({});
    });
  }

  /** Reads Chromium's values from `shell`, a loaded secure-context page of Veltriva's own. */
  async readFrom(shell: WebContents): Promise<void> {
    try {
      const parsed = userAgentDataSchema.safeParse(
        await shell.executeJavaScript(READ_USER_AGENT_DATA),
      );
      if (!parsed.success) {
        this.#logger.warn('clientHints.unreadable');
        return;
      }
      this.#data = parsed.data;
    } catch {
      this.#logger.warn('clientHints.unreadable');
    }
  }
}
