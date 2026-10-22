// What the sidebar's automation status says (assessment §4.12, §4.13), derived from the workspace
// snapshot's `automation`. Pure, so Vitest covers it; the component only renders what this returns.
import type { WorkspaceSnapshot } from '../../../shared/contracts/schemas';

export type Automation = WorkspaceSnapshot['automation'];

/** The pause button's accessible name while automation runs, and while it is paused. */
export const PAUSE_LABEL = 'Pause automation';
export const RESUME_LABEL = 'Resume automation';
/** The state line shown while automation is paused. */
export const PAUSED_TEXT = 'Automation paused';
/** The preview notice's button; the notice describes it. */
export const START_NOW_LABEL = 'Start now';

/** What the pause button's tooltip adds to its name. */
const PAUSE_HINT = 'Veltriva stops unloading and moving tabs on its own until you resume';
const RESUME_HINT = 'Veltriva may unload and move tabs on its own again';

/**
 * The preview notice (§4.13): for the first active days automation only marks the tabs it would
 * move. Null outside preview mode, and while paused: a paused automation marks nothing, so the
 * notice would promise a preview that is not there.
 */
export function previewNotice(automation: Automation): string | null {
  if (!automation.preview || automation.paused) {
    return null;
  }
  const last = automation.previewUntilDay;
  const text = 'Preview: automation shows what it would move';
  if (last < 1) {
    return text;
  }
  const day = Math.min(Math.max(automation.activeDay, 1), last);
  return `${text} (day ${String(day)} of ${String(last)})`;
}

/** A compact hint while memory is under pressure, which is when automation may unload tabs. */
export function pressureNotice(pressure: Automation['pressure']): string | null {
  switch (pressure) {
    case 'moderate':
      return 'Memory is low';
    case 'critical':
      return 'Memory is very low';
    case 'none':
      return null;
  }
}

export interface AutomationView {
  readonly paused: boolean;
  /** The pause button's accessible name: what pressing it does. */
  readonly toggleLabel: string;
  /** The pause button's tooltip, which also describes it. */
  readonly toggleHint: string;
  /** "Automation paused" while it is, else null. */
  readonly stateText: string | null;
  /** The preview notice, or null. */
  readonly preview: string | null;
  /** The memory hint, or null. */
  readonly pressure: string | null;
}

/** What the sidebar's automation status draws for `automation`. */
export function automationView(automation: Automation): AutomationView {
  const paused = automation.paused;
  return {
    paused,
    toggleLabel: paused ? RESUME_LABEL : PAUSE_LABEL,
    toggleHint: paused ? RESUME_HINT : PAUSE_HINT,
    stateText: paused ? PAUSED_TEXT : null,
    preview: previewNotice(automation),
    pressure: pressureNotice(automation.pressure),
  };
}
