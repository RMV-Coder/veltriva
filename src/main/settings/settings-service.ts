// The settings document in main (M5.1): the one copy, and the only writer. The settings page sends
// a change (already checked against the strict change schema by the IPC router); this applies it
// and checks the document it makes (applySettingsChange), keeps it only if valid, writes it to the
// data worker whole, and tells main what changed so it applies it at once: the search template,
// automation's settings, the pressure thresholds and Pause memory. A rejected change leaves
// everything as it was. A failed write is logged by code; the change still holds for the run.
import type { DataInput } from '../../shared/contracts/data-rpc';
import { applySettingsChange } from '../../shared/contracts/settings';
import type {
  LifecycleSettingsDocument,
  Settings,
  SettingsChange,
} from '../../shared/contracts/settings';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';

/** The change would make an invalid document: nothing of it was kept. */
export class SettingsRejected extends Error {
  constructor() {
    super('settings rejected');
    this.name = 'SettingsRejected';
  }
}

export interface SettingsServiceOptions {
  readonly initial: Settings;
  /** Null without a database: changes then hold for the run only. */
  readonly data: Pick<DataClient, 'call'> | null;
  readonly logger: Logger;
  /** After every change kept, with the document before it. */
  readonly onChange?: (next: Settings, previous: Settings) => void;
}

export class SettingsService {
  readonly #options: SettingsServiceOptions;
  #settings: Settings;

  constructor(options: SettingsServiceOptions) {
    this.#options = options;
    this.#settings = options.initial;
  }

  current(): Settings {
    return this.#settings;
  }

  /** Applies a change from the settings page. Throws SettingsRejected, changing nothing. */
  update(change: SettingsChange): Settings {
    const next = applySettingsChange(this.#settings, change);
    if (next === null) {
      throw new SettingsRejected();
    }
    this.#keep(next);
    return next;
  }

  /** Main's own changes to the lifecycle section: Pause automation, preview mode. */
  setLifecycle(next: LifecycleSettingsDocument): void {
    this.#keep({ ...this.#settings, lifecycle: next });
  }

  #keep(next: Settings): void {
    const previous = this.#settings;
    this.#settings = next;
    // A plain JSON copy: the document the worker stores.
    const value = JSON.parse(JSON.stringify(next)) as DataInput<'settings.set'>['value'];
    this.#options.data?.call('settings.set', { value }).catch(() => {
      this.#options.logger.warn('settings.writeFailed');
    });
    this.#options.onChange?.(next, previous);
  }
}
