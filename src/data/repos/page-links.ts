// Which page of the memory a tab shows (`tabs.page_id`, assessment §5.3), so a search can say a
// result is open, Sleeping or archived (§5.4's state boost). Main sends tab rows with their exact
// address; the worker links each to the page its address is keyed by, as the history recorder
// keys visits (core/url/hygiene.ts). A tab on a page the memory never recorded (an excluded site,
// a new-tab page, an OAuth callback) has no page.
import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { historyUrl } from '../../core/url/hygiene';

/** The page id for a tab's address, or null when the memory has no page for it. */
export type PageOf = (url: string) => number | null;

export function pageLinker(db: DatabaseConnection): PageOf {
  const byKey = db.prepare('SELECT id FROM pages WHERE url_key = ?').pluck();
  return (url) => {
    const key = historyUrl(url)?.urlKey;
    if (key === undefined) {
      return null;
    }
    const id = byKey.get([key]);
    return typeof id === 'number' ? id : null;
  };
}

/** Tabs looked at per statement, when linking rows saved before tabs had pages (M4.1). */
export const LINK_CHUNK = 500;

export interface LinkChunk {
  /** The last tab id looked at, to continue after; null when there are no more. */
  readonly last: string | null;
  readonly linked: number;
}

/**
 * Links tabs saved without a page, in id order after `after`, at most LINK_CHUNK of them, in one
 * transaction. Closed tabs are left alone: a search never shows them.
 */
export function tabLinker(db: DatabaseConnection): (after: string) => LinkChunk {
  const pageOf = pageLinker(db);
  const unlinked = db.prepare(
    `SELECT id, url FROM tabs
     WHERE page_id IS NULL AND placement <> 'closed' AND id > ?
     ORDER BY id LIMIT ?`,
  );
  const link = db.prepare('UPDATE tabs SET page_id = ? WHERE id = ? AND page_id IS NULL');
  const linkRows = db.transaction((rows: readonly { id: string; url: string }[]): number => {
    let linked = 0;
    for (const row of rows) {
      const pageId = pageOf(row.url);
      if (pageId !== null) {
        linked += link.run([pageId, row.id]).changes;
      }
    }
    return linked;
  });
  return (after) => {
    const rows = unlinked.all([after, LINK_CHUNK]) as { id: string; url: string }[];
    const linked = rows.length === 0 ? 0 : linkRows(rows);
    return { last: rows.length < LINK_CHUNK ? null : (rows.at(-1)?.id ?? null), linked };
  };
}
