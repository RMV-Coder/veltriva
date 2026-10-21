-- Migration 2 (M2.2b): a favicon is kept as the bytes the favicon service validated, with their
-- type, never decoded or re-encoded in main (threat T5: decoding a server's image belongs in the
-- sandboxed shell renderer). 0001 called the column `png`, for a re-encoded PNG main never got
-- to write; no build stored a favicon before this migration, but a row that exists keeps its
-- bytes and is taken for a PNG.
--
-- The bytes are a raster image identified by its magic number (core/net/favicon-format.ts), at
-- most 64 KiB, checked in main and again by the data worker. `sha256` is of those bytes. The
-- 64×64 limit of §5.3 became the shell's: it scales the image when it draws it.
--
-- Two ALTER TABLEs and no rebuild: dropping the old table would run its ON DELETE SET NULL
-- actions and take every page's and tab's icon with it.

ALTER TABLE favicons RENAME COLUMN png TO bytes;

ALTER TABLE favicons ADD COLUMN mime TEXT NOT NULL DEFAULT 'image/png'
  CHECK (mime IN ('image/png','image/x-icon','image/gif','image/jpeg','image/webp','image/bmp'));
