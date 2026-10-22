// The user's site rules (assessment §5.3, §5.7, M5.1), kept in memory for the decisions main makes
// synchronously, and written through to the site_rules table:
//   - protect: automation leaves every tab on the site alone (§4.10 "Protected site", M3.4);
//   - exclude from the memory: no page or visit is recorded (the data worker checks the table
//     itself), its tabs are never auto-archived, and closing one keeps no record.
// A site is what core/url/site.ts gives: the registrable domain of a page's host. A site with no
// rule left has no row. Writes go out in order on the data client; one that fails is logged by
// code and the rule stays as the user set it for this run.
import { siteOf } from '../../core/url/site';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';

/** At most this many sites have a rule: a list the user keeps by hand. */
export const MAX_SITE_RULES = 1000;

export interface SiteRule {
  readonly site: string;
  readonly protect: boolean;
  readonly excludeMemory: boolean;
}

export interface SiteRulesOptions {
  readonly data: Pick<DataClient, 'call'> | null;
  readonly logger: Logger;
  /** The rules as stored (siteRules.list), read at startup. */
  readonly stored: readonly SiteRule[];
  readonly now?: () => number;
  /** A rule changed: automation and the shell look again. */
  readonly onChange?: () => void;
}

export class SiteRules {
  readonly #rules = new Map<string, SiteRule>();
  readonly #options: SiteRulesOptions;

  constructor(options: SiteRulesOptions) {
    this.#options = options;
    for (const rule of options.stored) {
      if ((rule.protect || rule.excludeMemory) && this.#rules.size < MAX_SITE_RULES) {
        this.#rules.set(rule.site, {
          site: rule.site,
          protect: rule.protect,
          excludeMemory: rule.excludeMemory,
        });
      }
    }
  }

  /** Every rule, by site. */
  list(): SiteRule[] {
    return [...this.#rules.values()].sort((a, b) =>
      a.site < b.site ? -1 : a.site > b.site ? 1 : 0,
    );
  }

  isProtected(site: string): boolean {
    return this.#rules.get(site)?.protect === true;
  }

  isExcluded(site: string): boolean {
    return this.#rules.get(site)?.excludeMemory === true;
  }

  /** Whether the page at `url` is on a protected site. */
  protectsUrl(url: string): boolean {
    const site = siteOf(url);
    return site !== null && this.isProtected(site);
  }

  /** Whether the page at `url` is on a site excluded from the memory. */
  excludesUrl(url: string): boolean {
    const site = siteOf(url);
    return site !== null && this.isExcluded(site);
  }

  /**
   * Changes the site's rules; a field left out keeps its value. False when the site would be one
   * more than the list holds, and nothing changes.
   */
  set(
    site: string,
    change: {
      readonly protect?: boolean | undefined;
      readonly excludeMemory?: boolean | undefined;
    },
  ): boolean {
    const before = this.#rules.get(site);
    const next: SiteRule = {
      site,
      protect: change.protect ?? before?.protect ?? false,
      excludeMemory: change.excludeMemory ?? before?.excludeMemory ?? false,
    };
    if (before?.protect === next.protect && before.excludeMemory === next.excludeMemory) {
      return true;
    }
    const keep = next.protect || next.excludeMemory;
    if (keep && before === undefined && this.#rules.size >= MAX_SITE_RULES) {
      return false;
    }
    if (!keep && before === undefined) {
      return true;
    }
    if (keep) {
      this.#rules.set(site, next);
    } else {
      this.#rules.delete(site);
    }
    this.#options.data
      ?.call('siteRules.set', {
        site,
        protect: next.protect,
        excludeMemory: next.excludeMemory,
        at: (this.#options.now ?? Date.now)(),
      })
      .catch(() => {
        this.#options.logger.warn('siteRules.writeFailed');
      });
    this.#options.onChange?.();
    return true;
  }
}
