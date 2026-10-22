-- Migration 3 (M5.1): the user's site rules live in the site_rules table (assessment §5.3).
-- M3.4 kept the sites the user protects in the settings document (`lifecycle.protectedSites`). The
-- settings page (M5.1) adds excluding a site from the memory, which the table already has a column
-- for, so both rules now live in one place: every site in that list becomes a row with
-- protect = 1 (a row the site already has keeps its exclude_memory), and the list leaves the
-- document.
--
-- Only what the document's schema accepted is copied: an array's text entries of 1 to 253
-- characters, the first 1,000 of them. Sites were written lower case (core/url/site.ts siteOf);
-- lower() keeps a hand-edited entry from making a second row.
-- The upsert's SELECT has a WHERE clause, which SQLite needs to tell ON CONFLICT from a join.

INSERT INTO site_rules (site, protect, exclude_memory, created_at)
SELECT DISTINCT lower(entry.value), 1, 0,
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM settings, json_each(settings.json, '$.lifecycle.protectedSites') AS entry
WHERE json_type(settings.json, '$.lifecycle.protectedSites') = 'array'
  AND entry.type = 'text'
  AND length(entry.value) BETWEEN 1 AND 253
  AND entry.key < 1000
ON CONFLICT(site) DO UPDATE SET protect = 1;

UPDATE settings SET json = json_remove(json, '$.lifecycle.protectedSites')
WHERE json_type(json, '$.lifecycle.protectedSites') IS NOT NULL;
