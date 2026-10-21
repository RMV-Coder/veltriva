// The download manager (ADR-0002 §4, assessment §3.7 and §6.4). Electron shows a save dialog unless
// a `will-download` handler sets a path, so every managed session gets one that always does:
//   - the file goes to the Downloads folder under a sanitized, unique name (src/core/downloads),
//     chosen here and never by the page or the renderer;
//   - a dangerous type (.exe, .msi, .lnk, ...) is saved under a name Windows won't run
//     ("setup.exe.unconfirmed") until the user chooses Keep, or deleted on Discard; nothing is
//     ever opened automatically;
//   - downloads belong to the session, not the tab, so closing, discarding or crashing the tab
//     leaves them running (spike S7);
//   - Open and Show in folder act on the path main recorded, only on the user's click, through an
//     injected FileActions (`shell.openPath`, `shell.showItemInFolder`; recorded in test builds).
// Chromium writes Mark-of-the-Web (Zone.Identifier with ZoneId=3) on every download (S7).
//
// History (M2.2b, schema amendment (c)): every change is written through to an optional
// DownloadStore, fire and forget, and `restore` puts the stored rows back at startup as finished
// records with no DownloadItem (the one that ran them died with the last run). A row holds the
// source address without secrets (§5.7) and the registrable site of the page that started it;
// `ended_at` is set exactly when the download isn't running; and a dangerous file is `confirmed`
// from the start unless it waits for Keep, so a record can't break the table's CHECKs.
import { getRandomValues } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';

import type { DownloadItem, Session } from 'electron';

import {
  UNCONFIRMED_SUFFIX,
  isDangerousFileName,
  sanitizeFileName,
  uniqueFileName,
} from '../../core/downloads/file-names';
import { uuidv7 } from '../../core/id/uuidv7';
import { originLabel } from '../../core/url/display';
import { historyUrl, withoutSecrets } from '../../core/url/hygiene';
import { MAX_STORED_URL } from '../../shared/contracts/data-rpc';
import type { DownloadRow } from '../../shared/contracts/data-rpc';
import type { Logger } from '../platform/logger';
import type { DownloadStore } from './download-store';

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';

/** What the shell shows of a download. No path: the shell never sees or sends one. */
export interface DownloadView {
  readonly id: string;
  readonly fileName: string;
  readonly state: DownloadState;
  readonly receivedBytes: number;
  /** 0 when the server didn't say. */
  readonly totalBytes: number;
  readonly dangerous: boolean;
  /** A dangerous file the user kept; always true for other files. */
  readonly confirmed: boolean;
  readonly canResume: boolean;
  /** The site that started it (`originLabel`), or '' when Veltriva did. */
  readonly site: string;
}

export interface FileActions {
  /** '' on success, or Windows' error text. */
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

interface DownloadRecord {
  readonly id: string;
  /** The running download; null for one restored from the history, which can only be listed. */
  readonly item: DownloadItem | null;
  readonly folder: string;
  /** The name it has, or will have once kept. */
  fileName: string;
  /** Where it is on disk right now. */
  path: string;
  state: DownloadState;
  readonly dangerous: boolean;
  confirmed: boolean;
  /** What the shell shows: the initiator's host (`originLabel`). */
  readonly site: string;
  /** What the row keeps: the initiator's registrable site. */
  readonly siteKey: string;
  /** Where it came from, secrets stripped; '' when this download has no row. */
  readonly url: string;
  readonly startedAt: number;
  /** Set exactly when the download isn't running (progressing or paused). */
  endedAt: number | null;
  /** The bytes last seen, for a record with no item to read them from. */
  receivedBytes: number;
  totalBytes: number;
  /** When its row was last written, for the progress throttle. */
  writtenAt: number;
}

/** Downloads shown, newest first. Older finished ones are forgotten (the files stay). */
export const MAX_LISTED_DOWNLOADS = 100;

/** A running download's progress is written at most this often; a change of state at once. */
export const PROGRESS_WRITE_INTERVAL_MS = 2000;

const isRunning = (state: DownloadState): boolean => state === 'progressing' || state === 'paused';

const newDownloadId = (): string => uuidv7(Date.now(), getRandomValues(new Uint8Array(10)));

/** The address as a row keeps it: no secrets, within the limit; the scheme alone as a last resort. */
function storedUrl(raw: string): string {
  const url = withoutSecrets(raw);
  if (url !== '' && url.length <= MAX_STORED_URL) {
    return url;
  }
  // Too long (a big `data:` image above all) or not an address: the scheme says what it was.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1];
  return scheme === undefined ? '' : `${scheme.toLowerCase()}:`;
}

/**
 * A row that can be one of ours: an absolute path whose last part is the row's own file name
 * (with the suffix while it waits for Keep). The file is not trusted, and Open and Keep act on
 * that path: a row pointing anywhere else is dropped.
 */
function isOurFile(row: DownloadRow): boolean {
  const diskName =
    row.dangerous && !row.confirmed ? `${row.fileName}${UNCONFIRMED_SUFFIX}` : row.fileName;
  return (
    isOnDrive(row.path) &&
    basename(row.fileName) === row.fileName &&
    basename(row.path) === diskName
  );
}

/**
 * A path on a lettered drive (`C:\…`). Not a network path: opening `\\host\share\…` makes Windows
 * connect over SMB and may send the user's credentials (the omnibox refuses them for that reason),
 * and a rooted `\…` depends on the current drive. A Downloads folder on a network share loses its
 * history across a restart; its downloads still work.
 */
function isOnDrive(path: string): boolean {
  const { root } = win32.parse(path);
  return isAbsolute(path) && root.length === 3 && root[1] === ':' && /^[a-z]$/i.test(root[0] ?? '');
}

/** A byte count as its column holds it. */
const byteCount = (bytes: number): number =>
  Number.isFinite(bytes) ? Math.min(Math.max(0, Math.floor(bytes)), Number.MAX_SAFE_INTEGER) : 0;

export class DownloadManager {
  readonly #folder: () => string;
  readonly #files: FileActions;
  readonly #onChange: () => void;
  readonly #logger: Logger;
  readonly #store: DownloadStore | undefined;
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #records = new Map<string, DownloadRecord>();
  /** Names held by downloads that haven't finished or been kept, so two can't take the same. */
  readonly #reserved = new Set<string>();

  constructor(options: {
    readonly folder: () => string;
    readonly files: FileActions;
    readonly onChange: () => void;
    readonly logger: Logger;
    /** The download history. Without one, downloads last until quit. */
    readonly store?: DownloadStore;
    /** A new download's id: a UUIDv7, the key of its row. */
    readonly newId?: () => string;
    /** Unix milliseconds. */
    readonly now?: () => number;
  }) {
    this.#folder = options.folder;
    this.#files = options.files;
    this.#onChange = options.onChange;
    this.#logger = options.logger;
    this.#store = options.store;
    this.#newId = options.newId ?? newDownloadId;
    this.#now = options.now ?? Date.now;
  }

  /** Handles a session's downloads. Call once per session, before anything can download. */
  attach(session: Session): void {
    session.on('will-download', (_event, item) => {
      this.#start(item);
    });
  }

  list(): DownloadView[] {
    return [...this.#records.values()].reverse().map((record) => {
      const { received, total } = this.#bytes(record);
      return {
        id: record.id,
        fileName: record.fileName,
        state: record.state,
        receivedBytes: Math.max(0, received),
        totalBytes: Math.max(0, total),
        dangerous: record.dangerous,
        confirmed: record.confirmed,
        canResume: record.state === 'interrupted' && record.item?.canResume() === true,
        site: record.site,
      };
    });
  }

  has(id: string): boolean {
    return this.#records.has(id);
  }

  /**
   * Puts the stored downloads back in the list, once at startup, before anything downloads.
   * `rows` are newest first, as `downloads.list` returns them. Each comes back finished, with no
   * DownloadItem to act on (pause, resume and cancel do nothing; Open and Show in folder act on
   * the stored path as for any finished download):
   *   - one that was running when the app died (progressing, paused) is `interrupted`, and is
   *     written back so;
   *   - a dangerous file still waiting for Keep stays so if its `.unconfirmed` file is where main
   *     left it (Keep and Discard act on that path alone), and is `cancelled` if it is gone;
   *   - what doesn't fit MAX_LISTED_DOWNLOADS (the newest are kept, below any download already
   *     running) is dropped, and so is a row that can't be ours (a path that isn't absolute):
   *     their rows are deleted.
   */
  restore(rows: readonly DownloadRow[]): void {
    let room = Math.max(0, MAX_LISTED_DOWNLOADS - this.#records.size);
    const restored: { readonly record: DownloadRecord; readonly stored: DownloadState }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (this.#records.has(row.id) || seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      if (room === 0 || !isOurFile(row)) {
        this.#toStore((store) => {
          store.remove(row.id);
        });
        continue;
      }
      room -= 1;
      restored.push({ record: this.#restored(row), stored: row.state });
    }
    if (restored.length === 0) {
      return;
    }
    // The map runs oldest first, and everything restored is older than what is running now.
    const running = [...this.#records.values()];
    this.#records.clear();
    for (const { record } of [...restored].reverse()) {
      this.#records.set(record.id, record);
    }
    for (const record of running) {
      this.#records.set(record.id, record);
    }
    for (const { record, stored } of restored) {
      if (record.state !== stored) {
        this.#save(record);
      }
    }
    this.#onChange();
  }

  pause(id: string): void {
    const record = this.#records.get(id);
    if (record !== undefined && record.item !== null && record.state === 'progressing') {
      record.item.pause();
      this.#setState(record, 'paused');
      this.#save(record);
      this.#onChange();
    }
  }

  resume(id: string): void {
    const record = this.#records.get(id);
    if (record === undefined || record.item === null) {
      return; // Unknown, or restored: nothing is left to resume.
    }
    if (record.state === 'paused' || (record.state === 'interrupted' && record.item.canResume())) {
      record.item.resume();
      this.#setState(record, 'progressing');
      this.#save(record);
      this.#onChange();
    }
  }

  cancel(id: string): void {
    const record = this.#records.get(id);
    if (record === undefined || record.item === null) {
      return; // Unknown, or restored: nothing is running to cancel.
    }
    if (isRunning(record.state)) {
      // Chromium deletes the partial file; 'done' reports `cancelled`.
      record.item.cancel();
    }
  }

  /** Opens a finished file, on the user's click only. A dangerous one needs Keep first. */
  async open(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record?.state !== 'completed' || !record.confirmed) {
      return;
    }
    const error = await this.#files.openPath(record.path);
    if (error !== '') {
      this.#logger.warn('download.openFailed', { dangerous: record.dangerous });
    }
  }

  showInFolder(id: string): void {
    const record = this.#records.get(id);
    // Like Open: a dangerous file is not shown until the user keeps it (found by E2E).
    if (record?.state === 'completed' && record.confirmed && existsSync(record.path)) {
      this.#files.showItemInFolder(record.path);
    }
  }

  /** The user keeps a finished dangerous file: it gets its real name and can be opened. */
  async keep(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record?.state !== 'completed' || !record.dangerous || record.confirmed) {
      return;
    }
    this.#reserved.delete(record.fileName);
    const fileName = uniqueFileName(record.fileName, (name) =>
      this.#taken(record.folder, name, record.path),
    );
    const finalPath = join(record.folder, fileName);
    try {
      await rename(record.path, finalPath);
    } catch {
      this.#logger.warn('download.keepFailed');
      this.#reserved.add(record.fileName);
      return;
    }
    record.fileName = fileName;
    record.path = finalPath;
    record.confirmed = true;
    this.#save(record);
    this.#onChange();
  }

  /** The user discards a dangerous file: cancelled if running, deleted if finished. */
  async discard(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined || !record.dangerous || record.confirmed) {
      return;
    }
    if (isRunning(record.state)) {
      record.item?.cancel();
      return;
    }
    if (record.state === 'completed') {
      await rm(record.path, { force: true });
    }
    this.#forget(record);
  }

  /** Removes a finished download from the list; the file stays. An unkept dangerous one can't be. */
  clear(id: string): void {
    const record = this.#records.get(id);
    if (record !== undefined && this.#removable(record)) {
      this.#forget(record);
    }
  }

  /** `clear` for every download it allows: what is running, or waits for Keep, stays. */
  clearFinished(): void {
    const gone = [...this.#records.values()].filter((record) => this.#removable(record));
    if (gone.length === 0) {
      return;
    }
    for (const record of gone) {
      this.#drop(record);
    }
    if (this.#records.size === 0) {
      // Nothing is left: one statement, which also takes any row the list never had.
      this.#toStore((store) => {
        store.clear();
      });
    } else {
      gone.forEach((record) => {
        this.#unsave(record);
      });
    }
    this.#onChange();
  }

  #start(item: DownloadItem): void {
    const folder = this.#folder();
    const suggested = sanitizeFileName(item.getFilename());
    const fileName = uniqueFileName(suggested, (name) => this.#taken(folder, name));
    const dangerous = isDangerousFileName(fileName);
    const diskName = dangerous ? `${fileName}${UNCONFIRMED_SUFFIX}` : fileName;
    const path = join(folder, diskName);
    // Synchronously, before Electron would show its save dialog.
    item.setSavePath(path);
    this.#reserved.add(fileName);

    const initiator = item.getInitiatorOrigin();
    const startedAt = this.#now();
    const record: DownloadRecord = {
      id: this.#newId(),
      item,
      folder,
      fileName,
      path,
      state: 'progressing',
      dangerous,
      confirmed: !dangerous,
      site: initiator === '' ? '' : originLabel(initiator),
      // '' when Veltriva started it, or the origin isn't a web page (it has no site to name).
      siteKey: historyUrl(initiator)?.site ?? '',
      // Without a store there is no row to fill: nothing to compute.
      url: this.#store === undefined ? '' : storedUrl(item.getURL()),
      startedAt,
      endedAt: null,
      receivedBytes: 0,
      totalBytes: 0,
      writtenAt: startedAt,
    };
    this.#records.set(record.id, record);
    this.#trim();

    item.on('updated', (_event, state) => {
      const changed = this.#setState(
        record,
        state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing',
      );
      if (changed || this.#now() - record.writtenAt >= PROGRESS_WRITE_INTERVAL_MS) {
        this.#save(record);
      }
      this.#onChange();
    });
    item.once('done', (_event, state) => {
      this.#setState(record, state);
      if (state !== 'completed' || !dangerous) {
        this.#reserved.delete(fileName);
      }
      if (state === 'cancelled' && dangerous) {
        // A discarded dangerous download leaves nothing behind, not even its row.
        this.#forget(record);
        return;
      }
      this.#save(record);
      this.#onChange();
    });
    this.#save(record);
    this.#onChange();
  }

  /** A stored download as a record: finished, with no item. */
  #restored(row: DownloadRow): DownloadRecord {
    let state: DownloadState = isRunning(row.state) ? 'interrupted' : row.state;
    if (row.dangerous && !row.confirmed && state === 'completed') {
      if (existsSync(row.path)) {
        this.#reserved.add(row.fileName);
      } else {
        state = 'cancelled'; // Waiting for Keep, and nothing left to keep.
      }
    }
    return {
      id: row.id,
      item: null,
      folder: dirname(row.path),
      fileName: row.fileName,
      path: row.path,
      state,
      dangerous: row.dangerous,
      confirmed: row.confirmed,
      // The row keeps the registrable site, and that is all there is to show.
      site: row.site,
      siteKey: row.site,
      url: row.url,
      startedAt: row.startedAt,
      endedAt: state === row.state ? row.endedAt : Math.max(this.#now(), row.startedAt),
      receivedBytes: row.receivedBytes,
      totalBytes: row.totalBytes,
      writtenAt: this.#now(),
    };
  }

  /** Whether a name is in use; `ownPath` is the asking download's own file, which doesn't count. */
  #taken(folder: string, name: string, ownPath?: string): boolean {
    const unconfirmed = join(folder, `${name}${UNCONFIRMED_SUFFIX}`);
    return (
      this.#reserved.has(name) ||
      existsSync(join(folder, name)) ||
      (unconfirmed !== ownPath && existsSync(unconfirmed))
    );
  }

  /** What `clear` may remove: not a running download, nor a finished dangerous one awaiting Keep. */
  #removable(record: DownloadRecord): boolean {
    if (isRunning(record.state)) {
      return false;
    }
    return !(record.dangerous && !record.confirmed && record.state === 'completed');
  }

  #forget(record: DownloadRecord): void {
    this.#drop(record);
    this.#unsave(record);
    this.#onChange();
  }

  /** Takes the record off the list (not its row). */
  #drop(record: DownloadRecord): void {
    this.#records.delete(record.id);
    this.#reserved.delete(record.fileName);
  }

  /** Keeps the list bounded: the oldest finished downloads go first. */
  #trim(): void {
    for (const record of this.#records.values()) {
      if (this.#records.size <= MAX_LISTED_DOWNLOADS) {
        return;
      }
      const unkept = record.dangerous && !record.confirmed;
      if (!isRunning(record.state) && !unkept) {
        this.#records.delete(record.id);
        this.#unsave(record);
      }
    }
  }

  /** Moves a record to `state`, and sets or clears `endedAt` to match. False if it was there. */
  #setState(record: DownloadRecord, state: DownloadState): boolean {
    if (record.state === state) {
      return false;
    }
    record.state = state;
    record.endedAt = isRunning(state) ? null : this.#now();
    return true;
  }

  #bytes(record: DownloadRecord): { readonly received: number; readonly total: number } {
    return record.item === null
      ? { received: record.receivedBytes, total: record.totalBytes }
      : { received: record.item.getReceivedBytes(), total: record.item.getTotalBytes() };
  }

  /** Writes the record's row, as it is now. Only a record still in the list has one to write. */
  #save(record: DownloadRecord): void {
    if (record.url === '' || this.#records.get(record.id) !== record) {
      return;
    }
    record.writtenAt = this.#now();
    this.#toStore((store) => {
      store.upsert(this.#row(record));
    });
  }

  #unsave(record: DownloadRecord): void {
    if (record.url !== '') {
      this.#toStore((store) => {
        store.remove(record.id);
      });
    }
  }

  #row(record: DownloadRecord): DownloadRow {
    const { received, total } = this.#bytes(record);
    return {
      id: record.id,
      fileName: record.fileName,
      path: record.path,
      url: record.url,
      site: record.siteKey,
      state: record.state,
      dangerous: record.dangerous,
      confirmed: record.confirmed,
      receivedBytes: byteCount(received),
      totalBytes: byteCount(total),
      startedAt: record.startedAt,
      // Never before it started, whatever the clock did.
      endedAt: isRunning(record.state)
        ? null
        : Math.max(record.endedAt ?? record.startedAt, record.startedAt),
    };
  }

  /** The history must never get in a download's way: whatever the store does stays here. */
  #toStore(action: (store: DownloadStore) => void): void {
    if (this.#store === undefined) {
      return;
    }
    try {
      action(this.#store);
    } catch {
      this.#logger.warn('download.persistFailed');
    }
  }
}
