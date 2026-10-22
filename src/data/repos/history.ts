import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { frecencyAfterVisit } from '../../core/search/frecency';
import type { PageRow } from '../../shared/contracts/data-rpc';
import type { HandlerInput, RepositoryHandlers } from '../handlers';

const PAGE_COLUMNS = `id, url_key AS urlKey, url, host, site, title, favicon_id AS faviconId,
  first_visit_at AS firstVisitAt, last_visit_at AS lastVisitAt, visit_count AS visitCount,
  typed_count AS typedCount, frecency, frecency_at AS frecencyAt`;

interface StoredScore {
  readonly id: number;
  readonly frecency: number;
  readonly frecencyAt: number;
}

/**
 * The memory (§5.3, §5.5): a page per distinct key, a visit per navigation. Main has applied URL
 * hygiene already; this applies the one rule main can't see, a site excluded from the memory.
 */
export function historyHandlers(
  db: DatabaseConnection,
): Pick<
  RepositoryHandlers,
  'history.recordVisit' | 'history.updatePage' | 'history.pages' | 'history.page' | 'history.visits'
> {
  const excluded = db
    .prepare('SELECT 1 FROM site_rules WHERE site = ? AND exclude_memory = 1')
    .pluck();
  const findPage = db.prepare(
    'SELECT id, frecency, frecency_at AS frecencyAt FROM pages WHERE url_key = ?',
  );
  const insertPage = db.prepare(
    `INSERT INTO pages (
       url_key, url, host, site, title, first_visit_at, last_visit_at, visit_count, typed_count,
       frecency, frecency_at
     ) VALUES (
       @urlKey, @url, @host, @site, @title, @at, @at, @visits, @typed, @frecency, @at
     )`,
  );
  // The title a commit carries is often the previous page's, so a visit only fills an empty one;
  // the settled title arrives through history.updatePage. A clock that went back never moves the
  // times backwards.
  const updatePage = db.prepare(
    `UPDATE pages SET
       url = @url, host = @host, site = @site,
       title = CASE WHEN title = '' THEN @title ELSE title END,
       first_visit_at = min(first_visit_at, @at),
       last_visit_at = max(last_visit_at, @at),
       visit_count = visit_count + @visits,
       typed_count = typed_count + @typed,
       frecency = @frecency,
       frecency_at = max(frecency_at, @at)
     WHERE id = @id`,
  );
  const insertVisit = db.prepare(
    'INSERT INTO visits (page_id, tab_id, visited_at, transition) VALUES (?, ?, ?, ?)',
  );
  const setTitle = db.prepare('UPDATE pages SET title = ? WHERE id = ?');
  const setFavicon = db.prepare('UPDATE pages SET favicon_id = ? WHERE id = ?');
  const pages = db.prepare(
    `SELECT ${PAGE_COLUMNS} FROM pages ORDER BY last_visit_at DESC, id DESC LIMIT ?`,
  );
  const onePage = db.prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`);
  const visits = db.prepare(
    `SELECT id, visited_at AS visitedAt, transition, tab_id AS tabId FROM visits
     WHERE page_id = ? ORDER BY visited_at DESC, id DESC LIMIT ?`,
  );

  const recordVisit = db.transaction(
    ({ page, transition, visitedAt, tabId }: HandlerInput<'history.recordVisit'>) => {
      if (excluded.get([page.site]) !== undefined) {
        return { pageId: null };
      }
      // A redirect's hop is not a place the user went; it is kept as a visit, not counted.
      const visitsAdded = transition === 'redirect' ? 0 : 1;
      const typed = transition === 'typed' ? 1 : 0;
      const stored = findPage.get([page.urlKey]) as StoredScore | undefined;
      let pageId: number;
      if (stored === undefined) {
        const frecency = frecencyAfterVisit(0, visitedAt, visitedAt, transition);
        pageId = Number(
          insertPage.run({ ...page, at: visitedAt, visits: visitsAdded, typed, frecency })
            .lastInsertRowid,
        );
      } else {
        const frecency = frecencyAfterVisit(
          stored.frecency,
          stored.frecencyAt,
          visitedAt,
          transition,
        );
        updatePage.run({
          ...page,
          id: stored.id,
          at: visitedAt,
          visits: visitsAdded,
          typed,
          frecency,
        });
        pageId = stored.id;
      }
      insertVisit.run([pageId, tabId, visitedAt, transition]);
      return { pageId };
    },
  );

  const update = db.transaction(
    ({ pageId, title, faviconId }: HandlerInput<'history.updatePage'>) => {
      let count = 0;
      if (title !== undefined) {
        count = Math.max(count, setTitle.run([title, pageId]).changes);
      }
      if (faviconId !== undefined) {
        count = Math.max(count, setFavicon.run([faviconId, pageId]).changes);
      }
      return { count };
    },
  );

  return {
    'history.recordVisit': (input) => recordVisit(input),
    'history.updatePage': (input) => update(input),
    'history.pages': ({ limit }) => ({ pages: pages.all([limit]) as PageRow[] }),
    'history.page': ({ pageId }) => ({
      page: (onePage.get([pageId]) as PageRow | undefined) ?? null,
    }),
    'history.visits': ({ pageId, limit }) => ({
      visits: visits.all([pageId, limit]) as DataVisit[],
    }),
  };
}

type DataVisit = ReturnType<RepositoryHandlers['history.visits']>['visits'][number];
