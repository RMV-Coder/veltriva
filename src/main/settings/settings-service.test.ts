import { describe, expect, it, vi } from 'vitest';

import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type { DataMethod } from '../../shared/contracts/data-rpc';
import {
  DEFAULT_LIFECYCLE_DOCUMENT,
  DEFAULT_SETTINGS,
  settingsChangeSchema,
} from '../../shared/contracts/settings';
import type { Settings } from '../../shared/contracts/settings';
import { SettingsRejected, SettingsService } from './settings-service';

function setup(initial: Settings = DEFAULT_SETTINGS, failWrites = false) {
  const writes: unknown[] = [];
  const call = vi.fn((method: DataMethod, input: unknown) => {
    // Like the real client: input its method's schema refuses never goes out.
    DATA_METHODS[method].input.parse(input);
    writes.push((input as { value: unknown }).value);
    return failWrites ? Promise.reject(new Error('full')) : Promise.resolve({});
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  const changes: { next: Settings; previous: Settings }[] = [];
  const service = new SettingsService({
    initial,
    data: { call: call as never },
    logger,
    onChange: (next, previous) => {
      changes.push({ next, previous });
    },
  });
  return { service, writes, logger, changes, call };
}

/** A change as the IPC router hands it on: it has passed the strict change schema. */
const change = (value: unknown) => settingsChangeSchema.parse(value);

describe('SettingsService (M5.1)', () => {
  it('starts with the document it was given', () => {
    const { service } = setup({ ...DEFAULT_SETTINGS, startup: 'new-tab' });
    expect(service.current().startup).toBe('new-tab');
  });

  it('keeps a valid change, writes the whole document, and says what changed', async () => {
    const { service, writes, changes } = setup();

    const next = service.update(
      change({ memory: { paused: true }, lifecycle: { preset: 'gentle' } }),
    );
    await Promise.resolve();

    const expected: Settings = {
      ...DEFAULT_SETTINGS,
      memory: { paused: true },
      lifecycle: { ...DEFAULT_LIFECYCLE_DOCUMENT, preset: 'gentle' },
    };
    expect(next).toEqual(expected);
    expect(service.current()).toEqual(expected);
    expect(writes).toEqual([expected]);
    expect(changes).toEqual([{ next: expected, previous: DEFAULT_SETTINGS }]);
  });

  it('applies changes one after the other', () => {
    const { service, writes } = setup();
    service.update(change({ lifecycle: { overrides: { stripCap: 7 } } }));
    service.update(change({ lifecycle: { overrides: { discardPinned: true } } }));

    expect(service.current().lifecycle.overrides).toEqual({ stripCap: 7, discardPinned: true });
    expect(writes).toHaveLength(2);
  });

  describe('a change that makes an invalid document', () => {
    it('is rejected, and nothing is kept, written or announced', () => {
      const { service, writes, changes } = setup();

      expect(() =>
        service.update(change({ lifecycle: { overrides: { criticalPressurePercent: 12 } } })),
      ).toThrow(SettingsRejected);

      expect(service.current()).toEqual(DEFAULT_SETTINGS);
      expect(writes).toEqual([]);
      expect(changes).toEqual([]);
    });

    it('is rejected whole: its valid parts are not kept either', () => {
      const { service } = setup();

      expect(() =>
        service.update(
          change({
            startup: 'new-tab',
            lifecycle: { preset: 'aggressive', overrides: { moderatePressurePercent: 3 } },
          }),
        ),
      ).toThrow(SettingsRejected);

      expect(service.current()).toEqual(DEFAULT_SETTINGS);
    });

    it('leaves a later valid change working', () => {
      const { service } = setup();
      expect(() =>
        service.update(change({ lifecycle: { overrides: { criticalPressurePercent: 10 } } })),
      ).toThrow(SettingsRejected);

      service.update(change({ lifecycle: { overrides: { criticalPressurePercent: 9 } } }));

      expect(service.current().lifecycle.overrides).toEqual({ criticalPressurePercent: 9 });
    });
  });

  it("sets main's own lifecycle changes, written like any other", () => {
    const { service, writes, changes } = setup();

    service.setLifecycle({ ...DEFAULT_LIFECYCLE_DOCUMENT, paused: true });

    expect(service.current().lifecycle.paused).toBe(true);
    expect(writes).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });

  it('logs a failed write by code, and the change still holds for the run', async () => {
    const { service, logger } = setup(DEFAULT_SETTINGS, true);

    service.update(change({ startup: 'new-tab' }));
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith('settings.writeFailed');
    });

    expect(service.current().startup).toBe('new-tab');
  });

  it('works without a database, keeping changes for the run', () => {
    const service = new SettingsService({
      initial: DEFAULT_SETTINGS,
      data: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    service.update(change({ memory: { paused: true } }));

    expect(service.current().memory.paused).toBe(true);
  });
});
