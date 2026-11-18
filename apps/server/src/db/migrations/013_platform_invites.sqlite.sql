PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE invites_platform_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  organization_role TEXT NOT NULL DEFAULT 'member' CHECK (organization_role IN ('owner', 'admin', 'member')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  token_ciphertext TEXT
);

INSERT INTO invites_platform_new
  (id, email, token_hash, organization_id, organization_role, invited_by,
   expires_at, accepted_at, created_at, token_ciphertext)
SELECT id, email, token_hash, organization_id, organization_role, invited_by,
       expires_at, accepted_at, created_at, token_ciphertext
  FROM invites;

DROP TABLE invites;
ALTER TABLE invites_platform_new RENAME TO invites;

CREATE UNIQUE INDEX invites_pending_email_unique
  ON invites (lower(email)) WHERE accepted_at IS NULL;

COMMIT;

PRAGMA foreign_keys = ON;
