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
}

/** More queued questions than this, and a page is spamming: the rest are refused at once. */
export const MAX_QUEUED_PROMPTS = 3;

const GONE: PromptAnswer = { decision: 'gone', remember: false };

interface Pending {
  readonly prompt: Prompt;
  readonly resolve: (answer: PromptAnswer) => void;
}

export class PromptManager {
  readonly #queues = new Map<TabId, Pending[]>();
  readonly #onChange: () => void;
  #nextId = 0;

  constructor(options: { readonly onChange: () => void }) {
    this.#onChange = options.onChange;
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
      queue.push({ prompt, resolve });
      this.#queues.set(tabId, queue);
      if (queue.length === 1) {
        this.#onChange();
      }
    });
  }

  /** The question the toolbar shows for a tab, if any. */
  current(tabId: TabId): Prompt | null {
    return this.#queues.get(tabId)?.[0]?.prompt ?? null;
  }

  /**
   * The user answered. Only the shown question can be answered: a stale id (the page already
   * went away, or an older prompt) is ignored, so a late click can't approve something else.
   */
  respond(tabId: TabId, promptId: string, answer: PromptAnswer): boolean {
    const queue = this.#queues.get(tabId);
    const head = queue?.[0];
    if (queue === undefined || head?.prompt.id !== promptId) {
      return false;
    }
    queue.shift();
    if (queue.length === 0) {
      this.#queues.delete(tabId);
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
