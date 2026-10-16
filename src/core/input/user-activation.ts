// User activation, approximated from main's view of a page's input (ADR-0002 §4, assessment §3.7).
// Chromium lets a page open a popup or launch another app only right after the user interacted
// with it. Electron's window-open handler and its external-protocol hooks carry no such signal
// (spike S7), so main records trusted input per web contents and asks this tracker. Pure, so the
// rule is unit-tested.

/** How long an activation lasts. Chromium's transient user activation lasts 5 s. */
export const ACTIVATION_WINDOW_MS = 5_000;

/** The parts of Electron's `InputEvent` (the `input-event` event) the rule reads. */
export interface ActivationInput {
  readonly type: string;
  readonly key?: string;
}

/** Keys that never activate a page on their own (Chromium excludes Escape too). */
const NON_ACTIVATING_KEYS: ReadonlySet<string> = new Set([
  'Escape',
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
]);

/**
 * Whether an input event activates the page, as in Chromium: a mouse button or a touch, or a key
 * press other than Escape and the bare modifiers. A browser shortcut never gets here: main cancels
 * it in `before-input-event`, and Electron then emits no `input-event` for it (measured).
 */
export function isActivationInput(input: ActivationInput): boolean {
  switch (input.type) {
    case 'mouseDown':
    case 'touchEnd':
    case 'gestureTap':
      return true;
    case 'rawKeyDown':
    case 'keyDown':
      return input.key !== undefined && input.key !== '' && !NON_ACTIVATING_KEYS.has(input.key);
    default:
      return false;
  }
}

/**
 * The last activation of each web contents. An activation is used up by the popup or app launch
 * it allows, so one click opens one popup, as in Chromium.
 */
export class ActivationTracker<Id> {
  readonly #lastActivation = new Map<Id, number>();
  readonly #windowMs: number;

  constructor(windowMs = ACTIVATION_WINDOW_MS) {
    this.#windowMs = windowMs;
  }

  record(id: Id, now: number): void {
    this.#lastActivation.set(id, now);
  }

  /** Whether `id` was activated within the window, without using the activation up. */
  isActive(id: Id, now: number): boolean {
    const last = this.#lastActivation.get(id);
    return last !== undefined && now >= last && now - last <= this.#windowMs;
  }

  /** Whether `id` was activated within the window; if so, the activation is used up. */
  consume(id: Id, now: number): boolean {
    if (!this.isActive(id, now)) {
      return false;
    }
    this.#lastActivation.delete(id);
    return true;
  }

  forget(id: Id): void {
    this.#lastActivation.delete(id);
  }
}
