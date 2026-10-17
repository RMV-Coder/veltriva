// What the M1.4a specs share about the toolbar's prompt strip (src/renderer/features/prompts): its
// locators, the answers a user gives, and the snapshot main sends the shell (`tabs[i].prompt` and
// `tabs[i].blockedPopups`).
//
// The strip is `[data-prompt-strip]`, with `data-prompt-kind` (`permission`, `external-protocol` or
// `blocked-popups`) and `data-prompt-id`. Its buttons are found by role and name, as everything in
// the shell is. A yes ("Allow", "Open") counts only after `MIN_VISIBLE_BEFORE_ALLOW_MS` (ADR-0002
// item 9), so `clickYes` waits before it clicks; "Block", "Cancel" and "Dismiss" count at once.
import { setTimeout as delay } from 'node:timers/promises';

import type { Locator, Page } from '@playwright/test';

import { MIN_VISIBLE_BEFORE_ALLOW_MS } from '../../src/main/prompts/prompt-manager';
import type { TabSnapshot, WorkspaceSnapshot } from '../../src/shared/contracts/schemas';
import { expect } from './expect';
import type { TabId } from './hooks';
import type { PageGlobal } from './page-globals';
import { SLOW_TIMEOUT_MS } from './shell-ui';

export type StripKind = 'permission' | 'external-protocol' | 'blocked-popups';

/**
 * PRIVACY: an automated test never turns on this machine's camera or microphone and never makes a
 * real location lookup. A question that asks for any of these may be blocked, dismissed or left
 * unanswered, but never allowed. `clickYes` and `answerAsSoonAsSeen('allow')` enforce it: they throw
 * instead of answering "allow" to such a question, so no spec can do it by accident.
 */
export const NEVER_ALLOWED_PERMISSIONS: readonly string[] = ['camera', 'microphone', 'geolocation'];

/**
 * How long to wait, once the strip shows, before a yes. Main counts from the moment it asked, and
 * the shell sees the question later, so this is always more than the rule's 500 ms.
 */
export const SETTLE_BEFORE_YES_MS = MIN_VISIBLE_BEFORE_ALLOW_MS + 150;

// ── Locators ────────────────────────────────────────────────────────────────────────────────────

/** The strip, whatever it asks. */
export function promptStrip(shell: Page): Locator {
  return shell.locator('[data-prompt-strip]');
}

/** The strip, only while it is of this kind. */
export function stripOfKind(shell: Page, kind: StripKind): Locator {
  return shell.locator(`[data-prompt-strip][data-prompt-kind="${kind}"]`);
}

/** The sentence: "127.0.0.1:1234 wants to know your location", "Pop-up blocked: http://…". */
export function stripSentence(shell: Page): Locator {
  return promptStrip(shell).locator('p');
}

export type StripButtonName = 'Allow' | 'Block' | 'Dismiss' | 'Open' | 'Cancel' | 'Open pop-up';

export function stripButton(shell: Page, name: StripButtonName): Locator {
  return promptStrip(shell).getByRole('button', { name, exact: true });
}

/** The external-protocol strip's "Always allow {site} to open {scheme}: links" box. */
export function alwaysAllowBox(shell: Page): Locator {
  return promptStrip(shell).getByRole('checkbox', { name: /^Always allow .+ to open .+: links$/ });
}

// ── Waiting for a strip ─────────────────────────────────────────────────────────────────────────

/** Waits for the strip of `kind`, and returns its `data-prompt-id` (null for blocked popups). */
export async function waitForStrip(shell: Page, kind: StripKind): Promise<string | null> {
  const strip = stripOfKind(shell, kind);
  await expect(strip).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
  return strip.getAttribute('data-prompt-id');
}

/**
 * Waits for the strip of `kind` to show a question other than `previousId` (null: any), and
 * returns its id. For a second question that follows an answer: until the shell has redrawn, the
 * strip may still show the one just answered, and a click on it would be ignored as stale.
 */
export async function waitForStripAfter(
  shell: Page,
  kind: StripKind,
  previousId: string | null,
): Promise<string> {
  const seen: { id: string | null } = { id: null };
  await expect
    .poll(
      async () => {
        seen.id = await shell.evaluate((selector) => {
          const strip = (globalThis as PageGlobal).document.querySelector(selector);
          return strip === null ? null : strip.getAttribute('data-prompt-id');
        }, `[data-prompt-strip][data-prompt-kind="${kind}"]`);
        return seen.id !== null && seen.id !== previousId;
      },
      {
        message: `a ${kind} strip other than ${String(previousId)} should show`,
        timeout: SLOW_TIMEOUT_MS,
      },
    )
    .toBe(true);
  if (seen.id === null) {
    throw new Error('unreachable: the poll passed with no strip');
  }
  return seen.id;
}

/** Waits until no strip shows. */
export async function expectNoStrip(shell: Page, message?: string): Promise<void> {
  await expect(promptStrip(shell), message).toHaveCount(0);
}

/**
 * Checks that no strip appears over `windowMs`. Absence can't be awaited, so this watches the
 * snapshot's `prompt` and `blockedPopups` as well as the DOM, which is how main reports one first.
 */
export async function expectNoStripFor(
  shell: Page,
  tabId: TabId,
  windowMs = 1_500,
  message = 'no strip should appear',
): Promise<void> {
  const deadline = Date.now() + windowMs;
  do {
    const tab = await tabSnapshot(shell, tabId);
    expect(tab?.prompt ?? null, message).toBeNull();
    expect(tab?.blockedPopups ?? null, message).toBeNull();
    await expect(promptStrip(shell), message).toHaveCount(0, { timeout: 1_000 });
    await delay(100);
  } while (Date.now() < deadline);
}

// ── Answering ───────────────────────────────────────────────────────────────────────────────────

/**
 * A yes ("Allow", "Open"): waits out the 500 ms rule, then clicks. Playwright's click is a real
 * pointer event in the shell, so it also gives the keyboard back to the page, as a user's would.
 */
export async function clickYes(shell: Page, name: 'Allow' | 'Open' = 'Allow'): Promise<void> {
  await expect(stripButton(shell, name)).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
  await refuseToAllowDevices(shell);
  await delay(SETTLE_BEFORE_YES_MS);
  await stripButton(shell, name).click();
}

/**
 * Throws if the question the selected tab shows asks for the camera, the microphone or location
 * (`NEVER_ALLOWED_PERMISSIONS`). Called before every "Allow" click.
 */
async function refuseToAllowDevices(shell: Page): Promise<void> {
  const snapshot = await workspaceSnapshot(shell);
  const prompt = snapshot.tabs.find((tab) => tab.id === snapshot.selectedTabId)?.prompt;
  if (prompt?.kind !== 'permission') {
    return;
  }
  const forbidden = prompt.permissions.filter((asked) => NEVER_ALLOWED_PERMISSIONS.includes(asked));
  if (forbidden.length > 0) {
    throw new Error(
      `Refusing to Allow a question for ${forbidden.join(', ')}: automated tests never turn on ` +
        'the camera or microphone or look up the location. Block or dismiss it instead.',
    );
  }
}

/** A no ("Block", "Cancel", "Dismiss", "Open pop-up"): counts at once. */
export async function clickNow(shell: Page, name: StripButtonName): Promise<void> {
  await stripButton(shell, name).click();
}

// ── The snapshot main sends the shell ───────────────────────────────────────────────────────────

/** The workspace as the shell holds it right now. */
export async function workspaceSnapshot(shell: Page): Promise<WorkspaceSnapshot> {
  const snapshot = await shell.evaluate(async () => {
    const result = await (globalThis as PageGlobal).veltriva.workspace.getSnapshot();
    return result.ok ? result.value : null;
  });
  if (snapshot === null) {
    throw new Error('workspace.getSnapshot failed');
  }
  return snapshot;
}

/** One tab's entry in the snapshot, or undefined if there is no such tab. */
export async function tabSnapshot(shell: Page, tabId: TabId): Promise<TabSnapshot | undefined> {
  return (await workspaceSnapshot(shell)).tabs.find((tab) => tab.id === tabId);
}

export type PromptSnapshot = NonNullable<TabSnapshot['prompt']>;

/** The question a tab has, or null. */
export async function promptOf(shell: Page, tabId: TabId): Promise<PromptSnapshot | null> {
  return (await tabSnapshot(shell, tabId))?.prompt ?? null;
}

/** What `answerAsSoonAsSeen` did. Times are the shell page's `Date.now()`, so they compare with the page's. */
export interface EarlyAnswer {
  readonly promptId: string;
  /** When the shell's snapshot first showed the question. */
  readonly seenAt: number;
  /** When the answer was sent: the same task, so within a millisecond or two of `seenAt`. */
  readonly sentAt: number;
}

/**
 * Sends `decision` for the next question of `tabId` the very moment the shell's own snapshot shows
 * it, in the same task and through the same command a click uses. That is as early as an answer can
 * come: the specs for the 500 ms rule need it, because a Playwright click takes long enough that
 * on a loaded machine it could land after the 500 ms by chance. Questions with an id in `skip` are
 * passed over (an earlier one, still shown).
 */
export async function answerAsSoonAsSeen(
  shell: Page,
  tabId: TabId,
  decision: 'allow' | 'block' | 'dismiss',
  skip: readonly string[] = [],
): Promise<EarlyAnswer> {
  return shell.evaluate(
    ({ tab, how, skipped, never }) =>
      new Promise<EarlyAnswer>((resolve, reject) => {
        const veltriva = (globalThis as PageGlobal).veltriva;
        let done = false;
        let stopListening = (): void => undefined;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            stopListening();
            reject(new Error('no question appeared for the tab within 20 s'));
          }
        }, 20_000);
        const look = (snapshot: WorkspaceSnapshot): void => {
          const prompt = snapshot.tabs.find((candidate) => candidate.id === tab)?.prompt;
          if (done || prompt === null || prompt === undefined || skipped.includes(prompt.id)) {
            return;
          }
          done = true;
          clearTimeout(timer);
          stopListening();
          if (
            how === 'allow' &&
            prompt.kind === 'permission' &&
            prompt.permissions.some((asked) => never.includes(asked))
          ) {
            reject(
              new Error(
                `Refusing to Allow a question for ${prompt.permissions.join(', ')}: automated ` +
                  'tests never turn on the camera or microphone or look up the location.',
              ),
            );
            return;
          }
          const seenAt = Date.now();
          void veltriva.prompts
            .respond({ tabId: tab, promptId: prompt.id, decision: how, remember: false })
            .then(() => {
              resolve({ promptId: prompt.id, seenAt, sentAt: Date.now() });
            });
        };
        stopListening = veltriva.on('workspace.changed', look);
        void veltriva.workspace.getSnapshot().then((result) => {
          if (result.ok) {
            look(result.value);
          }
        });
      }),
    { tab: tabId, how: decision, skipped: [...skip], never: [...NEVER_ALLOWED_PERMISSIONS] },
  );
}
