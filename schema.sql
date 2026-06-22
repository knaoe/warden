CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',     -- queued|running|blocked|needs_you|verifying|done
  priority INTEGER NOT NULL DEFAULT 100,
  owner TEXT,
  owner_epoch INTEGER NOT NULL DEFAULT 0,    -- fencing token (monotonic per logical owner)
  lease_until TEXT,
  blocked_reason TEXT,
  next_action TEXT,
  needs_you INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wi_state ON work_items(state, priority);
CREATE INDEX IF NOT EXISTS idx_wi_project ON work_items(project);

-- Service accounts: each caller (PMO front-door, per-project PMs, ...) has a
-- software ed25519 key; warden stores only the public key. Requests are signed
-- (see src/auth.js). Revoke by setting disabled=1.
CREATE TABLE IF NOT EXISTS service_accounts (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,                       -- base64 of the raw 32-byte ed25519 public key
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
