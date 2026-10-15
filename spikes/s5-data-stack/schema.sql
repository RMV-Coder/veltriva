-- Connection pragmas, set by the data worker on open (not stored in this file):
--   journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000;
--   secure_delete=ON; temp_store=MEMORY
-- On a brand-new database the runner first sets: PRAGMA auto_vacuum = INCREMENTAL;

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

CREATE TABLE permission_decisions (
  origin      TEXT    NOT NULL,                       -- scheme://host:port
  permission  TEXT    NOT NULL,                       -- 'media', 'geolocation', 'protocol:zoommtg', …
  decision    TEXT    NOT NULL CHECK (decision IN ('allow','deny')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (origin, permission)
) STRICT, WITHOUT ROWID;

CREATE TABLE settings (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  json  TEXT    NOT NULL CHECK (json_valid(json))     -- parsed by Zod; missing keys take defaults
) STRICT;

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
