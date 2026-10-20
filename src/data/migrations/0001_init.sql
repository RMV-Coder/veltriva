-- Migration 1: the initial schema. This is assessment §5.3, verbatim, plus the Phase 2 amendments
-- marked "Amendment (a)" to "(d)" below (recorded in ADR-0004 item 7 and assessment §5.3).
-- Never edit this file once released: a schema change is a new numbered migration.
--
-- Connection pragmas, set by the data worker on open (not stored in this file):
--   journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000;
--   secure_delete=ON; temp_store=MEMORY; cache_size=-16000 (16 MB; S5)
-- On a brand-new database the runner sets PRAGMA auto_vacuum = INCREMENTAL *before*
-- journal_mode=WAL; in the other order it silently stays off (S5).
-- The runner wraps this file in BEGIN IMMEDIATE … COMMIT and sets user_version = 1 inside it.

CREATE TABLE workspaces (
  id          TEXT    PRIMARY KEY,                    -- UUIDv7 (MVP: one default row)
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE favicons (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT    NOT NULL UNIQUE,                -- of the normalized PNG
  png         BLOB    NOT NULL,                       -- re-encoded, ≤ 64×64, size-capped
  updated_at  INTEGER NOT NULL
) STRICT;

-- Memory: one row per distinct normalized URL.
CREATE TABLE pages (
  id              INTEGER PRIMARY KEY,
  url_key         TEXT    NOT NULL UNIQUE,            -- identity: normalized, tracking params removed
  url             TEXT    NOT NULL,                   -- display/search form, secrets stripped (§5.7)
  host            TEXT    NOT NULL,
  site            TEXT    NOT NULL,                   -- registrable domain (eTLD+1)
  title           TEXT    NOT NULL DEFAULT '',
  favicon_id      INTEGER REFERENCES favicons(id) ON DELETE SET NULL,
  first_visit_at  INTEGER NOT NULL,
  last_visit_at   INTEGER NOT NULL,
  visit_count     INTEGER NOT NULL DEFAULT 0,
  typed_count     INTEGER NOT NULL DEFAULT 0,
  frecency        REAL    NOT NULL DEFAULT 0,         -- decayed score as of frecency_at (§5.4)
  frecency_at     INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX pages_site_idx       ON pages(site);
CREATE INDEX pages_last_visit_idx ON pages(last_visit_at DESC);
-- Recent-and-frequent listing (empty query). The decayed score f·2^(−(now−f_at)/H) orders exactly
-- like log2(f) + f_at/H, because the shared "now" term cancels; H = 30 days in ms (S5: 0.4 ms vs a 29–45 ms scan).
CREATE INDEX pages_frecency_idx   ON pages((log2(frecency) + frecency_at / 2592000000.0));

CREATE TABLE visits (
  id          INTEGER PRIMARY KEY,
  page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tab_id      TEXT,                                   -- soft reference: visits outlive tabs
  visited_at  INTEGER NOT NULL,
  transition  TEXT    NOT NULL CHECK (transition IN
               ('link','typed','reload','back_forward','redirect','restore','generated','other'))
) STRICT;
CREATE INDEX visits_page_time_idx ON visits(page_id, visited_at DESC);
CREATE INDEX visits_time_idx      ON visits(visited_at DESC);

-- Workspace objects: every tab the user owns, wherever it currently lives.
CREATE TABLE tabs (
  id                    TEXT    PRIMARY KEY,          -- UUIDv7 minted in main
  workspace_id          TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  placement             TEXT    NOT NULL CHECK (placement IN ('strip','shelf','archive','closed')),
  position              INTEGER NOT NULL DEFAULT 0,   -- order within (workspace, placement)
  pinned                INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  user_protected        INTEGER NOT NULL DEFAULT 0 CHECK (user_protected IN (0,1)),
  page_id               INTEGER REFERENCES pages(id) ON DELETE SET NULL,  -- current entry, for search
  url                   TEXT    NOT NULL,             -- exact current URL (needed to restore)
  title                 TEXT    NOT NULL DEFAULT '',
  favicon_id            INTEGER REFERENCES favicons(id) ON DELETE SET NULL,
  restore_state         TEXT,                         -- JSON {v, index, entries:[{url,title}]}, ≤ 50 entries
  opener_tab_id         TEXT,                         -- soft reference
  created_at            INTEGER NOT NULL,
  last_used_at          INTEGER NOT NULL,             -- wall clock
  last_used_engaged     INTEGER NOT NULL,             -- engagement-clock value (§4.6)
  last_used_active_day  INTEGER NOT NULL,             -- active-day index (§4.6)
  placement_changed_at  INTEGER NOT NULL,
  archived_at           INTEGER,
  archive_reason        TEXT    CHECK (archive_reason IN ('auto','manual')),
  closed_at             INTEGER,
  CHECK (placement <> 'archive' OR archived_at IS NOT NULL),
  CHECK (placement <> 'closed'  OR closed_at   IS NOT NULL),
  CHECK (pinned = 0 OR placement = 'strip'),
  CHECK (restore_state IS NULL OR json_valid(restore_state))
) STRICT;
CREATE INDEX tabs_layout_idx   ON tabs(workspace_id, placement, position);
CREATE INDEX tabs_archived_idx ON tabs(archived_at DESC) WHERE placement = 'archive';
CREATE INDEX tabs_closed_idx   ON tabs(closed_at)        WHERE placement = 'closed';
CREATE INDEX tabs_page_idx     ON tabs(page_id);

CREATE TABLE site_rules (
  site            TEXT    PRIMARY KEY,                -- registrable domain
  protect         INTEGER NOT NULL DEFAULT 0 CHECK (protect IN (0,1)),         -- no automation
  exclude_memory  INTEGER NOT NULL DEFAULT 0 CHECK (exclude_memory IN (0,1)),  -- never recorded
  created_at      INTEGER NOT NULL
) STRICT;

-- Amendment (a): `decision` is 'allow' or 'block', the code's Decision type
-- (src/core/permissions/permission-policy.ts), not §5.3's 'allow' or 'deny'.
-- Amendment (b): an external-protocol "always allow" is a row with permission 'protocol:<scheme>'
-- and `origin` the site's origin that asked (the protocol guard's key); its decision is 'allow'.
CREATE TABLE permission_decisions (
  origin      TEXT    NOT NULL,                       -- scheme://host:port
  permission  TEXT    NOT NULL,                       -- 'media', 'geolocation', 'protocol:zoommtg', …
  decision    TEXT    NOT NULL CHECK (decision IN ('allow','block')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (origin, permission)
) STRICT, WITHOUT ROWID;

-- Amendment (c): download history (the user's Phase 2 decision). A row per download main
-- started, newest first in the panel. No page content and no response headers.
CREATE TABLE downloads (
  id              TEXT    PRIMARY KEY,                -- UUIDv7 minted in main
  file_name       TEXT    NOT NULL,                   -- the name it has, or will have once kept
  path            TEXT    NOT NULL,                   -- where it is on disk now
  url             TEXT    NOT NULL,                   -- where it came from, secrets stripped (§5.7)
  site            TEXT    NOT NULL DEFAULT '',        -- the page that started it; '' when Veltriva did
  state           TEXT    NOT NULL CHECK (state IN
                   ('progressing','paused','completed','cancelled','interrupted')),
  dangerous       INTEGER NOT NULL CHECK (dangerous IN (0,1)),
  confirmed       INTEGER NOT NULL CHECK (confirmed IN (0,1)),  -- a dangerous file the user kept
  received_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  total_bytes     INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),     -- 0: the server didn't say
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  CHECK (dangerous = 1 OR confirmed = 1),             -- only a dangerous file waits for Keep
  CHECK ((state IN ('progressing','paused')) = (ended_at IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
) STRICT;
CREATE INDEX downloads_started_idx ON downloads(started_at DESC);

CREATE TABLE settings (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  json  TEXT    NOT NULL CHECK (json_valid(json))     -- parsed by Zod; missing keys take defaults
) STRICT;

-- Amendment (d): the client-hint opt-ins (an origin's Accept-CH) are the app_state document
-- 'client_hints'; no table of their own.
CREATE TABLE app_state (                              -- small documents: session, clocks, window
  key   TEXT PRIMARY KEY,
  json  TEXT NOT NULL CHECK (json_valid(json))
) STRICT, WITHOUT ROWID;

CREATE TABLE app_runs (                               -- crash detection and diagnostics
  id                 INTEGER PRIMARY KEY,
  started_at         INTEGER NOT NULL,
  last_heartbeat_at  INTEGER NOT NULL,
  ended_at           INTEGER,
  exit_kind          TEXT    CHECK (exit_kind IN ('clean','crash')),
  app_version        TEXT    NOT NULL
) STRICT;

-- Full-text index over memory. External content: the text lives once, in `pages`.
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title, url, site,
  content = 'pages', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 1);  -- deleted terms really disappear

CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, url, site) VALUES (new.id, new.title, new.url, new.site);
END;
CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, url, site)
  VALUES ('delete', old.id, old.title, old.url, old.site);
END;
-- Only text changes re-index; frequent visit_count/frecency updates do not.
CREATE TRIGGER pages_fts_au AFTER UPDATE OF title, url, site ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, url, site)
  VALUES ('delete', old.id, old.title, old.url, old.site);
  INSERT INTO pages_fts(rowid, title, url, site) VALUES (new.id, new.title, new.url, new.site);
END;
