import { Download } from 'lucide-react';
import { useEffect } from 'react';

import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { useUiStore } from '../../state/ui-store';
import { useDownloads } from '../../state/workspace-store';
import { DOWNLOADS_BUTTON_ID, DOWNLOADS_PANEL_ID } from '../layout/ids';
import { downloadsButtonLabel, summarizeDownloads } from './download-display';

/** The ring's circle, in the 24 x 24 box it is drawn in. */
const RING_RADIUS = 10;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
/** The share of the ring drawn, turning, while the total size is unknown. */
const INDETERMINATE_SHARE = 0.28;

/**
 * The downloads button, at the right end of the toolbar row once the list has anything in it. While
 * a download runs it shows a ring of the overall progress (turning when a size is unknown) and how
 * many downloads are running; a dot means a dangerous file is waiting for Keep or Discard. It opens
 * and closes the panel under the toolbar (`DownloadsPanel`), which is part of the chrome so that the
 * page's view is placed below it: nothing the shell draws can reach over a web page (ADR-0006).
 */
export function DownloadsButton() {
  const downloads = useDownloads();
  const open = useUiStore((state) => state.downloadsPanelOpen);
  const setOpen = useUiStore((state) => state.setDownloadsPanelOpen);
  const empty = downloads.length === 0;

  // An empty list has no panel to keep open: the next download starts with it closed.
  useEffect(() => {
    if (empty) {
      setOpen(false);
    }
  }, [empty, setOpen]);

  if (empty) {
    return null;
  }

  const summary = summarizeDownloads(downloads);
  const label = downloadsButtonLabel(summary);
  const running = summary.active > 0;

  return (
    <button
      type="button"
      id={DOWNLOADS_BUTTON_ID}
      aria-label={label}
      title={label}
      aria-expanded={open}
      aria-controls={open ? DOWNLOADS_PANEL_ID : undefined}
      data-downloads-button=""
      data-downloads-active={summary.active}
      data-downloads-waiting={summary.waiting}
      onClick={() => {
        setOpen(!open);
      }}
      className={cn(
        'flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-full px-1 text-foreground/80 select-none hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        running && 'pr-2',
        FOCUS_RING,
      )}
    >
      <span className="relative flex size-6 items-center justify-center">
        {running ? <ProgressRing fraction={summary.fraction} /> : null}
        <Download className={running ? 'size-3' : 'size-4'} aria-hidden="true" />
        {summary.waiting > 0 ? (
          <span
            data-downloads-attention=""
            aria-hidden="true"
            className="absolute -top-px -right-px size-2.5 rounded-full bg-red-600 ring-2 ring-background dark:bg-red-400"
          />
        ) : null}
      </span>
      {running ? (
        <span
          data-downloads-count=""
          aria-hidden="true"
          className="text-xs font-medium tabular-nums"
        >
          {summary.active}
        </span>
      ) : null}
    </button>
  );
}

/**
 * A ring around the icon. With a known size it fills as the downloads arrive; without one, a short
 * arc turns (it stands still under `prefers-reduced-motion`).
 */
function ProgressRing({ fraction }: { readonly fraction: number | null }) {
  const share = fraction ?? INDETERMINATE_SHARE;
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-downloads-ring={fraction === null ? 'indeterminate' : Math.round(fraction * 100)}
      className={cn(
        'absolute inset-0 size-6 -rotate-90',
        fraction === null && 'animate-spin motion-reduce:animate-none',
      )}
    >
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-foreground/20"
      />
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - share)}
        className="stroke-foreground transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
      />
    </svg>
  );
}
