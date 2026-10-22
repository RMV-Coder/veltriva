import { X } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { dismissUndo, undoBatch } from '../../state/commands';
import { useUndoOffer } from '../../state/workspace-store';
import { DISMISS_UNDO_LABEL, UNDO_LABEL, undoToastText } from './undo-display';

/**
 * Gives keyboard focus to the tab list's one tab stop. The toast is about to go, and a focused
 * button that is removed drops focus onto nothing; this puts it somewhere in the sidebar first.
 */
function focusTabStop(): void {
  document.querySelector<HTMLElement>('[role="tablist"] [role="tab"][tabindex="0"]')?.focus();
}

/**
 * The Undo toast (assessment §4.12, §4.13), at the foot of the sidebar: it is part of the chrome,
 * so nothing is drawn over a page (ADR-0006). It shows while main offers an undo (main withdraws
 * the offer after 60 seconds, so there is no timer here), says what was moved, and offers Undo and
 * a close button.
 *
 * Its text is a polite live region that is always in the document, empty and out of sight when
 * there is no offer, so a screen reader announces the text when it appears. The toast never takes
 * focus: it appears while the user is doing something else. A keyboard Undo or close moves focus
 * to the tab list first, since the toast and its buttons go away.
 */
export function UndoToast() {
  const undo = useUndoOffer();
  const text = undo === null ? '' : undoToastText(undo);

  const act = (event: MouseEvent<HTMLButtonElement>, batchId: string, undoIt: boolean): void => {
    if (event.detail === 0) {
      focusTabStop();
    }
    void (undoIt ? undoBatch(batchId) : dismissUndo(batchId));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (undo !== null && event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      focusTabStop();
      void dismissUndo(undo.batchId);
    }
  };

  return (
    <div className="shrink-0 px-2">
      <div
        data-undo-toast={undo === null ? undefined : ''}
        data-undo-batch={undo?.batchId}
        data-undo-automated={undo?.automated}
        onKeyDown={onKeyDown}
        className={
          undo === null
            ? 'sr-only'
            : 'mb-1.5 flex items-center gap-1 rounded-lg border border-sidebar-border bg-background py-1 pr-1 pl-2.5 text-sm shadow-xs'
        }
      >
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-undo-text=""
          className="min-w-0 flex-1 leading-snug"
        >
          {text}
        </p>
        {undo === null ? null : (
          <>
            <Button
              variant="outline"
              size="sm"
              data-undo-action="undo"
              onClick={(event) => {
                act(event, undo.batchId, true);
              }}
              className={cn('shrink-0', FOCUS_RING)}
            >
              {UNDO_LABEL}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={DISMISS_UNDO_LABEL}
              title={DISMISS_UNDO_LABEL}
              data-undo-action="dismiss"
              onClick={(event) => {
                act(event, undo.batchId, false);
              }}
              className={cn('shrink-0', FOCUS_RING)}
            >
              <X aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
