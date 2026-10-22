import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { SiteRuleRow } from '../../shared/contracts/data-rpc';
import type { RepositoryHandlers } from '../handlers';

/**
 * The user's site rules (§5.3, M5.1): protect a site from automation, exclude it from the memory.
 * A site with neither rule has no row, so the table lists exactly what the settings page shows.
 * `history.recordVisit` reads `exclude_memory` itself (./history.ts), so a visit to an excluded
 * site is never written, whatever main knows.
 */
export function siteRuleHandlers(
  db: DatabaseConnection,
): Pick<RepositoryHandlers, 'siteRules.list' | 'siteRules.set'> {
  const list = db.prepare(
    `SELECT site, protect, exclude_memory AS excludeMemory, created_at AS createdAt
     FROM site_rules
     ORDER BY site
     LIMIT ?`,
  );
  // A rule that changes keeps the site's first created_at.
  const upsert = db.prepare(
    `INSERT INTO site_rules (site, protect, exclude_memory, created_at)
     VALUES (@site, @protect, @excludeMemory, @at)
     ON CONFLICT(site) DO UPDATE SET
       protect = excluded.protect,
       exclude_memory = excluded.exclude_memory`,
  );
  const remove = db.prepare('DELETE FROM site_rules WHERE site = ?');

  return {
    'siteRules.list': ({ limit }) => ({
      rules: (
        list.all([limit]) as {
          site: string;
          protect: number;
          excludeMemory: number;
          createdAt: number;
        }[]
      ).map((row): SiteRuleRow => ({
        site: row.site,
        protect: row.protect === 1,
        excludeMemory: row.excludeMemory === 1,
        createdAt: row.createdAt,
      })),
    }),
    'siteRules.set': ({ site, protect, excludeMemory, at }) => {
      if (!protect && !excludeMemory) {
        remove.run([site]);
      } else {
        upsert.run({ site, protect: protect ? 1 : 0, excludeMemory: excludeMemory ? 1 : 0, at });
      }
      return {};
    },
  };
}
