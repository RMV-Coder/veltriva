// Notices about Veltriva itself, not about a page: the shell shows each in a strip until the user
// dismisses it. M2.1b's are about the database's recovery (assessment §5.6: "a banner explains
// what happened"); M2.2a adds "Veltriva recovered your session". Main owns them (ADR-0005): the
// shell only shows the list and sends back a dismissal by id.

export type AppNotice =
  /** The database was damaged and replaced by a backup taken at `backupAt`. */
  | {
      readonly id: string;
      readonly kind: 'database-restored';
      readonly backupAt: number;
      readonly corruptFile: string;
    }
  /** The database was damaged and no backup was usable: Veltriva started with an empty one. */
  | { readonly id: string; readonly kind: 'database-reset'; readonly corruptFile: string }
  /** The last run ended without closing; its tabs are back (M2.2a, assessment §5.9). */
  | { readonly id: string; readonly kind: 'session-recovered' }
  /** Two quick crashes in a row: the tabs are back, but none loaded (§5.9's safe mode). */
  | { readonly id: string; readonly kind: 'safe-mode' }
  /**
   * The update check found a newer version (M6.3). Its release page stays in main
   * (UpdateChecker), so the shell's "View release" names no address.
   */
  | { readonly id: string; readonly kind: 'update-available'; readonly version: string };

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type NewAppNotice = WithoutId<AppNotice>;

/** More would only push the page down; the oldest one goes first. */
export const MAX_NOTICES = 3;

export class AppNotices {
  #notices: readonly AppNotice[] = [];
  #nextId = 1;
  readonly #listeners = new Set<() => void>();

  list(): readonly AppNotice[] {
    return this.#notices;
  }

  show(notice: NewAppNotice): string {
    const id = `notice-${String(this.#nextId++)}`;
    this.#notices = [...this.#notices, { ...notice, id } as AppNotice].slice(-MAX_NOTICES);
    this.#changed();
    return id;
  }

  /** False for an id that isn't shown (already dismissed, or never existed). */
  dismiss(id: string): boolean {
    const remaining = this.#notices.filter((notice) => notice.id !== id);
    if (remaining.length === this.#notices.length) {
      return false;
    }
    this.#notices = remaining;
    this.#changed();
    return true;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
