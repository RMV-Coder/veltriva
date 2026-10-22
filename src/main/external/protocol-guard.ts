// The external-protocol guard (ADR-0002 §4, assessment §6.4): the one way a page, a popup or the
// address bar can open another app. Electron would hand any scheme it can't load to Windows with
// no prompt and no gesture, so every path goes through here instead:
//   - a page navigating to another app's URL (cancelled by the navigation guard, src/main/web/guard.ts);
//   - window.open('custom:…') (the popup policy, src/main/popups/popup-policy.ts);
//   - the omnibox's `external` outcome (typed input counts as a gesture).
// (The `openExternal` permission is refused outright by the permission broker.)
// Always-blocked schemes never launch. Everything else needs a recent trusted gesture and the
// user's yes in the toolbar, unless they chose "always allow" for that site and scheme (kept in
// the database since M2.2b, as a `protocol:<scheme>` decision). The launch gets only the parsed, escaped, length-capped URL.
import { originOf } from '../../core/permissions/permission-policy';
import { originLabel } from '../../core/url/display';
import { classifyExternalUrl } from '../../core/url/external-protocol';
import type { Logger } from '../platform/logger';
import type { PromptManager } from '../prompts/prompt-manager';
import type { TabId } from '../tabs/tab-manager';

/** Hands a URL to Windows (`shell.openExternal`), or records it in a test build. */
export type Launcher = (url: string) => Promise<void>;

export interface ExternalRequest {
  readonly tabId: TabId;
  readonly url: string;
  /** The URL of the page that asks, or null when the user typed the address. */
  readonly pageUrl: string | null;
  /** A trusted gesture in that page just now, or typed input. */
  readonly gesture: boolean;
}

export type ExternalOutcome = 'launched' | 'blocked' | 'declined' | 'failed';

/** Longest app name shown; a registry value is not ours to trust with layout. */
const MAX_APP_NAME_LENGTH = 64;
/** Controls and invisible formatting (bidi overrides) never reach the prompt. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export class ExternalProtocolGuard {
  readonly #prompts: PromptManager;
  readonly #appNameFor: (url: string) => string;
  readonly #launch: Launcher;
  readonly #logger: Logger;
  /** Site origin → schemes the user allowed without asking again. */
  readonly #alwaysAllowed = new Map<string, Set<string>>();
  readonly #onAlwaysAllowed: ((site: string, scheme: string) => void) | undefined;

  constructor(options: {
    readonly prompts: PromptManager;
    readonly appNameFor: (url: string) => string;
    readonly launch: Launcher;
    readonly logger: Logger;
    /** Stored "always allow" answers, as (site origin, scheme) pairs (M2.2b). */
    readonly alwaysAllowed?: Iterable<{ readonly site: string; readonly scheme: string }>;
    /** Called when the user ticks "always allow", to store it. */
    readonly onAlwaysAllowed?: (site: string, scheme: string) => void;
  }) {
    this.#prompts = options.prompts;
    this.#onAlwaysAllowed = options.onAlwaysAllowed;
    for (const { site, scheme } of options.alwaysAllowed ?? []) {
      this.#allow(site, scheme);
    }
    this.#appNameFor = options.appNameFor;
    this.#launch = options.launch;
    this.#logger = options.logger;
  }

  /** Every "always allow", by site origin, then scheme (M5.2: the settings page lists them). */
  alwaysAllowed(): { readonly site: string; readonly scheme: string }[] {
    return [...this.#alwaysAllowed]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([site, schemes]) => [...schemes].sort().map((scheme) => ({ site, scheme })));
  }

  /** Forgets an "always allow" (M5.2): the next link to that app asks again. */
  revoke(site: string, scheme: string): boolean {
    const schemes = this.#alwaysAllowed.get(site);
    const had = schemes?.delete(scheme) ?? false;
    if (schemes?.size === 0) {
      this.#alwaysAllowed.delete(site);
    }
    return had;
  }

  #allow(site: string, scheme: string): void {
    const schemes = this.#alwaysAllowed.get(site) ?? new Set<string>();
    schemes.add(scheme);
    this.#alwaysAllowed.set(site, schemes);
  }

  async request(request: ExternalRequest): Promise<ExternalOutcome> {
    const verdict = classifyExternalUrl(request.url);
    if (verdict.kind !== 'external') {
      this.#logger.warn('external.refused', {
        kind: verdict.kind,
        scheme: verdict.kind === 'invalid' ? undefined : verdict.scheme,
      });
      return 'blocked';
    }
    const { scheme, url } = verdict;
    if (!request.gesture) {
      // Pages that try to launch an app on load (or from a timer) get nothing, not even a prompt.
      this.#logger.warn('external.noGesture', { scheme });
      return 'blocked';
    }
    let site: string | null = null;
    let label: string | null = null;
    if (request.pageUrl !== null) {
      site = originOf(request.pageUrl);
      if (site === null) {
        // about:blank, data: or file: pages have no site to name in a prompt.
        this.#logger.warn('external.noSite', { scheme });
        return 'blocked';
      }
      label = originLabel(request.pageUrl);
    }

    if (site === null || this.#alwaysAllowed.get(site)?.has(scheme) !== true) {
      const answer = await this.#prompts.ask(request.tabId, {
        kind: 'external-protocol',
        site: label,
        scheme,
        appName: this.#safeAppName(url),
        canRemember: site !== null,
      });
      if (answer.decision !== 'allow') {
        return 'declined';
      }
      if (answer.remember && site !== null) {
        this.#allow(site, scheme);
        this.#onAlwaysAllowed?.(site, scheme);
      }
    }

    try {
      await this.#launch(url);
      return 'launched';
    } catch (error: unknown) {
      this.#logger.warn('external.launchFailed', {
        scheme,
        message: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }

  #safeAppName(url: string): string {
    let name: string;
    try {
      name = this.#appNameFor(url);
    } catch {
      return '';
    }
    return name.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_APP_NAME_LENGTH);
  }
}
