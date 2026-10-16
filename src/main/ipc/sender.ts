// Sender verification for shell IPC (ADR-0005 §5.1): a command is accepted only from the main
// frame of the shell's web contents, on the shell's origin. Pure, so it's unit-tested directly.
import type { WebContentsRole } from '../web/web-contents-role';

export interface SenderFacts {
  /** The role the web-contents guard assigned to `event.sender`, if any. */
  readonly role: WebContentsRole | undefined;
  /** `false` when `event.senderFrame` is gone (navigated or destroyed). */
  readonly hasFrame: boolean;
  readonly isMainFrame: boolean;
  /** `event.senderFrame.origin`, e.g. `app://shell`. */
  readonly origin: string | undefined;
}

export type SenderVerdict =
  | { readonly trusted: true }
  | {
      readonly trusted: false;
      readonly reason: 'not-shell' | 'no-frame' | 'not-main-frame' | 'origin-not-allowed';
    };

export function checkShellSender(
  facts: SenderFacts,
  allowedOrigins: ReadonlySet<string>,
): SenderVerdict {
  if (facts.role !== 'shell') {
    return { trusted: false, reason: 'not-shell' };
  }
  if (!facts.hasFrame) {
    return { trusted: false, reason: 'no-frame' };
  }
  if (!facts.isMainFrame) {
    return { trusted: false, reason: 'not-main-frame' };
  }
  if (facts.origin === undefined || !allowedOrigins.has(facts.origin)) {
    return { trusted: false, reason: 'origin-not-allowed' };
  }
  return { trusted: true };
}
