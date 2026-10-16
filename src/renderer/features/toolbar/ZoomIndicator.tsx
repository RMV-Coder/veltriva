import { ZoomIn, ZoomOut } from 'lucide-react';
import type { MouseEvent } from 'react';

import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { DEFAULT_ZOOM_PERCENT, zoomIndicatorLabel, zoomIndicatorText } from './zoom-display';

interface ZoomIndicatorProps {
  readonly percent: number;
  /** `viaKeyboard`: the click came from the keyboard, so the button is about to disappear under it. */
  readonly onReset: (viaKeyboard: boolean) => void;
}

/**
 * The page's zoom, at the right end of the address bar while it isn't 100%. Clicking it resets the
 * zoom. The tooltip is the native `title`, like the rest of the toolbar.
 */
export function ZoomIndicator({ percent, onReset }: ZoomIndicatorProps) {
  const label = zoomIndicatorLabel(percent);
  const Icon = percent > DEFAULT_ZOOM_PERCENT ? ZoomIn : ZoomOut;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-zoom-indicator=""
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onReset(event.currentTarget.matches(':focus-visible'));
      }}
      className={cn(
        'flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium text-foreground/80 tabular-nums hover:bg-foreground/10',
        FOCUS_RING,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {zoomIndicatorText(percent)}
    </button>
  );
}
