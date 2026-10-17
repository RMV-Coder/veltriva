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
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { DownloadItem, Session } from 'electron';

import {
  UNCONFIRMED_SUFFIX,
  isDangerousFileName,
  sanitizeFileName,
  uniqueFileName,
} from '../../core/downloads/file-names';
import { originLabel } from '../../core/url/display';
import type { Logger } from '../platform/logger';

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
  readonly item: DownloadItem;
  readonly folder: string;
  /** The name it has, or will have once kept. */
  fileName: string;
  /** Where it is on disk right now. */
  path: string;
  state: DownloadState;
  readonly dangerous: boolean;
  confirmed: boolean;
  readonly site: string;
}

/** Downloads shown, newest first. Older finished ones are forgotten (the files stay). */
export const MAX_LISTED_DOWNLOADS = 100;

export class DownloadManager {
  readonly #folder: () => string;
  readonly #files: FileActions;
  readonly #onChange: () => void;
  readonly #logger: Logger;
  readonly #records = new Map<string, DownloadRecord>();
  /** Names held by downloads that haven't finished or been kept, so two can't take the same. */
  readonly #reserved = new Set<string>();
  #nextId = 0;

  constructor(options: {
    readonly folder: () => string;
    readonly files: FileActions;
    readonly onChange: () => void;
    readonly logger: Logger;
  }) {
    this.#folder = options.folder;
    this.#files = options.files;
    this.#onChange = options.onChange;
    this.#logger = options.logger;
  }

  /** Handles a session's downloads. Call once per session, before anything can download. */
  attach(session: Session): void {
    session.on('will-download', (_event, item) => {
      this.#start(item);
    });
  }

  list(): DownloadView[] {
    return [...this.#records.values()].reverse().map((record) => ({
      id: record.id,
      fileName: record.fileName,
      state: record.state,
      receivedBytes: Math.max(0, record.item.getReceivedBytes()),
      totalBytes: Math.max(0, record.item.getTotalBytes()),
      dangerous: record.dangerous,
      confirmed: record.confirmed,
      canResume: record.state === 'interrupted' && record.item.canResume(),
      site: record.site,
    }));
  }

  has(id: string): boolean {
    return this.#records.has(id);
  }

  pause(id: string): void {
    const record = this.#records.get(id);
    if (record?.state === 'progressing') {
      record.item.pause();
      record.state = 'paused';
      this.#onChange();
    }
  }

  resume(id: string): void {
    const record = this.#records.get(id);
    if (record === undefined) {
      return;
    }
    if (record.state === 'paused' || (record.state === 'interrupted' && record.item.canResume())) {
      record.item.resume();
      record.state = 'progressing';
      this.#onChange();
    }
  }

  cancel(id: string): void {
    const record = this.#records.get(id);
    if (record !== undefined && (record.state === 'progressing' || record.state === 'paused')) {
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
    this.#onChange();
  }

  /** The user discards a dangerous file: cancelled if running, deleted if finished. */
  async discard(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined || !record.dangerous || record.confirmed) {
      return;
    }
    if (record.state === 'progressing' || record.state === 'paused') {
      record.item.cancel();
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
    if (record === undefined || record.state === 'progressing' || record.state === 'paused') {
      return;
    }
    if (record.dangerous && !record.confirmed && record.state === 'completed') {
      return;
    }
    this.#forget(record);
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

    this.#nextId += 1;
    const initiator = item.getInitiatorOrigin();
    const record: DownloadRecord = {
      id: `download-${String(this.#nextId)}`,
      item,
      folder,
      fileName,
      path,
      state: 'progressing',
      dangerous,
      confirmed: !dangerous,
      site: initiator === '' ? '' : originLabel(initiator),
    };
    this.#records.set(record.id, record);
    this.#trim();

    item.on('updated', (_event, state) => {
      record.state =
        state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      this.#onChange();
    });
    item.once('done', (_event, state) => {
      record.state = state;
      if (state !== 'completed' || !dangerous) {
        this.#reserved.delete(fileName);
      }
      if (state === 'cancelled' && dangerous) {
        // A discarded dangerous download leaves nothing behind, not even its row.
        this.#forget(record);
        return;
      }
      this.#onChange();
    });
    this.#onChange();
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

  #forget(record: DownloadRecord): void {
    this.#records.delete(record.id);
    this.#reserved.delete(record.fileName);
    this.#onChange();
  }

  /** Keeps the list bounded: the oldest finished downloads go first. */
  #trim(): void {
    for (const record of this.#records.values()) {
      if (this.#records.size <= MAX_LISTED_DOWNLOADS) {
        return;
      }
      const finished = record.state !== 'progressing' && record.state !== 'paused';
      const unkept = record.dangerous && !record.confirmed;
      if (finished && !unkept) {
        this.#records.delete(record.id);
      }
    }
  }
}
