import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DownloadManager } from './download-manager';

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
  ) {
    super();
  }

  getFilename(): string {
    return this.name;
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

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'veltriva-downloads-'));
  folders.push(folder);
  const session = new EventEmitter();
  const opened: string[] = [];
  const shown: string[] = [];
  const onChange = vi.fn();
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
    logger: { warn: () => undefined, error: () => undefined },
  });
  manager.attach(session as never);
  const start = (name: string, initiator?: string): FakeItem => {
    const item = new FakeItem(name, initiator);
    session.emit('will-download', {}, item);
    return item;
  };
  return { folder, manager, start, opened, shown, onChange };
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
