// What the downloads button and its panel show, derived from the snapshot's `downloads`. Pure, so
// Vitest covers it; the components only render what this returns.
//
// The rules of which action a row offers mirror the ones main enforces (src/main/downloads/
// download-manager.ts), so a button is never shown that main would refuse:
//   - Open and Show in folder: a finished file the user may open (`completed && confirmed`).
//   - Keep and Discard: a dangerous file not yet kept, once it is finished. Discard is also
//     offered while it downloads.
//   - Remove (`downloads.clear`): a finished row, never a dangerous file still waiting for Keep.
//
// A file name and a site come from the network, so they are cleaned (bidi overrides and invisible
// characters removed, as for the prompt strip) and rendered by the component in `<bdi dir="ltr">`.
// The file name is cut in the MIDDLE so its extension stays visible: `very-long-…-name.pdf`.
import type { WorkspaceSnapshot } from '../../../shared/contracts/schemas';
import { MAX_SITE_CHARS, cleanText, truncateStart } from '../prompts/prompt-display';

export type Download = WorkspaceSnapshot['downloads'][number];
export type DownloadState = Download['state'];

export type DownloadAction =
  'pause' | 'resume' | 'cancel' | 'open' | 'show' | 'keep' | 'discard' | 'remove';

/** The buttons' visible and accessible names. */
export const DOWNLOAD_ACTION_LABELS: Readonly<Record<DownloadAction, string>> = {
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  open: 'Open',
  show: 'Show in folder',
  keep: 'Keep',
  discard: 'Discard',
  remove: 'Remove',
};

/** The warning on a dangerous file that was not kept, while it downloads and once it's done. */
export const DANGEROUS_FILE_WARNING = 'This type of file can harm your computer';

/** A file name is shown with at most this many characters, ellipsis included. */
export const MAX_FILE_NAME_CHARS = 48;
/** Shown when a name has no text left after cleaning. */
const UNNAMED_DOWNLOAD = 'Download';

const ELLIPSIS = '…';
/** The longest extension that is kept whole when a name is cut: `.docx`, `.torrent`, `.crdownload`. */
const MAX_KEPT_EXTENSION_CHARS = 12;

// ── Sizes ───────────────────────────────────────────────────────────────────────────────────────

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A size for people: "512 B", "3.2 MB", "10 MB", "1.4 GB". Powers of 1024 under the usual names,
 * like Windows. One decimal below 10 and none from 10 up, never a trailing ".0", and a value
 * that rounds up to 1024 is shown in the next unit ("1 MB", not "1024 KB").
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  if (rounded >= 1024 && unit < SIZE_UNITS.length - 1) {
    rounded = 1;
    unit += 1;
  }
  return `${String(rounded)} ${SIZE_UNITS[unit] ?? 'B'}`;
}

/** Done so far, from 0 to 100, or null while the server hasn't said how big the file is. */
export function progressPercent(download: {
  readonly receivedBytes: number;
  readonly totalBytes: number;
}): number | null {
  if (download.totalBytes <= 0) {
    return null;
  }
  const percent = Math.floor((download.receivedBytes / download.totalBytes) * 100);
  return Math.min(100, Math.max(0, percent));
}

// ── Names ───────────────────────────────────────────────────────────────────────────────────────

/** The extension of a name with its dot, or '' when there is none worth keeping. */
function keptExtension(chars: readonly string[]): string {
  const dot = chars.lastIndexOf('.');
  // No dot, a leading dot (".gitignore"), a trailing dot, or a "extension" that is really text.
  if (dot <= 0 || dot === chars.length - 1) {
    return '';
  }
  const extension = chars.slice(dot);
  if (extension.length > MAX_KEPT_EXTENSION_CHARS || extension.includes(' ')) {
    return '';
  }
  return extension.join('');
}

/**
 * The name cut in the middle to at most `maxChars` characters, ellipsis included. The extension and
 * a few characters before it stay (`very-long-…-name.pdf`), because they say what the file is.
 * Counts characters (code points), so a surrogate pair is never split.
 */
export function truncateFileName(name: string, maxChars: number = MAX_FILE_NAME_CHARS): string {
  const chars = Array.from(name);
  if (chars.length <= maxChars) {
    return name;
  }
  if (maxChars < 1) {
    return '';
  }
  if (maxChars === 1) {
    return ELLIPSIS;
  }
  const budget = maxChars - 1; // what's left once the ellipsis has its place
  let extension = keptExtension(chars);
  // An extension that would leave almost no room for the name is not worth keeping apart.
  if (Array.from(extension).length > budget - 2) {
    extension = '';
  }
  const extensionLength = Array.from(extension).length;
  const base = extension === '' ? chars : chars.slice(0, chars.length - extensionLength);
  const room = budget - extensionLength;
  // A third of the room goes to the end of the name, the rest to its beginning.
  const tail = Math.floor(room / 3);
  const head = room - tail;
  return `${base.slice(0, head).join('')}${ELLIPSIS}${base.slice(base.length - tail).join('')}${extension}`;
}

/** A piece of text from the network, shortened for the screen; `full` is the whole of it. */
export interface ShownText {
  readonly text: string;
  /** The tooltip, when `text` is a shortened form of it. */
  readonly full?: string;
}

function shown(text: string, full: string): ShownText {
  return text === full ? { text } : { text, full };
}

/** The download's file name, cleaned and cut in the middle when it is long. */
export function downloadNameText(fileName: string): ShownText {
  const full = cleanText(fileName) || UNNAMED_DOWNLOAD;
  return shown(truncateFileName(full), full);
}

/** The site that started the download, cleaned and cut at its start; null when there is none. */
export function downloadSiteText(site: string): ShownText | null {
  const full = cleanText(site);
  return full === '' ? null : shown(truncateStart(full, MAX_SITE_CHARS), full);
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────

/** Still downloading, or paused part-way: the download is not over. */
export function isActive(download: Pick<Download, 'state'>): boolean {
  return download.state === 'progressing' || download.state === 'paused';
}

/** A dangerous file that was not kept: it can't be opened or removed until the user decides. */
export function isUnkept(download: Pick<Download, 'dangerous' | 'confirmed'>): boolean {
  return download.dangerous && !download.confirmed;
}

/** A finished dangerous file waiting for Keep or Discard. */
export function needsDecision(
  download: Pick<Download, 'dangerous' | 'confirmed' | 'state'>,
): boolean {
  return isUnkept(download) && download.state === 'completed';
}

/**
 * The line under the name: how far along it is, or how it ended. "3.2 MB of 10 MB",
 * "Paused, 3.2 MB of 10 MB", "Done, 10 MB", "Cancelled", "Failed".
 */
export function downloadStatusText(download: Download): string {
  const received = Math.max(0, download.receivedBytes);
  const total = Math.max(0, download.totalBytes);
  switch (download.state) {
    case 'progressing':
      return progressText(received, total, 'Starting…');
    case 'paused':
      return `Paused${received === 0 && total === 0 ? '' : `, ${progressText(received, total, '')}`}`;
    case 'completed': {
      const size = total > 0 ? total : received;
      return size > 0 ? `Done, ${formatBytes(size)}` : 'Done';
    }
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Failed';
  }
}

function progressText(received: number, total: number, nothingYet: string): string {
  if (total > 0) {
    return `${formatBytes(received)} of ${formatBytes(total)}`;
  }
  return received > 0 ? formatBytes(received) : nothingYet;
}

/**
 * The buttons a row offers, in the order they're drawn. The first is the one to emphasize.
 * Mirrors what main allows (see the top of this file).
 */
export function downloadActions(download: Download): readonly DownloadAction[] {
  const discard: readonly DownloadAction[] = isUnkept(download) ? ['discard'] : [];
  switch (download.state) {
    case 'progressing':
      return ['pause', 'cancel', ...discard];
    case 'paused':
      return ['resume', 'cancel', ...discard];
    case 'interrupted':
      // Main can resume a download only when Chromium can (`canResume`). Either way the row can go.
      return download.canResume ? ['resume', 'remove'] : ['remove'];
    case 'cancelled':
      return ['remove'];
    case 'completed':
      return isUnkept(download) ? ['discard', 'keep'] : ['open', 'show', 'remove'];
  }
}

/** What the row's progress bar shows, if it has one. */
export type RowProgress =
  | { readonly kind: 'percent'; readonly percent: number }
  | { readonly kind: 'indeterminate' }
  | null;

export function downloadProgress(download: Download): RowProgress {
  if (!isActive(download)) {
    return null;
  }
  const percent = progressPercent(download);
  return percent === null ? { kind: 'indeterminate' } : { kind: 'percent', percent };
}

// ── The toolbar button ──────────────────────────────────────────────────────────────────────────

export interface DownloadsSummary {
  /** Every download in the list. */
  readonly count: number;
  /** Downloads that are not over: downloading or paused. */
  readonly active: number;
  /** Done so far across the active ones, 0 to 1; null when there are none or one has no size. */
  readonly fraction: number | null;
  /** Finished dangerous files waiting for Keep or Discard. */
  readonly waiting: number;
}

export function summarizeDownloads(downloads: readonly Download[]): DownloadsSummary {
  let active = 0;
  let waiting = 0;
  let received = 0;
  let total = 0;
  let sizeKnown = true;
  for (const download of downloads) {
    if (needsDecision(download)) {
      waiting += 1;
    }
    if (!isActive(download)) {
      continue;
    }
    active += 1;
    if (download.totalBytes > 0) {
      received += Math.min(download.receivedBytes, download.totalBytes);
      total += download.totalBytes;
    } else {
      sizeKnown = false;
    }
  }
  const fraction = active > 0 && sizeKnown && total > 0 ? received / total : null;
  return { count: downloads.length, active, fraction, waiting };
}

/** The button's accessible name and tooltip: it says what is going on, not only what it opens. */
export function downloadsButtonLabel(summary: DownloadsSummary): string {
  const parts = ['Downloads'];
  if (summary.active > 0) {
    parts.push(`${String(summary.active)} in progress`);
  }
  if (summary.waiting > 0) {
    parts.push(
      summary.waiting === 1
        ? '1 file waiting for your decision'
        : `${String(summary.waiting)} files waiting for your decision`,
    );
  }
  return parts.join(', ');
}
