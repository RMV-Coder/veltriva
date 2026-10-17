import { File, FileDown, FileX, TriangleAlert, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import {
  cancelDownload,
  clearDownload,
  discardDownload,
  keepDownload,
  openDownload,
  pauseDownload,
  resumeDownload,
  showDownloadInFolder,
} from '../../state/commands';
import { useUiStore } from '../../state/ui-store';
import { useDownloads } from '../../state/workspace-store';
import { DOWNLOADS_BUTTON_ID, DOWNLOADS_PANEL_ID } from '../layout/ids';
import { ToolbarButton } from '../toolbar/ToolbarButton';
import {
  DANGEROUS_FILE_WARNING,
  DOWNLOAD_ACTION_LABELS,
  downloadActions,
  downloadNameText,
  downloadProgress,
  downloadSiteText,
  downloadStatusText,
  isActive,
  isUnkept,
} from './download-display';
import type { Download, DownloadAction, RowProgress } from './download-display';

/**
 * The downloads panel: a band directly under the toolbar (and under the prompt strip) while the
 * user has it open and the list isn't empty. It is part of the chrome, so the content area is
 * smaller while it shows and the page's view is placed below it (`useContentInsets`). That is the
 * placement ADR-0006 leaves for anything that needs to be seen next to a page: a web page is a
 * native view above the shell, so a popover over the content area would be drawn behind it, and
 * the raise-the-shell trick (A') is for modal overlays, not for a list the user keeps open while
 * browsing.
 *
 * It lists what main reports, newest first, and sends typed commands; every row offers only the
 * actions main would accept (./download-display.ts). It scrolls when it is long.
 */
export function DownloadsPanel() {
  const downloads = useDownloads();
  const open = useUiStore((state) => state.downloadsPanelOpen);
  const setOpen = useUiStore((state) => state.setDownloadsPanelOpen);
  if (!open || downloads.length === 0) {
    return null;
  }

  const close = (): void => {
    setOpen(false);
    // The panel goes away under the keyboard: it returns to the button that opened it.
    document.getElementById(DOWNLOADS_BUTTON_ID)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      close();
    }
  };

  return (
    <section
      id={DOWNLOADS_PANEL_ID}
      aria-label="Downloads"
      data-downloads-panel=""
      onKeyDown={onKeyDown}
      className="border-b bg-muted/40 select-none"
    >
      <div className="flex items-center justify-between gap-2 py-1 pr-2 pl-4">
        <h2
          tabIndex={-1}
          data-downloads-title=""
          className={cn('rounded-sm text-sm font-semibold', FOCUS_RING)}
        >
          Downloads
        </h2>
        <ToolbarButton
          label="Close downloads"
          icon={X}
          size="compact"
          disabled={false}
          onClick={close}
        />
      </div>
      <ul className="grid max-h-[min(38vh,17rem)] grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-2 overflow-y-auto px-4 pb-3">
        {downloads.map((download) => (
          <DownloadRow key={download.id} download={download} />
        ))}
      </ul>
    </section>
  );
}

/** What each action sends. They are fire-and-forget: the next snapshot shows what happened. */
const ACTIONS: Readonly<Record<DownloadAction, (downloadId: string) => Promise<boolean>>> = {
  pause: pauseDownload,
  resume: resumeDownload,
  cancel: cancelDownload,
  open: openDownload,
  show: showDownloadInFolder,
  keep: keepDownload,
  discard: discardDownload,
  remove: clearDownload,
};

/** Actions after which the row, and with it the button that was pressed, is gone. */
const REMOVES_ROW: ReadonlySet<DownloadAction> = new Set(['remove', 'discard']);
/** Actions that swap the row's buttons for others, though the row stays. */
const REPLACES_BUTTONS: ReadonlySet<DownloadAction> = new Set(['cancel', 'keep']);

function DownloadRow({ download }: { readonly download: Download }) {
  const name = downloadNameText(download.fileName);
  const site = downloadSiteText(download.site);
  const progress = downloadProgress(download);
  const unkept = isUnkept(download);
  const nameId = `download-name-${download.id}`;

  const run = (action: DownloadAction, button: HTMLElement): void => {
    // A keyboard user's button is about to go (the row leaves, or its buttons change), and the
    // keyboard must not fall to the page behind. Move it somewhere that stays first. A mouse click
    // has no focus to keep.
    if (button.matches(':focus-visible')) {
      // Cancelling a dangerous file leaves nothing behind, not even its row.
      const rowGoes = REMOVES_ROW.has(action) || (action === 'cancel' && unkept);
      keepFocusNear(button, rowGoes, REPLACES_BUTTONS.has(action));
    }
    void ACTIONS[action](download.id);
  };

  return (
    <li
      tabIndex={-1}
      aria-labelledby={nameId}
      data-download-row=""
      data-download-id={download.id}
      data-download-state={download.state}
      data-download-dangerous={download.dangerous}
      data-download-confirmed={download.confirmed}
      className={cn(
        'flex min-w-0 gap-3 rounded-lg border bg-card p-3 text-card-foreground',
        unkept && 'border-red-700/50 dark:border-red-400/50',
        FOCUS_RING,
      )}
    >
      <FileIcon download={download} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          id={nameId}
          title={name.full}
          data-download-name=""
          className="text-sm font-medium [overflow-wrap:anywhere]"
        >
          <bdi dir="ltr">{name.text}</bdi>
        </p>
        <p className="text-xs text-foreground/70 [overflow-wrap:anywhere]">
          {site === null ? null : (
            <>
              <bdi dir="ltr" title={site.full} data-download-site="">
                {site.text}
              </bdi>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
            </>
          )}
          <span data-download-status="">{downloadStatusText(download)}</span>
        </p>
        {progress === null ? null : (
          <ProgressBar progress={progress} paused={download.state === 'paused'} nameId={nameId} />
        )}
        {unkept ? (
          <p
            data-download-warning=""
            className="flex items-start gap-1 text-xs font-medium text-red-700 dark:text-red-400"
          >
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {DANGEROUS_FILE_WARNING}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-1.5">
          {/* Keyed by position: Pause becomes Resume in the same button, so a keyboard user's
              focus stays on it. */}
          {downloadActions(download).map((action, index) => (
            <Button
              key={index}
              type="button"
              size="sm"
              variant={actionVariant(action)}
              aria-describedby={nameId}
              onClick={(event) => {
                run(action, event.currentTarget);
              }}
              className={cn(
                'rounded-full px-3 focus-visible:border-transparent',
                FOCUS_RING,
                // A lone, borderless Remove lines up with the text above it.
                index === 0 && action === 'remove' && '-ml-3',
              )}
            >
              {DOWNLOAD_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      </div>
    </li>
  );
}

function actionVariant(action: DownloadAction): 'default' | 'outline' | 'ghost' {
  switch (action) {
    case 'open':
    case 'discard':
      return 'default';
    case 'remove':
      return 'ghost';
    default:
      return 'outline';
  }
}

/**
 * Moves keyboard focus off a button that is about to disappear. When the whole row goes, to the
 * next row, else the one before it, else the panel's title; when only its buttons change, to the
 * row itself. Done before the command is sent, so focus is never left on a removed element.
 */
function keepFocusNear(button: HTMLElement, rowGoes: boolean, buttonsChange: boolean): void {
  const row = button.closest('li');
  if (row === null) {
    return;
  }
  if (rowGoes) {
    const neighbor = row.nextElementSibling ?? row.previousElementSibling;
    const title = row.closest('section')?.querySelector('[data-downloads-title]');
    const target = neighbor ?? title;
    if (target instanceof HTMLElement) {
      target.focus();
    }
  } else if (buttonsChange) {
    row.focus();
  }
}

/** The file's icon: an alert for a dangerous file, else by state. */
function FileIcon({ download }: { readonly download: Download }) {
  const className = 'size-4';
  let icon;
  if (isUnkept(download)) {
    icon = <TriangleAlert className={cn(className, 'text-red-700 dark:text-red-400')} />;
  } else if (isActive(download)) {
    icon = <FileDown className={className} />;
  } else if (download.state === 'completed') {
    icon = <File className={className} />;
  } else {
    icon = <FileX className={className} />;
  }
  return (
    <span
      aria-hidden="true"
      className="mt-px flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/80"
    >
      {icon}
    </span>
  );
}

/** A thin bar: a share of the width, or a segment sliding across when the size is unknown. */
function ProgressBar({
  progress,
  paused,
  nameId,
}: {
  readonly progress: NonNullable<RowProgress>;
  readonly paused: boolean;
  readonly nameId: string;
}) {
  const percent = progress.kind === 'percent' ? progress.percent : undefined;
  return (
    <div
      role="progressbar"
      aria-labelledby={nameId}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-download-progress={percent ?? 'indeterminate'}
      className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/15"
    >
      {progress.kind === 'percent' ? (
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none',
            paused ? 'bg-foreground/40' : 'bg-primary',
          )}
          style={{ width: `${String(progress.percent)}%` }}
        />
      ) : (
        <div
          className={cn(
            'h-full w-2/5 rounded-full bg-primary',
            paused
              ? 'bg-foreground/40'
              : 'animate-indeterminate motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-50',
          )}
        />
      )}
    </div>
  );
}
