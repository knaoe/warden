ALTER TABLE service_accounts ADD COLUMN expires_at TEXT;
ALTER TABLE service_accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
