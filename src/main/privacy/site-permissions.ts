// The user's stored answers to sites (M5.2, assessment §7.2 "permission management"), for the
// settings page to list, change and revoke, per site:
//   - permission decisions (camera, microphone, location, notifications, clipboard): Allow or Block;
//   - "always open" for another app's links (protocol always-allow, amendment (b));
//   - the extra browser details a site asked for (client-hint opt-ins, amendment (d)).
// Each store keeps its own copy in memory and writes through; a revoked decision is deleted from
// the permission_decisions table, so the site asks again. Forgetting a site revokes all of its own.
import type { PermissionDecisions } from '../../core/permissions/permission-decisions';
import type { Decision, PromptedPermission } from '../../core/permissions/permission-policy';
import type { ClientHintOptIns } from '../../core/net/client-hints';
import { siteOf } from '../../core/url/site';
import type { PermissionsView } from '../../shared/contracts/schemas';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';

const PROTOCOL_PREFIX = 'protocol:';

export interface SitePermissionsOptions {
  readonly decisions: Pick<PermissionDecisions, 'list' | 'set' | 'forget'>;
  readonly protocols: {
    alwaysAllowed(): readonly { readonly site: string; readonly scheme: string }[];
    revoke(site: string, scheme: string): boolean;
  };
  readonly clientHints: Pick<ClientHintOptIns, 'entries' | 'forget'>;
  readonly data: Pick<DataClient, 'call'>;
  readonly logger: Logger;
}

export class SitePermissions {
  readonly #options: SitePermissionsOptions;

  constructor(options: SitePermissionsOptions) {
    this.#options = options;
  }

  view(): PermissionsView {
    return {
      decisions: this.#options.decisions.list(),
      protocols: this.#options.protocols
        .alwaysAllowed()
        .map(({ site, scheme }) => ({ origin: site, scheme })),
      clientHints: this.#options.clientHints
        .entries()
        .map(({ origin, hints }) => ({ origin, hints: [...hints] })),
    };
  }

  /** Allow or Block from now on (written through, as a prompt's answer is), or revoke: null. */
  setDecision(origin: string, permission: PromptedPermission, decision: Decision | null): boolean {
    if (decision !== null) {
      this.#options.decisions.set(origin, [permission], decision);
      return true;
    }
    if (!this.#options.decisions.forget(origin, permission)) {
      return false;
    }
    this.#delete(origin, permission);
    return true;
  }

  /** The next link to that app from the site asks again. */
  revokeProtocol(origin: string, scheme: string): boolean {
    if (!this.#options.protocols.revoke(origin, scheme)) {
      return false;
    }
    this.#delete(origin, `${PROTOCOL_PREFIX}${scheme}`);
    return true;
  }

  /** The site's next page load may ask for them again. The document is written by its writer. */
  revokeClientHints(origin: string): boolean {
    return this.#options.clientHints.forget(origin);
  }

  /** Revokes everything the site's own origins were given ("forget this site"). */
  forgetSite(site: string): void {
    const ofSite = (origin: string): boolean => siteOf(origin) === site;
    const view = this.view();
    for (const origin of new Set(view.decisions.map((entry) => entry.origin))) {
      if (ofSite(origin) && this.#options.decisions.forget(origin)) {
        this.#delete(origin, undefined);
      }
    }
    for (const { origin, scheme } of view.protocols) {
      if (ofSite(origin)) {
        this.revokeProtocol(origin, scheme);
      }
    }
    for (const { origin } of view.clientHints) {
      if (ofSite(origin)) {
        this.revokeClientHints(origin);
      }
    }
  }

  #delete(origin: string, permission: string | undefined): void {
    this.#options.data
      .call('permissions.delete', permission === undefined ? { origin } : { origin, permission })
      .catch(() => {
        this.#options.logger.warn('sitePermissions.writeFailed');
      });
  }
}
