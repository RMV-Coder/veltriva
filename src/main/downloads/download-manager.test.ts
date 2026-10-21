import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7, UUID_V7_PATTERN } from '../../core/id/uuidv7';
import { MAX_STORED_URL, downloadRowSchema } from '../../shared/contracts/data-rpc';
import type { DownloadRow } from '../../shared/contracts/data-rpc';
import {
  DownloadManager,
  MAX_LISTED_DOWNLOADS,
  PROGRESS_WRITE_INTERVAL_MS,
} from './download-manager';
import type { DownloadStore } from './download-store';

/** Enough of Electron's DownloadItem for the manager. */
class FakeItem extends EventEmitter {
  savePath = '';
  paused = false;
  cancelled = false;
  received = 0;
  resumable = true;

  constructor(
    private readonly name: string,
    private readonly initiator = 'https://files.example',
    private readonly url = 'https://files.example/get/file',
  ) {
    super();
  }

  getFilename(): string {
    return this.name;
  }
  getURL(): string {
    return this.url;
  }
  getInitiatorOrigin(): string {
    return this.initiator;
  }
  setSavePath(path: string): void {
    this.savePath = path;
  }
  getReceivedBytes(): number {
    return this.received;
  }
  getTotalBytes(): number {
    return 100;
  }
  isPaused(): boolean {
    return this.paused;
  }
  canResume(): boolean {
    return this.resumable;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  cancel(): void {
    this.cancelled = true;
    this.emit('done', {}, 'cancelled');
  }
  /** Chromium writing the file and finishing. */
  finish(): void {
    writeFileSync(this.savePath, 'data');
    this.received = 100;
    this.emit('done', {}, 'completed');
  }
}

const T0 = 1_700_000_000_000;
const uuid = (n: number): string => uuidv7(T0, new Uint8Array(10).fill(n));

/** What the table's schema and CHECKs (0001_init.sql, amendment (c)) would refuse of a row. */
function violations(row: DownloadRow): string[] {
  const parsed = downloadRowSchema.safeParse(row);
  const found = parsed.success ? [] : [`schema: ${parsed.error.message}`];
  if ((row.state === 'progressing' || row.state === 'paused') !== (row.endedAt === null)) {
    found.push('ended_at is null exactly while running');
  }
  if (!row.dangerous && !row.confirmed) {
    found.push('only a dangerous file waits for Keep');
  }
  if (row.endedAt !== null && row.endedAt < row.startedAt) {
    found.push('ended before it started');
  }
  return found;
}

/** The `downloads` table as the manager sees it, and a log of what was asked of it. */
class FakeStore implements DownloadStore {
  readonly rows = new Map<string, DownloadRow>();
  readonly upserts: DownloadRow[] = [];
  readonly removed: string[] = [];
  cleared = 0;
  readonly invalid: string[] = [];

  upsert(row: DownloadRow): void {
    this.invalid.push(...violations(row));
    this.upserts.push(row);
    this.rows.set(row.id, row);
  }
  remove(id: string): void {
    this.removed.push(id);
    this.rows.delete(id);
  }
  clear(): void {
    this.cleared += 1;
    this.rows.clear();
  }
}

const folders: string[] = [];
const stores: FakeStore[] = [];
afterEach(() => {
  // Whatever a test did, every row written was one the database would accept.
  for (const store of stores.splice(0)) {
    expect(store.invalid).toEqual([]);
  }
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

interface SetupOptions {
  /** A store of the test's own, or `false` for none. */
  readonly store?: DownloadStore | false;
  /** Leave the ids to the manager. */
  readonly ownIds?: boolean;
}

function setup(options: SetupOptions = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'veltriva-downloads-'));
  folders.push(folder);
  const session = new EventEmitter();
  const opened: string[] = [];
  const shown: string[] = [];
  const onChange = vi.fn();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const store = new FakeStore();
  stores.push(store);
  const clock = { time: T0 };
  /** The ids the manager asked for, in order. */
  const ids: string[] = [];
  const manager = new DownloadManager({
    folder: () => folder,
    files: {
      openPath: (path) => {
        opened.push(path);
        return Promise.resolve('');
      },
      showItemInFolder: (path) => shown.push(path),
    },
    onChange,
    logger,
    ...(options.store === false ? {} : { store: options.store ?? store }),
    ...(options.ownIds === true
      ? {}
      : {
          newId: () => {
            const id = uuid(ids.length + 1);
            ids.push(id);
            return id;
          },
        }),
    now: () => clock.time,
  });
  manager.attach(session as never);
  const start = (name: string, initiator?: string, url?: string): FakeItem => {
    const item = new FakeItem(name, initiator, url);
    session.emit('will-download', {}, item);
    return item;
  };
  /** A stored download, as `downloads.list` would return it. */
  const stored = (overrides: Partial<DownloadRow> & { readonly n: number }): DownloadRow => {
    const { n, ...rest } = overrides;
    const state = rest.state ?? 'completed';
    return {
      id: uuid(100 + n),
      fileName: `stored-${String(n)}.txt`,
      path: join(folder, `stored-${String(n)}.txt`),
      url: 'https://files.example/stored',
      site: 'files.example',
      state,
      dangerous: false,
      confirmed: true,
      receivedBytes: 100,
      totalBytes: 100,
      startedAt: T0 - 10_000 + n,
      endedAt: state === 'progressing' || state === 'paused' ? null : T0 - 5000 + n,
      ...rest,
    };
  };
  return { folder, manager, start, opened, shown, onChange, logger, store, clock, ids, stored };
}

describe('DownloadManager', () => {
  it('saves to the folder under a sanitized name, with no dialog, and lists it', () => {
    const { folder, manager, start } = setup();
    const item = start('../../evil‮fdp.txt');
    expect(item.savePath).toBe(join(folder, '_.._evilfdp.txt'));
    expect(manager.list()).toEqual([
      expect.objectContaining({
        fileName: '_.._evilfdp.txt',
        state: 'progressing',
        dangerous: false,
        confirmed: true,
        site: 'files.example',
      }),
    ]);
  });

  it('never overwrites: on disk or held by another download', () => {
    const { folder, start } = setup();
    writeFileSync(join(folder, 'report.pdf'), 'old');
    const first = start('report.pdf');
    const second = start('report.pdf');
    expect(first.savePath).toBe(join(folder, 'report (1).pdf'));
    expect(second.savePath).toBe(join(folder, 'report (2).pdf'));
  });

  it('opens and shows a finished file only, by the path it recorded', async () => {
    const { folder, manager, start, opened, shown } = setup();
    const item = start('notes.txt');
    const [view] = manager.list();
    await manager.open(view?.id ?? '');
    expect(opened).toEqual([]);
    item.finish();
    await manager.open(view?.id ?? '');
    manager.showInFolder(view?.id ?? '');
    expect(opened).toEqual([join(folder, 'notes.txt')]);
    expect(shown).toEqual([join(folder, 'notes.txt')]);
    expect(manager.list()[0]?.state).toBe('completed');
  });

  it('keeps a dangerous file under a name Windows won’t run until the user keeps it', async () => {
    const { folder, manager, start, opened, shown } = setup();
    const item = start('setup.exe');
    expect(item.savePath).toBe(join(folder, 'setup.exe.unconfirmed'));
    item.finish();
    const id = manager.list()[0]?.id ?? '';
    expect(manager.list()[0]).toMatchObject({ dangerous: true, confirmed: false });

    await manager.open(id);
    expect(opened).toEqual([]);
    manager.clear(id);
    expect(manager.has(id)).toBe(true);
    manager.showInFolder(id);
    expect(shown).toEqual([]);

    await manager.keep(id);
    expect(readdirSync(folder)).toEqual(['setup.exe']);
    expect(manager.list()[0]).toMatchObject({ fileName: 'setup.exe', confirmed: true });
    await manager.open(id);
    expect(opened).toEqual([join(folder, 'setup.exe')]);
  });

  it('keeps under a free name if the real one was taken meanwhile', async () => {
    const { folder, manager, start } = setup();
    const item = start('tool.msi');
    item.finish();
    writeFileSync(join(folder, 'tool.msi'), 'someone else');
    await manager.keep(manager.list()[0]?.id ?? '');
    expect(readdirSync(folder).sort()).toEqual(['tool (1).msi', 'tool.msi']);
  });

  it('discards a dangerous file: deleted when finished, cancelled when running, and gone', async () => {
    const { folder, manager, start } = setup();
    const done = start('a.bat');
    done.finish();
    await manager.discard(manager.list()[0]?.id ?? '');
    expect(existsSync(done.savePath)).toBe(false);
    expect(manager.list()).toEqual([]);

    const running = start('b.lnk');
    await manager.discard(manager.list()[0]?.id ?? '');
    expect(running.cancelled).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('never discards or deletes an ordinary file', async () => {
    const { manager, start } = setup();
    const item = start('photo.jpg');
    item.finish();
    await manager.discard(manager.list()[0]?.id ?? '');
    expect(existsSync(item.savePath)).toBe(true);
    expect(manager.list()).toHaveLength(1);
  });

  it('pauses, resumes and cancels a running download', () => {
    const { manager, start } = setup();
    const item = start('big.zip');
    const id = manager.list()[0]?.id ?? '';
    manager.pause(id);
    expect(item.paused).toBe(true);
    expect(manager.list()[0]?.state).toBe('paused');
    manager.resume(id);
    expect(manager.list()[0]?.state).toBe('progressing');
    manager.cancel(id);
    expect(manager.list()[0]?.state).toBe('cancelled');
    // Finished: removable from the list, nothing left to cancel.
    manager.clear(id);
    expect(manager.list()).toEqual([]);
  });

  it('resumes an interrupted download only if Chromium can', () => {
    const { manager, start } = setup();
    const item = start('flaky.zip');
    const id = manager.list()[0]?.id ?? '';
    item.emit('updated', {}, 'interrupted');
    expect(manager.list()[0]).toMatchObject({ state: 'interrupted', canResume: true });
    item.resumable = false;
    manager.resume(id);
    expect(manager.list()[0]?.state).toBe('interrupted');
    item.resumable = true;
    manager.resume(id);
    expect(manager.list()[0]?.state).toBe('progressing');
  });

  it('names nobody for a download Veltriva started itself, and ignores unknown ids', async () => {
    const { manager, start } = setup();
    start('x.txt', '');
    expect(manager.list()[0]?.site).toBe('');
    manager.pause('download-999');
    await manager.open('download-999');
    await manager.keep('download-999');
  });
});

describe('DownloadManager ids', () => {
  it("takes each download's id from newId", () => {
    const { manager, start, ids } = setup();
    start('a.txt');
    start('b.txt');
    expect(ids).toEqual([uuid(1), uuid(2)]);
    expect(manager.list().map((view) => view.id)).toEqual([uuid(2), uuid(1)]);
    expect(manager.has(uuid(1))).toBe(true);
    expect(manager.has('download-1')).toBe(false);
  });

  it('makes UUIDv7 ids itself when none is given', () => {
    const { manager, start } = setup({ ownIds: true });
    start('a.txt');
    start('b.txt');
    const ids = manager.list().map((view) => view.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(UUID_V7_PATTERN);
    }
  });
});

describe('DownloadManager history: writing through', () => {
  it('writes a row when a download starts: the address without secrets, the registrable site', () => {
    const { folder, manager, start, store, clock, ids } = setup();
    start(
      'report.pdf',
      'https://cdn.files.example.com:8443',
      'https://user:pw@files.example/get?token=abc&page=2#part',
    );
    expect(store.rows.get(ids[0] ?? '')).toEqual({
      id: ids[0],
      fileName: 'report.pdf',
      path: join(folder, 'report.pdf'),
      url: 'https://files.example/get?page=2#part',
      site: 'example.com',
      state: 'progressing',
      dangerous: false,
      confirmed: true,
      receivedBytes: 0,
      totalBytes: 100,
      startedAt: clock.time,
      endedAt: null,
    });
    // The shell keeps seeing the host, as before.
    expect(manager.list()[0]?.site).toBe('cdn.files.example.com:8443');
  });

  it('stores no site when Veltriva started it or the page has none', () => {
    const { start, store, ids } = setup();
    start('a.txt', '');
    start('b.txt', 'null');
    start('c.txt', 'file://');
    expect(ids.map((id) => store.rows.get(id)?.site)).toEqual(['', '', '']);
  });

  it('keeps only the scheme of an address too long to store, or none it can parse', () => {
    const { manager, start, store, ids } = setup();
    start('image.png', undefined, `data:image/png;base64,${'A'.repeat(MAX_STORED_URL)}`);
    start('big.bin', undefined, `https://files.example/${'a'.repeat(MAX_STORED_URL)}`);
    expect(store.rows.get(ids[0] ?? '')?.url).toBe('data:');
    expect(store.rows.get(ids[1] ?? '')?.url).toBe('https:');

    // Nothing at all to keep of it: the download is listed and works, but has no row.
    const nameless = start('mystery.bin', undefined, '');
    expect(manager.list()[0]).toMatchObject({ fileName: 'mystery.bin', state: 'progressing' });
    nameless.finish();
    expect(manager.list()[0]?.state).toBe('completed');
    expect(store.rows.has(ids[2] ?? '')).toBe(false);
    manager.clear(ids[2] ?? '');
    expect(manager.has(ids[2] ?? '')).toBe(false);
    expect(store.removed).toEqual([]);
  });

  it('writes each change of state, and the end', () => {
    const { manager, start, store, clock, ids } = setup();
    const item = start('big.zip');
    const id = ids[0] ?? '';
    const state = (): unknown => store.rows.get(id)?.state;

    clock.time += 100;
    manager.pause(id);
    expect(store.rows.get(id)).toMatchObject({ state: 'paused', endedAt: null });
    manager.resume(id);
    expect(store.rows.get(id)).toMatchObject({ state: 'progressing', endedAt: null });

    clock.time += 100;
    item.emit('updated', {}, 'interrupted');
    expect(store.rows.get(id)).toMatchObject({ state: 'interrupted', endedAt: clock.time });
    manager.resume(id);
    expect(store.rows.get(id)).toMatchObject({ state: 'progressing', endedAt: null });

    item.paused = true;
    item.emit('updated', {}, 'progressing');
    expect(state()).toBe('paused');
    item.paused = false;
    item.emit('updated', {}, 'progressing');
    expect(state()).toBe('progressing');

    clock.time += 5000;
    item.finish();
    expect(store.rows.get(id)).toMatchObject({
      state: 'completed',
      receivedBytes: 100,
      endedAt: clock.time,
    });
  });

  it('writes a cancelled download as cancelled', () => {
    const { manager, start, store, clock, ids } = setup();
    start('big.zip');
    clock.time += 10;
    manager.cancel(ids[0] ?? '');
    expect(store.rows.get(ids[0] ?? '')).toMatchObject({ state: 'cancelled', endedAt: clock.time });
  });

  it('writes a dangerous file as waiting, then as kept under its real name', async () => {
    const { folder, manager, start, store, ids } = setup();
    start('setup.exe').finish();
    const id = ids[0] ?? '';
    expect(store.rows.get(id)).toMatchObject({
      fileName: 'setup.exe',
      path: join(folder, 'setup.exe.unconfirmed'),
      state: 'completed',
      dangerous: true,
      confirmed: false,
    });
    await manager.keep(id);
    expect(store.rows.get(id)).toMatchObject({
      fileName: 'setup.exe',
      path: join(folder, 'setup.exe'),
      dangerous: true,
      confirmed: true,
    });
  });

  it('writes the name a dangerous file is kept under when the real one was taken', async () => {
    const { folder, manager, start, store, ids } = setup();
    start('tool.msi').finish();
    writeFileSync(join(folder, 'tool.msi'), 'someone else');
    await manager.keep(ids[0] ?? '');
    expect(store.rows.get(ids[0] ?? '')).toMatchObject({
      fileName: 'tool (1).msi',
      path: join(folder, 'tool (1).msi'),
    });
  });

  it('writes progress at most once every 2 s per download, but a change of state at once', () => {
    const { manager, start, store, clock, ids } = setup();
    const item = start('big.zip');
    const id = ids[0] ?? '';
    expect(store.upserts).toHaveLength(1);
    const progress = (received: number): void => {
      item.received = received;
      item.emit('updated', {}, 'progressing');
    };

    clock.time += 500;
    progress(10);
    clock.time += PROGRESS_WRITE_INTERVAL_MS - 600;
    progress(20);
    expect(store.upserts).toHaveLength(1);
    expect(store.rows.get(id)?.receivedBytes).toBe(0);

    clock.time += 100; // 2 s since the last write
    progress(30);
    expect(store.upserts).toHaveLength(2);
    expect(store.rows.get(id)?.receivedBytes).toBe(30);

    clock.time += PROGRESS_WRITE_INTERVAL_MS - 1;
    progress(40);
    expect(store.upserts).toHaveLength(2);
    clock.time += 1;
    progress(50);
    expect(store.upserts).toHaveLength(3);
    expect(store.rows.get(id)?.receivedBytes).toBe(50);

    // Inside the window, a change of state is still written at once, with the bytes so far.
    item.received = 60;
    manager.pause(id);
    expect(store.upserts).toHaveLength(4);
    expect(store.rows.get(id)).toMatchObject({ state: 'paused', receivedBytes: 60 });
    manager.resume(id);
    expect(store.upserts).toHaveLength(5);

    // And so is the end.
    item.received = 70;
    item.finish();
    expect(store.upserts).toHaveLength(6);
    expect(store.rows.get(id)).toMatchObject({ state: 'completed', receivedBytes: 100 });
  });

  it('throttles each download on its own', () => {
    const { start, store, clock, ids } = setup();
    const first = start('a.zip');
    clock.time += 1500;
    const second = start('b.zip');
    clock.time += 500; // 2 s after the first started, 0.5 s after the second
    first.received = 5;
    first.emit('updated', {}, 'progressing');
    second.received = 6;
    second.emit('updated', {}, 'progressing');
    expect(store.rows.get(ids[0] ?? '')?.receivedBytes).toBe(5);
    expect(store.rows.get(ids[1] ?? '')?.receivedBytes).toBe(0);
  });

  it('never writes an end before the start, whatever the clock did', () => {
    const { start, store, clock, ids } = setup();
    const item = start('a.zip');
    clock.time -= 60_000;
    item.finish();
    expect(store.rows.get(ids[0] ?? '')).toMatchObject({ endedAt: T0, startedAt: T0 });
  });
});

describe('DownloadManager history: removing', () => {
  it('deletes the row of a download the user removes', () => {
    const { manager, start, store, ids } = setup();
    start('a.txt').finish();
    start('b.txt');
    manager.clear(ids[1] ?? ''); // still running: stays
    expect(store.removed).toEqual([]);
    manager.clear(ids[0] ?? '');
    expect(store.removed).toEqual([ids[0]]);
    expect([...store.rows.keys()]).toEqual([ids[1]]);
  });

  it('keeps the row of a finished dangerous file that waits for Keep', () => {
    const { manager, start, store, ids } = setup();
    start('setup.exe').finish();
    manager.clear(ids[0] ?? '');
    expect(store.removed).toEqual([]);
    expect(store.rows.has(ids[0] ?? '')).toBe(true);
  });

  it('deletes the row of a dangerous file that is discarded, finished or running', async () => {
    const { manager, start, store, ids } = setup();
    start('a.bat').finish();
    await manager.discard(ids[0] ?? '');
    start('b.lnk');
    await manager.discard(ids[1] ?? '');
    expect(store.removed).toEqual([ids[0], ids[1]]);
    expect(store.rows.size).toBe(0);
  });

  it('deletes the rows of the oldest finished downloads when the list is full', () => {
    const { manager, start, store, ids } = setup();
    for (let index = 0; index < MAX_LISTED_DOWNLOADS; index += 1) {
      start(`file-${String(index)}.txt`).finish();
    }
    expect(store.removed).toEqual([]);
    start('one-more.txt').finish();
    start('and-another.txt');
    expect(manager.list()).toHaveLength(MAX_LISTED_DOWNLOADS);
    expect(store.removed).toEqual([ids[0], ids[1]]);
    expect(store.rows.size).toBe(MAX_LISTED_DOWNLOADS);
  });

  it('removes every finished download with one clear when none is left', () => {
    const { manager, start, store } = setup();
    start('a.txt').finish();
    start('b.txt').emit('updated', {}, 'interrupted');
    start('c.txt').cancel();
    manager.clearFinished();
    expect(manager.list()).toEqual([]);
    expect(store.cleared).toBe(1);
    expect(store.removed).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it('removes finished downloads one by one while others stay', () => {
    const { manager, start, store, ids } = setup();
    start('a.txt').finish();
    start('running.zip');
    start('setup.exe').finish();
    start('b.txt').finish();
    manager.clearFinished();
    expect(manager.list().map((view) => view.id)).toEqual([ids[2], ids[1]]);
    expect(store.cleared).toBe(0);
    expect(store.removed).toEqual([ids[0], ids[3]]);
  });

  it('says so when the list changes, once', () => {
    const { manager, start, onChange } = setup();
    start('a.txt').finish();
    start('b.txt').finish();
    onChange.mockClear();
    manager.clearFinished();
    expect(onChange).toHaveBeenCalledTimes(1);
    manager.clearFinished();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('DownloadManager history: a store that fails', () => {
  it("never lets the store's errors reach the caller, or stop a download", async () => {
    const broken: DownloadStore = {
      upsert: () => {
        throw new Error('disk full');
      },
      remove: () => {
        throw new Error('disk full');
      },
      clear: () => {
        throw new Error('disk full');
      },
    };
    const { folder, manager, start, logger, ids, stored } = setup({ store: broken });

    const item = start('big.zip');
    manager.pause(ids[0] ?? '');
    manager.resume(ids[0] ?? '');
    item.emit('updated', {}, 'progressing');
    item.finish();
    expect(manager.list()[0]).toMatchObject({ state: 'completed' });

    start('setup.exe').finish();
    await manager.keep(ids[1] ?? '');
    expect(readdirSync(folder)).toContain('setup.exe');
    manager.clear(ids[0] ?? '');
    manager.clearFinished();
    expect(manager.list()).toEqual([]);

    manager.restore([stored({ n: 1 }), stored({ n: 2, state: 'paused' })]);
    expect(manager.list()).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith('download.persistFailed');
  });

  it('works without a store at all', async () => {
    const { manager, start, logger } = setup({ store: false });
    start('big.zip').finish();
    start('setup.exe').finish();
    start('tool.msi').finish();
    await manager.keep(manager.list()[0]?.id ?? '');
    manager.clearFinished();
    expect(manager.list().map((view) => view.fileName)).toEqual(['setup.exe']);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('DownloadManager history: restoring', () => {
  it('brings finished downloads back, newest first, with what the row says', () => {
    const { manager, onChange, stored } = setup();
    const rows = [
      stored({ n: 3, state: 'completed', site: 'example.com', receivedBytes: 90, totalBytes: 90 }),
      stored({ n: 2, state: 'cancelled', receivedBytes: 10, totalBytes: 0 }),
      stored({ n: 1, state: 'interrupted', receivedBytes: 40, totalBytes: 80 }),
    ];
    manager.restore(rows);
    expect(manager.list()).toEqual([
      {
        id: rows[0]?.id,
        fileName: 'stored-3.txt',
        state: 'completed',
        receivedBytes: 90,
        totalBytes: 90,
        dangerous: false,
        confirmed: true,
        canResume: false,
        site: 'example.com',
      },
      expect.objectContaining({ id: rows[1]?.id, state: 'cancelled', receivedBytes: 10 }),
      expect.objectContaining({
        id: rows[2]?.id,
        state: 'interrupted',
        receivedBytes: 40,
        totalBytes: 80,
        canResume: false,
      }),
    ]);
    expect(manager.has(rows[2]?.id ?? '')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('writes nothing back for rows that need no change', () => {
    const { manager, store, stored } = setup();
    manager.restore([stored({ n: 2 }), stored({ n: 1, state: 'cancelled' })]);
    expect(store.upserts).toEqual([]);
    expect(store.removed).toEqual([]);
  });

  it('says nothing, and changes nothing, when there is nothing to restore', () => {
    const { manager, onChange, store } = setup();
    manager.restore([]);
    expect(manager.list()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(store.upserts).toEqual([]);
  });

  it('brings back a download that was running when the app died as interrupted, and writes it so', () => {
    const { manager, store, clock, stored } = setup();
    const running = stored({ n: 2, state: 'progressing', receivedBytes: 30, totalBytes: 100 });
    const paused = stored({ n: 1, state: 'paused', receivedBytes: 50, totalBytes: 100 });
    manager.restore([running, paused]);
    expect(manager.list()).toEqual([
      expect.objectContaining({ state: 'interrupted', receivedBytes: 30, canResume: false }),
      expect.objectContaining({ state: 'interrupted', receivedBytes: 50, canResume: false }),
    ]);
    expect(store.rows.get(running.id)).toEqual({
      ...running,
      state: 'interrupted',
      endedAt: clock.time,
    });
    expect(store.rows.get(paused.id)).toMatchObject({ state: 'interrupted', endedAt: clock.time });
    expect(store.upserts).toHaveLength(2);
  });

  it('writes an interrupted row back with an end no earlier than its start', () => {
    const { manager, store, clock, stored } = setup();
    const row = stored({ n: 1, state: 'progressing', startedAt: clock.time + 60_000 });
    manager.restore([row]);
    expect(store.rows.get(row.id)).toMatchObject({
      state: 'interrupted',
      endedAt: row.startedAt,
    });
  });

  it('does nothing on pause, resume or cancel of a restored download, and nothing crashes', async () => {
    const { manager, store, onChange, stored } = setup();
    const rows = [
      stored({ n: 3, state: 'interrupted' }),
      stored({ n: 2, state: 'progressing' }),
      stored({ n: 1, state: 'completed' }),
    ];
    manager.restore(rows);
    store.upserts.length = 0;
    onChange.mockClear();
    const before = manager.list();
    for (const row of rows) {
      manager.pause(row.id);
      manager.resume(row.id);
      manager.cancel(row.id);
      await manager.discard(row.id);
      await manager.keep(row.id);
    }
    expect(manager.list()).toEqual(before);
    expect(store.upserts).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens and shows a restored finished file as any finished download', async () => {
    const { folder, manager, opened, shown, stored } = setup();
    const row = stored({ n: 1 });
    manager.restore([row]);

    // The file is gone: Windows reports it when opening, and showing it is skipped.
    await manager.open(row.id);
    manager.showInFolder(row.id);
    expect(opened).toEqual([row.path]);
    expect(shown).toEqual([]);

    writeFileSync(join(folder, 'stored-1.txt'), 'data');
    manager.showInFolder(row.id);
    expect(shown).toEqual([row.path]);
  });

  it('opens nothing that did not finish, or that waits for Keep', async () => {
    const { manager, opened, shown, stored } = setup();
    const rows = [
      stored({ n: 3, state: 'interrupted' }),
      stored({ n: 2, state: 'cancelled' }),
      stored({ n: 1, state: 'completed', dangerous: true, confirmed: false }),
    ];
    manager.restore(rows);
    for (const row of rows) {
      await manager.open(row.id);
      manager.showInFolder(row.id);
    }
    expect(opened).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('removes a restored download from the list and the history, as any other', () => {
    const { manager, store, stored } = setup();
    const row = stored({ n: 1, state: 'interrupted' });
    manager.restore([row]);
    manager.clear(row.id);
    expect(manager.list()).toEqual([]);
    expect(store.removed).toEqual([row.id]);
  });

  it('lets the user keep a dangerous file that is still where it was left', async () => {
    const { folder, manager, store, stored } = setup();
    const row = stored({
      n: 1,
      fileName: 'setup.exe',
      path: join(folder, 'setup.exe.unconfirmed'),
      dangerous: true,
      confirmed: false,
    });
    writeFileSync(row.path, 'data');
    manager.restore([row]);
    expect(manager.list()[0]).toMatchObject({
      state: 'completed',
      dangerous: true,
      confirmed: false,
    });
    expect(store.upserts).toEqual([]);

    manager.clear(row.id);
    expect(manager.has(row.id)).toBe(true);
    await manager.keep(row.id);
    expect(readdirSync(folder)).toEqual(['setup.exe']);
    expect(store.rows.get(row.id)).toMatchObject({
      path: join(folder, 'setup.exe'),
      confirmed: true,
    });
  });

  it('lets the user discard a dangerous file that is still where it was left', async () => {
    const { folder, manager, store, stored } = setup();
    const row = stored({
      n: 1,
      fileName: 'setup.exe',
      path: join(folder, 'setup.exe.unconfirmed'),
      dangerous: true,
      confirmed: false,
    });
    writeFileSync(row.path, 'data');
    manager.restore([row]);
    await manager.discard(row.id);
    expect(readdirSync(folder)).toEqual([]);
    expect(manager.list()).toEqual([]);
    expect(store.removed).toEqual([row.id]);
  });

  it('cancels a dangerous file that waited for Keep and is gone, and writes it so', () => {
    const { folder, manager, store, clock, stored } = setup();
    const row = stored({
      n: 1,
      fileName: 'setup.exe',
      path: join(folder, 'setup.exe.unconfirmed'),
      dangerous: true,
      confirmed: false,
    });
    manager.restore([row]);
    expect(manager.list()[0]).toMatchObject({ state: 'cancelled', dangerous: true });
    expect(store.rows.get(row.id)).toMatchObject({ state: 'cancelled', endedAt: clock.time });
    manager.clear(row.id);
    expect(manager.list()).toEqual([]);
  });

  it('brings back a dangerous download that was running as interrupted, and removable', () => {
    const { folder, manager, store, stored } = setup();
    const row = stored({
      n: 1,
      state: 'progressing',
      fileName: 'setup.exe',
      path: join(folder, 'setup.exe.unconfirmed'),
      dangerous: true,
      confirmed: false,
    });
    manager.restore([row]);
    expect(manager.list()[0]).toMatchObject({ state: 'interrupted', confirmed: false });
    expect(store.rows.get(row.id)).toMatchObject({ state: 'interrupted' });
    manager.clear(row.id);
    expect(manager.list()).toEqual([]);
  });

  it('keeps the newest, and deletes the rows of the rest, when more than fit', () => {
    const { manager, store, stored } = setup();
    const rows = Array.from({ length: MAX_LISTED_DOWNLOADS + 5 }, (_, index) =>
      stored({ n: MAX_LISTED_DOWNLOADS + 5 - index }),
    );
    manager.restore(rows);
    const listed = manager.list();
    expect(listed).toHaveLength(MAX_LISTED_DOWNLOADS);
    expect(listed.map((view) => view.id)).toEqual(
      rows.slice(0, MAX_LISTED_DOWNLOADS).map((row) => row.id),
    );
    expect(store.removed).toEqual(rows.slice(MAX_LISTED_DOWNLOADS).map((row) => row.id));
  });

  it('lists a new download above the restored ones, and counts them toward the limit', () => {
    const { manager, start, store, ids, stored } = setup();
    const rows = Array.from({ length: MAX_LISTED_DOWNLOADS }, (_, index) =>
      stored({ n: MAX_LISTED_DOWNLOADS - index }),
    );
    manager.restore(rows);
    start('new.txt');
    const listed = manager.list();
    expect(listed).toHaveLength(MAX_LISTED_DOWNLOADS);
    expect(listed[0]?.id).toBe(ids[0]);
    expect(listed[1]?.id).toBe(rows[0]?.id);
    // The oldest restored one made room.
    expect(store.removed).toEqual([rows[MAX_LISTED_DOWNLOADS - 1]?.id]);
  });

  it('puts the restored below a download that started before them', () => {
    const { manager, start, store, ids, stored } = setup();
    start('early.zip');
    const row = stored({ n: 1 });
    manager.restore([row]);
    expect(manager.list().map((view) => view.id)).toEqual([ids[0], row.id]);
    expect(store.removed).toEqual([]);
  });

  it('ignores a row it already has, and deletes one that cannot be ours', () => {
    const { manager, store, stored } = setup();
    const row = stored({ n: 1 });
    const strange = stored({ n: 2, path: 'relative/file.txt' });
    manager.restore([row, row, strange]);
    expect(manager.list().map((view) => view.id)).toEqual([row.id]);
    expect(store.removed).toEqual([strange.id]);
  });

  it('restores without a store', () => {
    const { manager, stored } = setup({ store: false });
    manager.restore([stored({ n: 1, state: 'paused' })]);
    expect(manager.list()[0]).toMatchObject({ state: 'interrupted' });
  });

  it("holds a restored dangerous file's name against a new download", () => {
    const { folder, manager, start, stored } = setup();
    const row = stored({
      n: 1,
      fileName: 'setup.exe',
      path: join(folder, 'setup.exe.unconfirmed'),
      dangerous: true,
      confirmed: false,
    });
    writeFileSync(row.path, 'data');
    manager.restore([row]);
    const item = start('setup.exe');
    expect(item.savePath).toBe(join(folder, 'setup (1).exe.unconfirmed'));
  });
});

describe('DownloadManager history: restoring a row that cannot be ours', () => {
  /**
   * What `restore` takes for one of its own files (isOurFile): an absolute path whose last part is
   * the row's file name, or that name with `.unconfirmed` for a dangerous file still waiting for
   * Keep. Open, Keep and Discard act on that path, and the database file is not trusted.
   */
  type Odd = (folder: string) => Partial<DownloadRow>;
  const unconfirmed = (path: string): Partial<DownloadRow> => ({
    fileName: 'setup.exe',
    path,
    dangerous: true,
    confirmed: false,
  });

  const DROPPED: readonly (readonly [string, Odd])[] = [
    ['a relative path with the right name', () => ({ path: 'stored-1.txt' })],
    ['a relative path in a folder', () => ({ path: 'downloads/stored-1.txt' })],
    ['a relative path that starts at this folder', () => ({ path: './stored-1.txt' })],
    ['a relative path that climbs out of its folder', () => ({ path: '../stored-1.txt' })],
    ['a path that is relative to a drive', () => ({ path: 'C:stored-1.txt' })],
    // Absolute to Node, but not on a lettered drive: a network share (opening it would make
    // Windows connect over SMB), and a path rooted on whatever the current drive is.
    ['a network path', () => ({ path: '//attacker.example/share/stored-1.txt' })],
    ['a network path to this machine', () => ({ path: '//localhost/c$/stored-1.txt' })],
    ['a path rooted on the current drive', () => ({ path: '/stored-1.txt' })],
    ['a path that is another file’s name', (folder) => ({ path: join(folder, 'other.txt') })],
    [
      'a path with the name and something after it',
      (folder) => ({ path: join(folder, 'stored-1.txt.exe') }),
    ],
    [
      'a path with something before the name',
      (folder) => ({ path: join(folder, 'old-stored-1.txt') }),
    ],
    [
      'a path inside a folder that has the name',
      (folder) => ({ path: join(folder, 'stored-1.txt', 'payload.exe') }),
    ],
    ['a path that is a folder', (folder) => ({ path: folder })],
    [
      'a file name with a folder in it',
      (folder) => ({ fileName: 'sub/stored-1.txt', path: join(folder, 'sub', 'stored-1.txt') }),
    ],
    [
      'a file name with a Windows folder in it',
      (folder) => ({ fileName: 'sub\\stored-1.txt', path: join(folder, 'sub', 'stored-1.txt') }),
    ],
    [
      'a file name that climbs out of the folder',
      (folder) => ({ fileName: '..\\evil.exe', path: join(folder, '..', 'evil.exe') }),
    ],
    ['a file name that is ..', (folder) => ({ fileName: '..', path: join(folder, '..') })],
    [
      'a dangerous file waiting for Keep, under its real name',
      (folder) => unconfirmed(join(folder, 'setup.exe')),
    ],
    [
      'a dangerous file waiting for Keep, under another suffix',
      (folder) => unconfirmed(join(folder, 'setup.exe.partial')),
    ],
    [
      'a dangerous file waiting for Keep, with the suffix twice',
      (folder) => unconfirmed(join(folder, 'setup.exe.unconfirmed.unconfirmed')),
    ],
    [
      'a dangerous file waiting for Keep, with the suffix on another name',
      (folder) => unconfirmed(join(folder, 'other.exe.unconfirmed')),
    ],
    [
      'a dangerous file waiting for Keep, with a relative path',
      () => unconfirmed('setup.exe.unconfirmed'),
    ],
    [
      'a file that is not dangerous, with the suffix',
      (folder) => ({ path: join(folder, 'stored-1.txt.unconfirmed') }),
    ],
    [
      'a dangerous file the user kept, still with the suffix',
      (folder) => ({
        fileName: 'setup.exe',
        path: join(folder, 'setup.exe.unconfirmed'),
        dangerous: true,
        confirmed: true,
      }),
    ],
  ];

  it.each(DROPPED)('drops %s, and deletes its row', (_what, odd) => {
    const { folder, manager, store, onChange, stored } = setup();
    const row = stored({ n: 1, ...odd(folder) });

    manager.restore([row]);

    expect(manager.list()).toEqual([]);
    expect(manager.has(row.id)).toBe(false);
    expect(store.removed).toEqual([row.id]);
    expect(store.upserts).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(DROPPED)(
    'does not open, show, keep, discard or touch the file of %s',
    async (_what, odd) => {
      const { folder, manager, opened, shown, stored } = setup();
      const row = stored({ n: 1, ...odd(folder) });
      // The files the row points at, or could be taken to point at, exist.
      for (const name of ['setup.exe', 'setup.exe.unconfirmed', 'stored-1.txt', 'other.txt']) {
        writeFileSync(join(folder, name), 'data');
      }
      const before = readdirSync(folder).sort();

      manager.restore([row]);
      await manager.open(row.id);
      manager.showInFolder(row.id);
      await manager.keep(row.id);
      await manager.discard(row.id);
      manager.clear(row.id);

      expect(opened).toEqual([]);
      expect(shown).toEqual([]);
      expect(readdirSync(folder).sort()).toEqual(before);
    },
  );

  it('keeps a file where its row says: an absolute path ending in its name', () => {
    const { folder, manager, store, stored } = setup();
    const row = stored({ n: 1 });

    manager.restore([row]);

    expect(manager.list().map((view) => view.id)).toEqual([row.id]);
    expect(store.removed).toEqual([]);
    expect(row.path).toBe(join(folder, 'stored-1.txt'));
  });

  it.each([
    [
      'a dangerous file waiting for Keep, with the suffix',
      (folder: string) => unconfirmed(join(folder, 'setup.exe.unconfirmed')),
    ],
    [
      'a dangerous file the user kept, under its real name',
      (folder: string) => ({
        fileName: 'setup.exe',
        path: join(folder, 'setup.exe'),
        dangerous: true,
        confirmed: true,
      }),
    ],
    [
      'a file in another folder than the downloads folder',
      (folder: string) => ({ path: join(folder, '..', 'elsewhere', 'stored-1.txt') }),
    ],
    [
      'a file with spaces and accents in its name',
      (folder: string) => ({
        fileName: 'résumé (1).pdf',
        path: join(folder, 'résumé (1).pdf'),
      }),
    ],
    [
      'a file that is named for the suffix, but is not dangerous',
      (folder: string) => ({
        fileName: 'a.unconfirmed',
        path: join(folder, 'a.unconfirmed'),
      }),
    ],
    [
      'a file whose name starts with a dot',
      (folder: string) => ({ fileName: '.hidden', path: join(folder, '.hidden') }),
    ],
  ])('keeps %s', (_what, odd) => {
    const { folder, manager, store, stored } = setup();
    const row = stored({ n: 1, ...odd(folder) });

    manager.restore([row]);

    expect(manager.has(row.id)).toBe(true);
    expect(store.removed).toEqual([]);
  });

  it('drops only the rows that cannot be ours, and keeps the others in order', () => {
    const { folder, manager, store, stored } = setup();
    const rows = [
      stored({ n: 5 }),
      stored({ n: 4, path: 'relative/stored-4.txt' }),
      stored({ n: 3 }),
      stored({ n: 2, path: join(folder, 'someone-else.txt') }),
      stored({ n: 1 }),
    ];

    manager.restore(rows);

    expect(manager.list().map((view) => view.id)).toEqual([rows[0]?.id, rows[2]?.id, rows[4]?.id]);
    expect(store.removed).toEqual([rows[1]?.id, rows[3]?.id]);
  });

  it('does not let rows it drops take the room of rows it keeps', () => {
    const { folder, manager, store, stored } = setup();
    const odd = Array.from({ length: MAX_LISTED_DOWNLOADS }, (_, n) =>
      stored({ n: n + 1, path: 'relative/file.txt' }),
    );
    const good = Array.from({ length: MAX_LISTED_DOWNLOADS }, (_, n) =>
      stored({
        n: MAX_LISTED_DOWNLOADS + n + 1,
        path: join(folder, `stored-${String(MAX_LISTED_DOWNLOADS + n + 1)}.txt`),
        fileName: `stored-${String(MAX_LISTED_DOWNLOADS + n + 1)}.txt`,
      }),
    );

    manager.restore([...odd, ...good]);

    expect(manager.list()).toHaveLength(MAX_LISTED_DOWNLOADS);
    expect(store.removed).toEqual(odd.map((row) => row.id));
  });

  it('deletes the row of a dropped download once, however often it is listed', () => {
    const { manager, store, stored } = setup();
    const odd = stored({ n: 1, path: 'relative/stored-1.txt' });

    manager.restore([odd, odd, odd]);

    expect(store.removed).toEqual([odd.id]);
  });

  it('says nothing, and writes nothing else, when every row is dropped', () => {
    const { manager, onChange, store, stored } = setup();
    const rows = [stored({ n: 2, path: 'a' }), stored({ n: 1, path: 'b' })];

    manager.restore(rows);

    expect(manager.list()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(store.removed).toEqual([rows[0]?.id, rows[1]?.id]);
    expect(store.upserts).toEqual([]);
  });

  it('drops a row that was running as well, whatever its state', () => {
    const { manager, store, stored } = setup();
    const running = stored({ n: 1, state: 'progressing', path: 'relative/stored-1.txt' });
    const paused = stored({ n: 2, state: 'paused', path: 'relative/stored-2.txt' });

    manager.restore([running, paused]);

    expect(manager.list()).toEqual([]);
    // Dropped, not written back as interrupted.
    expect(store.upserts).toEqual([]);
    expect(store.removed).toEqual([running.id, paused.id]);
  });

  it('drops without a store, and without failing', () => {
    const { manager, stored } = setup({ store: false });

    expect(() => {
      manager.restore([stored({ n: 1, path: 'relative/stored-1.txt' }), stored({ n: 2 })]);
    }).not.toThrow();
    expect(manager.list()).toHaveLength(1);
  });

  it('keeps a download that started before the restore, whatever is dropped', () => {
    const { manager, start, stored, ids, store } = setup();
    start('running.bin');

    manager.restore([stored({ n: 1, path: 'relative/stored-1.txt' }), stored({ n: 2 })]);

    expect(manager.list().map((view) => view.id)).toEqual([ids[0], expect.any(String)]);
    expect(store.removed).toHaveLength(1);
  });
});
