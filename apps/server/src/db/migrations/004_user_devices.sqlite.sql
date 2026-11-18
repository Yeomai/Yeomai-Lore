CREATE TABLE IF NOT EXISTS user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  last_ip TEXT NOT NULL DEFAULT '',
  auto_login INTEGER NOT NULL DEFAULT 0 CHECK (auto_login IN (0, 1)),
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  UNIQUE (user_id, device_key)
);
CREATE INDEX IF NOT EXISTS user_devices_user_idx
  ON user_devices (user_id, revoked_at);
CREATE INDEX IF NOT EXISTS user_devices_auto_login_idx
  ON user_devices (device_key, auto_login, revoked_at);

CREATE TABLE IF NOT EXISTS oauth_device_metadata (
  device_code_hash TEXT PRIMARY KEY
    REFERENCES oauth_device_codes(device_code_hash) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  request_ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS oauth_device_metadata_key_idx
  ON oauth_device_metadata (device_key);

CREATE TABLE IF NOT EXISTS oauth_refresh_devices (
  token_hash TEXT PRIMARY KEY
    REFERENCES oauth_refresh_tokens(token_hash) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS oauth_refresh_devices_device_idx
  ON oauth_refresh_devices (device_id);

PRAGMA user_version = 4;
