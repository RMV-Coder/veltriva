// What the M1.4b specs share about downloads (src/renderer/features/downloads, src/main/downloads):
// the toolbar button and the panel under it, their rows, the list main sends the shell
// (`workspace.changed` -> `downloads[]`), and the files that land in the test profile's folder.
//
// The button is `[data-downloads-button]` and the panel `[data-downloads-panel]`. A row is
// `[data-download-row]` with `data-download-id` and `data-download-state` (progressing, paused,
// completed, cancelled, interrupted); its buttons are found by role and name, as everything in the
// shell is. A row never has a path: the shell sees main's ids, and a spec learns where a file is
// from `testDownloadsFolder` plus the name in the list.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import type { WorkspaceSnapshot } from '../../src/shared/contracts/schemas';
import { expect } from './expect';
import { workspaceSnapshot } from './prompt-ui';
import { SLOW_TIMEOUT_MS } from './shell-ui';

export type DownloadEntry = WorkspaceSnapshot['downloads'][number];
export type DownloadState = DownloadEntry['state'];

export type RowButtonName =
  'Pause' | 'Resume' | 'Cancel' | 'Open' | 'Show in folder' | 'Keep' | 'Discard' | 'Remove';

// ── Locators ────────────────────────────────────────────────────────────────────────────────────

/** The toolbar's downloads button; it exists only once the list has something in it. */
export function downloadsButton(shell: Page): Locator {
  return shell.locator('[data-downloads-button]');
}

export function downloadsPanel(shell: Page): Locator {
  return shell.locator('[data-downloads-panel]');
}

export function downloadRows(shell: Page): Locator {
  return shell.locator('[data-download-row]');
}

/** One row, by main's id for the download. */
export function downloadRow(shell: Page, downloadId: string): Locator {
  return shell.locator(`[data-download-row][data-download-id="${downloadId}"]`);
}

export function rowButton(row: Locator, name: RowButtonName): Locator {
  return row.getByRole('button', { name, exact: true });
}

/** What a spec needs of a button to read its text (the specs' Node config has no DOM types). */
interface TextHolder {
  readonly textContent: string | null;
}

/** The names of the buttons a row offers, in the order they are drawn. */
export function rowButtonNames(row: Locator): Promise<string[]> {
  return row
    .getByRole('button')
    .evaluateAll((buttons: TextHolder[]) => buttons.map((button) => button.textContent ?? ''));
}

/**
 * Waits until a row offers exactly these buttons, in this order. The shell draws a snapshot a
 * moment after main sent it, so a row's buttons lag behind its state: read them with a poll.
 */
export async function expectRowButtons(row: Locator, names: readonly string[]): Promise<void> {
  await expect
    .poll(() => rowButtonNames(row), {
      message: `the row should offer exactly ${JSON.stringify(names)}`,
      timeout: SLOW_TIMEOUT_MS,
    })
    .toEqual([...names]);
}

/** Opens the panel if it is closed, and returns it. */
export async function openDownloadsPanel(shell: Page): Promise<Locator> {
  const button = downloadsButton(shell);
  await expect(button).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
  if ((await button.getAttribute('aria-expanded')) !== 'true') {
    await button.click();
  }
  await expect(downloadsPanel(shell)).toBeVisible();
  return downloadsPanel(shell);
}

// ── The list main sends ─────────────────────────────────────────────────────────────────────────

/** The downloads as the shell holds them right now, newest first. */
export async function downloadList(shell: Page): Promise<DownloadEntry[]> {
  return [...(await workspaceSnapshot(shell)).downloads];
}

/**
 * Waits for a download named `fileName` (in `state`, when given) and returns its entry. Names are
 * unique within a test, so a name finds the download whichever number main gave it.
 */
export async function waitForDownload(
  shell: Page,
  fileName: string,
  state?: DownloadState,
  timeoutMs = SLOW_TIMEOUT_MS,
): Promise<DownloadEntry> {
  const seen: { entry: DownloadEntry | undefined } = { entry: undefined };
  await expect
    .poll(
      async () => {
        seen.entry = (await downloadList(shell)).find(
          (entry) => entry.fileName === fileName && (state === undefined || entry.state === state),
        );
        return seen.entry !== undefined;
      },
      {
        message: `a download named ${fileName}${state === undefined ? '' : ` should be ${state}`}`,
        timeout: timeoutMs,
      },
    )
    .toBe(true);
  if (seen.entry === undefined) {
    throw new Error('unreachable: the poll passed with no download');
  }
  return seen.entry;
}

/** Waits until a download has received at least `bytes`, and returns its entry. */
export async function waitForBytes(
  shell: Page,
  downloadId: string,
  bytes: number,
): Promise<DownloadEntry> {
  const seen: { entry: DownloadEntry | undefined } = { entry: undefined };
  await expect
    .poll(
      async () => {
        seen.entry = (await downloadList(shell)).find((entry) => entry.id === downloadId);
        return seen.entry?.receivedBytes ?? -1;
      },
      {
        message: `${downloadId} should have received ${String(bytes)} bytes`,
        timeout: SLOW_TIMEOUT_MS,
      },
    )
    .toBeGreaterThanOrEqual(bytes);
  if (seen.entry === undefined) {
    throw new Error('unreachable: the poll passed with no download');
  }
  return seen.entry;
}

// ── The files ───────────────────────────────────────────────────────────────────────────────────

/** The names in the downloads folder, sorted. Chromium's `.crdownload` files are in the list. */
export function filesIn(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

/** Waits until the folder holds exactly these names (sorted for the comparison). */
export async function expectFiles(folder: string, names: readonly string[]): Promise<void> {
  await expect
    .poll(() => filesIn(folder), {
      message: `the downloads folder should hold exactly ${JSON.stringify([...names].sort())}`,
      timeout: SLOW_TIMEOUT_MS,
    })
    .toEqual([...names].sort());
}

/** The file's bytes. */
export function bytesOf(folder: string, name: string): Buffer {
  return readFileSync(join(folder, name));
}

/** Whether `candidate` is inside `folder` (not the folder itself), once both are made absolute. */
export function isInside(folder: string, candidate: string): boolean {
  return resolve(candidate).startsWith(resolve(folder) + sep);
}

/**
 * The file's Mark-of-the-Web: the text of its NTFS `Zone.Identifier` stream, or null if it has
 * none. Windows writes `ZoneId=3` for a file from the Internet zone. Reading a stream is just a
 * file path with `:Zone.Identifier` on the end.
 */
export function markOfTheWeb(path: string): string | null {
  try {
    return readFileSync(`${path}:Zone.Identifier`, 'utf8');
  } catch {
    return null;
  }
}
