import { describe, expect, it } from 'vitest';

import {
  PAUSED_TEXT,
  PAUSE_LABEL,
  RESUME_LABEL,
  START_NOW_LABEL,
  automationView,
  pressureNotice,
  previewNotice,
} from './automation-display';
import type { Automation } from './automation-display';

const running: Automation = {
  paused: false,
  preview: false,
  previewUntilDay: 3,
  activeDay: 5,
  pressure: 'none',
};
const previewing: Automation = { ...running, preview: true, activeDay: 1 };

describe('previewNotice', () => {
  it('is null outside preview mode', () => {
    expect(previewNotice(running)).toBeNull();
  });

  it('says automation only shows what it would move, and which day of the preview it is', () => {
    expect(previewNotice(previewing)).toBe(
      'Preview: automation shows what it would move (day 1 of 3)',
    );
    expect(previewNotice({ ...previewing, activeDay: 3 })).toBe(
      'Preview: automation shows what it would move (day 3 of 3)',
    );
  });

  it('keeps the day inside the preview, whatever the clocks say', () => {
    expect(previewNotice({ ...previewing, activeDay: 0 })).toBe(
      'Preview: automation shows what it would move (day 1 of 3)',
    );
    expect(previewNotice({ ...previewing, activeDay: 9 })).toBe(
      'Preview: automation shows what it would move (day 3 of 3)',
    );
  });

  it('leaves the day out when main does not say how long the preview lasts', () => {
    expect(previewNotice({ ...previewing, previewUntilDay: 0 })).toBe(
      'Preview: automation shows what it would move',
    );
  });

  it('is null while paused: a paused automation marks nothing', () => {
    expect(previewNotice({ ...previewing, paused: true })).toBeNull();
  });
});

describe('pressureNotice', () => {
  it('says how low memory is, and nothing when it is fine', () => {
    expect(pressureNotice('none')).toBeNull();
    expect(pressureNotice('moderate')).toBe('Memory is low');
    expect(pressureNotice('critical')).toBe('Memory is very low');
  });
});

describe('automationView', () => {
  it('offers to pause a running automation and says nothing else when nothing is going on', () => {
    expect(automationView(running)).toEqual({
      paused: false,
      toggleLabel: 'Pause automation',
      toggleHint: expect.stringContaining('until you resume') as string,
      stateText: null,
      preview: null,
      pressure: null,
    });
  });

  it('offers to resume a paused automation, and says it is paused', () => {
    const view = automationView({ ...running, paused: true });
    expect(view.paused).toBe(true);
    expect(view.toggleLabel).toBe('Resume automation');
    expect(view.stateText).toBe('Automation paused');
    expect(view.toggleHint).not.toBe(automationView(running).toggleHint);
  });

  it('carries the preview notice and the memory hint', () => {
    const view = automationView({ ...previewing, pressure: 'critical' });
    expect(view.preview).toBe('Preview: automation shows what it would move (day 1 of 3)');
    expect(view.pressure).toBe('Memory is very low');
    expect(view.stateText).toBeNull();
  });

  it('shows the pause and the memory hint together, without the preview', () => {
    const view = automationView({ ...previewing, paused: true, pressure: 'moderate' });
    expect(view.stateText).toBe(PAUSED_TEXT);
    expect(view.preview).toBeNull();
    expect(view.pressure).toBe('Memory is low');
  });

  it('names the controls in plain words', () => {
    expect(PAUSE_LABEL).toBe('Pause automation');
    expect(RESUME_LABEL).toBe('Resume automation');
    expect(PAUSED_TEXT).toBe('Automation paused');
    expect(START_NOW_LABEL).toBe('Start now');
  });
});
