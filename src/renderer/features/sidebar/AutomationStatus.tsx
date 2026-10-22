import { MemoryStick, Pause, Play } from 'lucide-react';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { endPreview, setAutomationPaused } from '../../state/commands';
import { useAutomation } from '../../state/workspace-store';
import { AUTOMATION_TOGGLE_ID } from '../layout/ids';
import { START_NOW_LABEL, automationView } from './automation-display';

/**
 * Automation's status in the sidebar's footer (assessment §4.12, §4.13), part of the chrome so
 * nothing is drawn over a page (ADR-0006): the "Pause automation" / "Resume automation" button, the
 * state while it is paused, the preview-mode notice with "Start now", and a hint while memory is
 * low. The shell only sends the command; the words change when the next snapshot arrives.
 *
 * Nothing here is a live region: each change either follows the user's own press (the button's
 * name changes under their focus) or is background information (the day of the preview, the
 * memory hint) that a screen reader reads when the user gets to it.
 */
export function AutomationStatus() {
  const automation = useAutomation();
  const view = automationView(automation);
  const previewId = useId();
  const ToggleIcon = view.paused ? Play : Pause;

  return (
    <div
      role="group"
      aria-label="Automation"
      data-automation-status=""
      data-automation-paused={view.paused}
      className="flex flex-col gap-1 pb-1"
    >
      {view.preview === null ? null : (
        <div
          data-automation-preview=""
          className="mx-1 flex flex-col items-start gap-1.5 rounded-lg border border-sidebar-border bg-background px-2.5 py-1.5"
        >
          <p id={previewId} data-automation-preview-text="" className="text-xs leading-snug">
            {view.preview}
          </p>
          <Button
            variant="outline"
            size="xs"
            aria-describedby={previewId}
            data-automation-start=""
            onClick={(event) => {
              // The button goes away once main starts automation. For the keyboard that would drop
              // focus onto nothing, so it moves to the pause button, which stays, first.
              if (event.detail === 0) {
                document.getElementById(AUTOMATION_TOGGLE_ID)?.focus();
              }
              void endPreview();
            }}
            className={FOCUS_RING}
          >
            {START_NOW_LABEL}
          </Button>
        </div>
      )}

      {view.pressure === null ? null : (
        <p
          data-automation-pressure={automation.pressure}
          className="flex items-center gap-1.5 px-2.5 text-xs text-sidebar-foreground/80"
        >
          <MemoryStick className="size-3.5 shrink-0" aria-hidden="true" />
          {view.pressure}
        </p>
      )}

      {view.stateText === null ? null : (
        <p
          data-automation-state="paused"
          className="flex items-center gap-1.5 px-2.5 text-xs font-medium"
        >
          <Pause className="size-3.5 shrink-0" aria-hidden="true" />
          {view.stateText}
        </p>
      )}

      <Button
        variant="ghost"
        size="sm"
        id={AUTOMATION_TOGGLE_ID}
        // The name is what pressing does (its text, said outright); the tooltip explains it.
        aria-label={view.toggleLabel}
        title={view.toggleHint}
        data-automation-toggle={view.paused ? 'resume' : 'pause'}
        onClick={() => {
          void setAutomationPaused(!view.paused);
        }}
        className={cn(
          'w-full justify-start text-sidebar-foreground has-data-[icon=inline-start]:pl-2',
          FOCUS_RING,
        )}
      >
        <ToggleIcon data-icon="inline-start" aria-hidden="true" />
        {view.toggleLabel}
      </Button>
    </div>
  );
}
