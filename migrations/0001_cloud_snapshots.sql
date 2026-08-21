CREATE TABLE IF NOT EXISTS cloud_snapshots (
  account_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
