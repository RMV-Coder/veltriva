import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { frecencyAfterVisit } from '../../core/search/frecency';
import type { VisitTransition } from '../../core/search/frecency';
import { siteOf } from '../../core/url/site';
import type { ForgetCounts } from '../../shared/contracts/data-rpc';
import type { HandlerInput, RepositoryHandlers } from '../handlers';

/** At most this many origins come back for a forgotten site: more than any site uses. */
export const MAX_FORGOTTEN_ORIGINS = 100;

/**
 * Clearing data (assessment §5.7, M5.2): one entry, a site, or everything since a time. Each
 * request is one transaction: the pages go with their visits (ON DELETE CASCADE), the FTS triggers
 * remove their index entries, and `secure_delete` plus FTS5's `secure-delete` overwrite the freed
 * content in the pages SQLite writes. Then, once it has committed, every free page is vacuumed and
 * the WAL checkpointed and truncated, so the files shrink and what was deleted is in neither.
 *
 * Main has already dropped the archived and recently closed tabs it holds in memory, so the
 * session store won't write them again; their rows go here, and so do those only the database held.
 */
export function forgetHandlers(db: DatabaseConnection): Pick<RepositoryHandlers, 'memory.forget'> {
  const deletePage = db.prepare('DELETE FROM pages WHERE id = ?');
  const deleteTab = db.prepare(
    "DELETE FROM tabs WHERE id = ? AND placement IN ('archive', 'closed')",
  );
  const pagesOfSite = db.prepare('SELECT id FROM pages WHERE site = ?').pluck();
  const visitsOfPages = db
    .prepare('SELECT count(*) FROM visits WHERE page_id IN (SELECT value FROM json_each(?))')
    .pluck();
  const urlsOfSite = db.prepare('SELECT url FROM pages WHERE site = ?').pluck();
  const recordedTabs = db.prepare(
    "SELECT id, url FROM tabs WHERE placement IN ('archive', 'closed')",
  );
  const visitedPagesSince = db
    .prepare('SELECT DISTINCT page_id FROM visits WHERE visited_at >= ?')
    .pluck();
  const deleteVisitsSince = db.prepare('DELETE FROM visits WHERE visited_at >= ?');
  const visitsOf = db.prepare(
    'SELECT visited_at AS at, transition FROM visits WHERE page_id = ? ORDER BY visited_at, id',
  );
  const restat = db.prepare(
    `UPDATE pages SET first_visit_at = @first, last_visit_at = @last, visit_count = @visits,
       typed_count = @typed, frecency = @frecency, frecency_at = @frecencyAt
     WHERE id = @id`,
  );
  const deleteTabsSince = db.prepare(
    `DELETE FROM tabs WHERE (placement = 'archive' AND archived_at >= @since)
       OR (placement = 'closed' AND closed_at >= @since)`,
  );
  const deleteAllVisits = db.prepare('DELETE FROM visits');
  const deleteAllPages = db.prepare('DELETE FROM pages');
  const orphanFavicons = db.prepare(
    `DELETE FROM favicons WHERE id IN (
       SELECT id FROM favicons f
       WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.favicon_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM tabs t WHERE t.favicon_id = f.id)
     )`,
  );

  /** Pages and their visits; the visits are counted first, since the cascade won't say. */
  const removePages = (ids: readonly number[]): { pages: number; visits: number } => {
    if (ids.length === 0) {
      return { pages: 0, visits: 0 };
    }
    const visits = visitsOfPages.get([JSON.stringify(ids)]) as number;
    let pages = 0;
    for (const id of ids) {
      pages += deletePage.run([id]).changes;
    }
    return { pages, visits };
  };

  /** A page that kept some visits: its counts, times and frecency as if the others never were. */
  const recount = (pageId: number): void => {
    const visits = visitsOf.all([pageId]) as { at: number; transition: VisitTransition }[];
    const first = visits[0];
    if (first === undefined) {
      return;
    }
    let frecency = 0;
    let frecencyAt = first.at;
    for (const visit of visits) {
      frecency = frecencyAfterVisit(frecency, frecencyAt, visit.at, visit.transition);
      frecencyAt = visit.at;
    }
    restat.run({
      id: pageId,
      first: first.at,
      last: frecencyAt,
      // As history.recordVisit counts them: a redirect's hop is kept, not counted.
      visits: visits.filter((visit) => visit.transition !== 'redirect').length,
      typed: visits.filter((visit) => visit.transition === 'typed').length,
      frecency,
      frecencyAt,
    });
  };

  const run = db.transaction((request: HandlerInput<'memory.forget'>): ForgetCounts => {
    let pages = 0;
    let visits = 0;
    let tabs = 0;
    /** For a site: the origins of what went, so main can clear their storage too. */
    const origins = new Set<string>();
    const noteOrigin = (url: string): void => {
      try {
        const { origin } = new URL(url);
        if (origin !== 'null' && origins.size < MAX_FORGOTTEN_ORIGINS) {
          origins.add(origin);
        }
      } catch {
        // Not an address: nothing to clear for it.
      }
    };
    switch (request.scope) {
      case 'pages': {
        ({ pages, visits } = removePages(request.pageIds));
        for (const id of request.tabIds) {
          tabs += deleteTab.run([id]).changes;
        }
        break;
      }
      case 'site': {
        for (const url of urlsOfSite.all([request.site]) as string[]) {
          noteOrigin(url);
        }
        ({ pages, visits } = removePages(pagesOfSite.all([request.site]) as number[]));
        for (const row of recordedTabs.all() as { id: string; url: string }[]) {
          if (siteOf(row.url) === request.site) {
            noteOrigin(row.url);
            tabs += deleteTab.run([row.id]).changes;
          }
        }
        break;
      }
      case 'since': {
        if (request.memory) {
          if (request.since === 0) {
            visits = deleteAllVisits.run().changes;
            pages = deleteAllPages.run().changes;
          } else {
            const touched = visitedPagesSince.all([request.since]) as number[];
            visits = deleteVisitsSince.run([request.since]).changes;
            const empty: number[] = [];
            for (const id of touched) {
              if (visitsOf.all([id]).length === 0) {
                empty.push(id);
              } else {
                recount(id);
              }
            }
            pages = removePages(empty).pages;
          }
        }
        if (request.tabs) {
          tabs = deleteTabsSince.run({ since: request.since }).changes;
        }
        break;
      }
    }
    const favicons = orphanFavicons.run().changes;
    return { pages, visits, tabs, favicons, origins: [...origins].sort() };
  });

  return {
    'memory.forget': (request) => {
      const counts = run(request);
      // After the commit: give the free pages back, then fold the WAL into the file and empty it
      // (in this order: the vacuum writes to the WAL too), so the deleted content is in neither
      // file and both shrink.
      db.pragma('incremental_vacuum');
      db.pragma('wal_checkpoint(TRUNCATE)');
      return counts;
    },
  };
}
