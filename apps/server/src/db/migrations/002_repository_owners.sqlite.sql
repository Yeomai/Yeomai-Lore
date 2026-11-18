PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;

CREATE TABLE repositories_new (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  owner_user_id TEXT REFERENCES users(id),
  slug TEXT NOT NULL,
  lore_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  default_branch_id TEXT NOT NULL,
  default_branch_name TEXT NOT NULL DEFAULT 'main',
  created_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((organization_id IS NULL) <> (owner_user_id IS NULL))
);

INSERT INTO repositories_new
  (id, organization_id, owner_user_id, slug, lore_name, description,
   default_branch_id, default_branch_name, created_by, status, created_at, updated_at)
SELECT id, organization_id, NULL, slug, lore_name, description,
       default_branch_id, default_branch_name, created_by, status, created_at, updated_at
  FROM repositories;

DROP TABLE repositories;
ALTER TABLE repositories_new RENAME TO repositories;

CREATE INDEX repositories_org_idx ON repositories (organization_id);
CREATE INDEX repositories_owner_idx ON repositories (owner_user_id);
CREATE UNIQUE INDEX repositories_org_slug_unique
  ON repositories (organization_id, slug) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX repositories_user_slug_unique
  ON repositories (owner_user_id, slug) WHERE owner_user_id IS NOT NULL;

COMMIT;
PRAGMA foreign_keys=ON;
