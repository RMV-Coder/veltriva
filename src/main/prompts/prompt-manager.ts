// The questions Veltriva asks the user about a tab's page: permissions and other apps' links
// (ADR-0002 §4). They are shown in the trusted toolbar, outside the page area (threat T6), one at
// a time per tab; a new document, a crash or closing the tab dismisses them. Every prompt names
// the site from main's own record of the tab's URL, never from anything the page says. No
// Electron here, so the queueing rules are unit-tested.
import type { PromptedPermission } from '../../core/permissions/permission-policy';
import type { TabId } from '../tabs/tab-manager';

export type PromptRequest =
  | {
      readonly kind: 'permission';
      /** `originLabel` of the page that asks. */
      readonly site: string;
      readonly permissions: readonly PromptedPermission[];
    }
  | {
      readonly kind: 'external-protocol';
      /** `originLabel` of the page that asks, or null when the user typed the address. */
      readonly site: string | null;
      readonly scheme: string;
      /** The app Windows would open, or '' when none is registered or it's unknown. */
      readonly appName: string;
      /** Whether "always allow this site" can be offered (only for a site). */
      readonly canRemember: boolean;
    }
  | {
      /** HTTP authentication (Basic, Digest, NTLM): a sign-in form the shell draws. */
      readonly kind: 'http-auth';
      /** `originLabel` of the server that asks. */
      readonly site: string;
      /** The server's own words for what to sign in to, cleaned (src/main/auth/sign-in.ts). */
      readonly realm: string;
      /** Whether the password goes over HTTPS or to this machine; otherwise the shell warns. */
      readonly secure: boolean;
    }
  | {
      /**
       * The user closed the tab and its page objected (`beforeunload`, M3.3): leave anyway? Allow
       * leaves; anything else stays. Pages never write the text: Chromium ignores theirs too.
       */
      readonly kind: 'leave-page';
      /** `originLabel` of the page. */
      readonly site: string;
    };

export type Prompt = PromptRequest & { readonly id: string };

/**
 * `dismiss`: the user closed the prompt without answering. `gone`: nobody answered, because the
 * page went away or the page asked too often; it never counts against the site.
 */
export type PromptDecision = 'allow' | 'block' | 'dismiss' | 'gone';

export interface PromptAnswer {
  readonly decision: PromptDecision;
  /** The user ticked "always allow" (external protocols only). */
  readonly remember: boolean;
  /** What the user typed into a sign-in prompt. Passed on once and never stored. */
  readonly credentials?: { readonly username: string; readonly password: string };
}

/** More queued questions than this, and a page is spamming: the rest are refused at once. */
export const MAX_QUEUED_PROMPTS = 3;

/**
 * A yes counts only once its question has been on screen this long. With questions queued, a
 * double click on Allow would otherwise approve the next one too (a camera right after a
 * location). Chrome's prompts ignore input for a double-click interval in the same way. The time
 * counts from when the question is shown: its tab selected, and nothing covering the strip (a
 * page in fullscreen). It starts again each time the tab comes back. A no is never delayed.
 */
export const MIN_VISIBLE_BEFORE_ALLOW_MS = 500;

const GONE: PromptAnswer = { decision: 'gone', remember: false };

interface Pending {
  readonly prompt: Prompt;
  readonly resolve: (answer: PromptAnswer) => void;
  /** When it last appeared on screen, or undefined while it isn't shown. */
  shownAt: number | undefined;
}

export class PromptManager {
  readonly #queues = new Map<TabId, Pending[]>();
  readonly #onChange: () => void;
  readonly #now: () => number;
  /** The tab whose question the toolbar shows right now, if any. */
  #visibleTab: TabId | null = null;
  #nextId = 0;

  readonly #onShown: ((prompt: Prompt) => void) | undefined;

  constructor(options: {
    readonly onChange: () => void;
    readonly now?: () => number;
    /** A question just appeared on screen (a sign-in form needs the keyboard). */
    readonly onShown?: (prompt: Prompt) => void;
  }) {
    this.#onChange = options.onChange;
    this.#now = options.now ?? Date.now;
    this.#onShown = options.onShown;
  }

  #show(pending: Pending, now: number): void {
    pending.shownAt = now;
    this.#onShown?.(pending.prompt);
  }

  /**
   * Queues a question for a tab. It resolves with the user's answer, or with `gone` when the page
   * goes away first or too many questions are already waiting.
   */
  ask(tabId: TabId, request: PromptRequest): Promise<PromptAnswer> {
    const queue = this.#queues.get(tabId) ?? [];
    if (queue.length >= MAX_QUEUED_PROMPTS) {
      return Promise.resolve(GONE);
    }
    this.#nextId += 1;
    const prompt: Prompt = { ...request, id: `prompt-${String(this.#nextId)}` };
    return new Promise((resolve) => {
      const pending: Pending = { prompt, resolve, shownAt: undefined };
      queue.push(pending);
      this.#queues.set(tabId, queue);
      if (queue.length === 1 && tabId === this.#visibleTab) {
        this.#show(pending, this.#now());
      }
      if (queue.length === 1) {
        this.#onChange();
      }
    });
  }

  /**
   * Which tab's question is on screen: the selected tab's, or none while a page is fullscreen.
   * Main calls this whenever either changes.
   */
  setVisibleTab(tabId: TabId | null): void {
    if (tabId === this.#visibleTab) {
      return;
    }
    const hidden = this.#visibleTab === null ? undefined : this.#queues.get(this.#visibleTab)?.[0];
    if (hidden !== undefined) {
      hidden.shownAt = undefined;
    }
    this.#visibleTab = tabId;
    const shown = tabId === null ? undefined : this.#queues.get(tabId)?.[0];
    if (shown !== undefined) {
      this.#show(shown, this.#now());
    }
  }

  /** The question the toolbar shows for a tab, if any. */
  current(tabId: TabId): Prompt | null {
    return this.#queues.get(tabId)?.[0]?.prompt ?? null;
  }

  /**
   * The user answered. Only the shown question can be answered: a stale id (the page already
   * went away, or an older prompt) is ignored, so a late click can't approve something else. A yes
   * that comes too soon after the question appeared is ignored too, and the question stays.
   */
  respond(tabId: TabId, promptId: string, answer: PromptAnswer): boolean {
    const queue = this.#queues.get(tabId);
    const head = queue?.[0];
    if (queue === undefined || head?.prompt.id !== promptId) {
      return false;
    }
    const now = this.#now();
    if (
      answer.decision === 'allow' &&
      (head.shownAt === undefined || now - head.shownAt < MIN_VISIBLE_BEFORE_ALLOW_MS)
    ) {
      return false;
    }
    queue.shift();
    const next = queue[0];
    if (next === undefined) {
      this.#queues.delete(tabId);
    } else if (tabId === this.#visibleTab) {
      this.#show(next, now);
    }
    head.resolve(answer);
    this.#onChange();
    return true;
  }

  /** The tab's page went away (new document, crash, close): its questions no longer apply. */
  dismissAll(tabId: TabId): void {
    const queue = this.#queues.get(tabId);
    if (queue === undefined) {
      return;
    }
    this.#queues.delete(tabId);
    for (const pending of queue) {
      pending.resolve(GONE);
    }
    this.#onChange();
  }

  /** Every tab's questions, for the window closing. */
  dispose(): void {
    for (const tabId of [...this.#queues.keys()]) {
      this.dismissAll(tabId);
    }
  }
}
