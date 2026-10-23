import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FileLogger,
  HIDDEN,
  isAddressField,
  LOG_FILES,
  LOG_FILE_BYTES,
  redactAddresses,
  teeLogger,
} from './file-logger';

let folder: string;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

beforeEach(() => {
  folder = join(mkdtempSync(join(tmpdir(), 'veltriva-log-')), 'logs');
});

afterEach(() => {
  rmSync(join(folder, '..'), { recursive: true, force: true });
});

const lines = (name = 'veltriva.log'): Record<string, unknown>[] =>
  readFileSync(join(folder, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('FileLogger (M5.3, §6.6)', () => {
  it('writes one JSON line per event, with the time and the level, in <profile>/logs', () => {
    const logger = new FileLogger({ folder, includeAddresses: () => false, now: () => NOW });

    logger.warn('tab.printFailed', { reason: 'no printer', count: 2, ok: false });
    logger.error('data.openFailed');

    expect(lines()).toEqual([
      {
        at: '2026-10-23T12:00:00.000Z',
        level: 'warn',
        event: 'tab.printFailed',
        reason: 'no printer',
        count: 2,
        ok: false,
      },
      { at: '2026-10-23T12:00:00.000Z', level: 'error', event: 'data.openFailed' },
    ]);
    expect(logger.file).toBe(join(folder, 'veltriva.log'));
  });

  it('hides every address unless diagnostic logging is on, and writes it when it is', () => {
    const on = { value: false };
    const logger = new FileLogger({ folder, includeAddresses: () => on.value, now: () => NOW });

    logger.warn('tab.loadFailed', {
      url: 'https://secret.example/a',
      pageUrl: 'https://b.example/',
      code: -105,
    });
    on.value = true;
    logger.warn('tab.loadFailed', { url: 'https://secret.example/a', code: -105 });

    const [off, opted] = lines();
    expect(off).toMatchObject({ url: HIDDEN, pageUrl: HIDDEN, code: -105 });
    expect(JSON.stringify(off)).not.toContain('secret.example');
    expect(opted).toMatchObject({ url: 'https://secret.example/a', code: -105 });
  });

  it('hides addresses inside every other string field too, unless diagnostic logging is on (M6.1)', () => {
    const on = { value: false };
    const logger = new FileLogger({ folder, includeAddresses: () => on.value, now: () => NOW });
    const fields = {
      scheme: 'mailto',
      message: 'Failed to open mailto:alice@example.com',
      detail: "open 'file:///C:/Users/me/Downloads/report.pdf'",
      reason: 'redirected to https://secret.example/next?token=1',
      method: 'session.save',
      code: 'SQLITE_BUSY',
      tabId: 7,
    };

    logger.warn('external.launchFailed', fields);
    on.value = true;
    logger.warn('external.launchFailed', fields);

    const [off, opted] = lines();
    expect(off).toMatchObject({
      scheme: 'mailto',
      message: 'Failed to open [hidden]',
      detail: "open '[hidden]'",
      reason: 'redirected to [hidden]',
      method: 'session.save',
      code: 'SQLITE_BUSY',
      tabId: 7,
    });
    for (const secret of ['alice', 'example.com', 'report.pdf', 'secret.example', 'token']) {
      expect(JSON.stringify(off)).not.toContain(secret);
    }
    expect(opted).toMatchObject(fields);
  });

  it('knows which fields are addresses', () => {
    for (const name of ['url', 'address', 'pageUrl', 'requestUrl']) {
      expect(isAddressField(name)).toBe(true);
    }
    for (const name of ['code', 'reason', 'urlKind', 'tabId', 'scheme']) {
      expect(isAddressField(name)).toBe(false);
    }
  });

  it('keeps the time, level and event its own: a field cannot overwrite them', () => {
    const logger = new FileLogger({ folder, includeAddresses: () => false, now: () => NOW });

    logger.warn('real', { event: 'fake', level: 'error', at: 'then' });

    expect(lines()).toEqual([{ at: '2026-10-23T12:00:00.000Z', level: 'warn', event: 'real' }]);
  });

  it('rotates at 5 MB, keeping 5 files and dropping the oldest', () => {
    expect(LOG_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(LOG_FILES).toBe(5);
    const logger = new FileLogger({
      folder,
      includeAddresses: () => false,
      now: () => NOW,
      maxBytes: 200,
    });

    for (let n = 0; n < 40; n += 1) {
      logger.warn('event', { n });
    }

    expect(readdirSync(folder).sort()).toEqual([
      'veltriva.1.log',
      'veltriva.2.log',
      'veltriva.3.log',
      'veltriva.4.log',
      'veltriva.log',
    ]);
    // The newest is in veltriva.log; the oldest kept in .4, and earlier ones are gone.
    expect(lines().at(-1)).toMatchObject({ n: 39 });
    const oldest = lines('veltriva.4.log')[0]?.n as number;
    expect(oldest).toBeGreaterThan(0);
    for (const name of readdirSync(folder)) {
      expect(readFileSync(join(folder, name)).length).toBeLessThanOrEqual(200);
    }
  });

  it('continues a file from an earlier run, rotating when it is full', () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'veltriva.log'), `${'x'.repeat(190)}\n`);
    const logger = new FileLogger({
      folder,
      includeAddresses: () => false,
      now: () => NOW,
      maxBytes: 200,
    });

    logger.warn('after');

    expect(readFileSync(join(folder, 'veltriva.1.log'), 'utf8')).toContain('x'.repeat(190));
    expect(lines()).toEqual([{ at: '2026-10-23T12:00:00.000Z', level: 'warn', event: 'after' }]);
  });

  it('gives up quietly when it cannot write, and never throws into the app', () => {
    // A file where the folder should be.
    writeFileSync(join(folder, '..', 'blocked'), '');
    const logger = new FileLogger({
      folder: join(folder, '..', 'blocked', 'logs'),
      includeAddresses: () => false,
    });

    expect(() => {
      logger.warn('one');
      logger.error('two');
    }).not.toThrow();
  });
});

describe('teeLogger', () => {
  it('sends each event to every logger', () => {
    const a = { warn: vi.fn(), error: vi.fn() };
    const b = { warn: vi.fn(), error: vi.fn() };

    const logger = teeLogger(a, b);
    logger.warn('w', { x: 1 });
    logger.error('e');

    expect(a.warn).toHaveBeenCalledWith('w', { x: 1 });
    expect(b.warn).toHaveBeenCalledWith('w', { x: 1 });
    expect(a.error).toHaveBeenCalledWith('e', undefined);
    expect(b.error).toHaveBeenCalledWith('e', undefined);
  });
});

describe('redactAddresses', () => {
  it('hides address fields from another logger too, unless addresses are wanted', () => {
    const inner = { warn: vi.fn(), error: vi.fn() };
    const on = { value: false };
    const logger = redactAddresses(inner, () => on.value);

    logger.warn('tab.loadFailed', { url: 'https://secret.example/', code: -105 });
    on.value = true;
    logger.error('tab.loadFailed', { url: 'https://secret.example/', code: -105 });

    expect(inner.warn).toHaveBeenCalledWith('tab.loadFailed', { url: HIDDEN, code: -105 });
    expect(inner.error).toHaveBeenCalledWith('tab.loadFailed', {
      url: 'https://secret.example/',
      code: -105,
    });
  });

  it('hides addresses inside other string fields from another logger too (M6.1)', () => {
    const inner = { warn: vi.fn(), error: vi.fn() };
    const logger = redactAddresses(inner, () => false);

    logger.warn('external.launchFailed', {
      scheme: 'https',
      message: 'Failed to open https://secret.example/',
      missing: undefined,
    });

    expect(inner.warn).toHaveBeenCalledWith('external.launchFailed', {
      scheme: 'https',
      message: `Failed to open ${HIDDEN}`,
      missing: undefined,
    });
  });
});
