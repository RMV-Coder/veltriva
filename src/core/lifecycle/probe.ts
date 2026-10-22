// What the discard probe reports, and what the discard does about it (assessment §4.9 step 3,
// §4.10, spike S3). The probe runs in our isolated world in the page, which is a renderer: its
// answer is parsed like any untrusted input, and anything unexpected means "keep the tab".

import type { ProtectionReason } from './protections';

/** The caller's budget for the probe (S3: a busy page delayed it by about 680 ms). */
export const PROBE_TIMEOUT_MS = 100;

/**
 * How long the discard waits for the page to wake up before it probes: a dry run of the probe.
 * Measured on the reference laptop under load (M3.1), the first script call into a just-hidden
 * tab took up to 1.8 s, and the first probe after a no-op still up to 166 ms (compiling, our
 * world's view of the page), the second at most 32 ms. Without the wake-up, the 100 ms budget
 * measured the renderer's scheduling, not the page. No answer still means "keep the tab"; a page
 * busy in its own script answers only once its task is done.
 */
export const PING_TIMEOUT_MS = 5000;

export interface ProbeReading {
  /**
   * Form fields whose value differs from their default (input, textarea, select, checkbox, a
   * chosen file). They count only if `hasBeenActive`: see `judgeProbe`.
   */
  readonly changedFields: number;
  /**
   * Fields the trusted-input tracker saw the user type into that still hold what was typed:
   * the React-style inputs and `contenteditable` edits the value check misses (S3).
   */
  readonly editedFields: number;
  /** A focused `contenteditable`. A plain click sets it, so on its own it is only soft (S3). */
  readonly focusedEditable: boolean;
  /** Password or payment fields are on the page. */
  readonly sensitive: boolean;
  /** `navigator.userActivation.hasBeenActive`, read in the isolated world (S3). */
  readonly hasBeenActive: boolean;
  /** `history.replaceState(history.state, '')` ran, so the page state is fresh (S2). */
  readonly flushed: boolean;
}

const MAX_COUNT = 1_000_000;

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT
    ? value
    : null;
}

/** The probe's answer, or null if it isn't one: a renderer's reply is never trusted as is. */
export function parseProbeReading(raw: unknown): ProbeReading | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const changedFields = count(value.changedFields);
  const editedFields = count(value.editedFields);
  const { focusedEditable, sensitive, hasBeenActive, flushed } = value;
  if (
    changedFields === null ||
    editedFields === null ||
    typeof focusedEditable !== 'boolean' ||
    typeof sensitive !== 'boolean' ||
    typeof hasBeenActive !== 'boolean' ||
    typeof flushed !== 'boolean'
  ) {
    return null;
  }
  return { changedFields, editedFields, focusedEditable, sensitive, hasBeenActive, flushed };
}

/** How the page is closed once nothing keeps it (§4.9 step 5). */
export type CloseMode =
  /** `close({ waitForBeforeUnload: true })`: the page may object (`will-prevent-unload`). */
  | 'beforeunload'
  /** A plain `close()`: no `beforeunload`, which an untouched page may not use to object (S3). */
  | 'plain';

export type ProbeVerdict =
  | { readonly kind: 'keep'; readonly reason: ProtectionReason | 'probe-unanswered' }
  | { readonly kind: 'close'; readonly mode: CloseMode };

/**
 * What the discard does after the probe. `reading` is null when the probe timed out, failed or
 * answered nonsense: then the tab is kept, for this attempt (S3: "unknown, keep the tab").
 * `overrideSoft` is set under critical memory pressure, when soft protections don't count.
 */
export function judgeProbe(
  reading: ProbeReading | null,
  options: { readonly overrideSoft?: boolean } = {},
): ProbeVerdict {
  if (reading === null) {
    return { kind: 'keep', reason: 'probe-unanswered' };
  }
  // A changed field counts only on a page the user activated: typing activates it, so on an
  // untouched page the values come from its own script (a prefilled search box) or from a
  // restore of its page state, which the next snapshot keeps again. Typing the tracker saw is
  // the user's by definition.
  if (reading.editedFields > 0 || (reading.hasBeenActive && reading.changedFields > 0)) {
    return { kind: 'keep', reason: 'unsaved-input' };
  }
  if (options.overrideSoft !== true) {
    if (reading.focusedEditable) {
      return { kind: 'keep', reason: 'editing' };
    }
    if (reading.sensitive) {
      return { kind: 'keep', reason: 'sensitive-page' };
    }
  }
  // S3: only a page the user activated gets to object. Electron's close with
  // waitForBeforeUnload would first grant activation, so an untouched page closes plainly.
  return { kind: 'close', mode: reading.hasBeenActive ? 'beforeunload' : 'plain' };
}
