/** Run with `.get()`: these return a row. */
export const PRAGMAS = ['PRAGMA journal_mode = WAL', 'PRAGMA foreign_keys = ON'] as const

/** Run with `.run()`. */
export const TABLES = [
  `CREATE TABLE IF NOT EXISTS recordings (
     share_key      TEXT PRIMARY KEY,
     recording_id   TEXT NOT NULL,
     title          TEXT NOT NULL DEFAULT '',
     created_at     TEXT NOT NULL,
     duration       REAL,
     width          INTEGER,
     height         INTEGER,
     content_type   TEXT NOT NULL DEFAULT 'video/webm',
     status         TEXT NOT NULL,
     upload_offset  INTEGER NOT NULL DEFAULT 0,
     upload_length  INTEGER,
     password_hash  TEXT,
     password_salt  TEXT,
     expires_at     TEXT,
     allow_download INTEGER NOT NULL DEFAULT 1,
     views          INTEGER NOT NULL DEFAULT 0,
     watches        INTEGER NOT NULL DEFAULT 0
   )`,

  // One row per (recording, viewer-day); see viewFingerprint.
  `CREATE TABLE IF NOT EXISTS view_marks (
     share_key   TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     day         TEXT NOT NULL,
     watched     INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (share_key, fingerprint),
     FOREIGN KEY (share_key) REFERENCES recordings(share_key) ON DELETE CASCADE
   )`,

  `CREATE INDEX IF NOT EXISTS view_marks_day ON view_marks(day)`,
] as const
