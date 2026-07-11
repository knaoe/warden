CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 100,
  owner TEXT,
  owner_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  blocked_reason TEXT,
  next_action TEXT,
  needs_you INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
