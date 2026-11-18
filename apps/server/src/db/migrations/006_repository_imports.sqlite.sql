CREATE TABLE IF NOT EXISTS repository_imports (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  target_repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('path', 'https')),
  source_value TEXT NOT NULL,
  target_organization_id TEXT,
  target_owner_user_id TEXT,
  target_organization_slug TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  target_description TEXT NOT NULL DEFAULT '',
  source_default_branch TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  phase TEXT NOT NULL DEFAULT 'validating',
  total_commits INTEGER NOT NULL DEFAULT 0,
  imported_commits INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  imported_bytes INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS repository_imports_status_idx
  ON repository_imports (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS repository_imports_one_running
  ON repository_imports ((1)) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS repository_import_revisions (
  import_id TEXT NOT NULL REFERENCES repository_imports(id) ON DELETE CASCADE,
  git_sha TEXT NOT NULL,
  lore_revision TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (import_id, git_sha)
);

CREATE TABLE IF NOT EXISTS repository_import_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id TEXT NOT NULL REFERENCES repository_imports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  object_id TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS repository_import_warnings_import_idx
  ON repository_import_warnings (import_id, id);

CREATE TABLE IF NOT EXISTS repository_tags (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lore_revision TEXT NOT NULL,
  annotated INTEGER NOT NULL DEFAULT 0 CHECK (annotated IN (0, 1)),
  tagger TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repository_id, name)
);
