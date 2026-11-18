ALTER TABLE repository_imports
  ADD COLUMN remote_protocol TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_imports
  ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'none';
ALTER TABLE repository_imports
  ADD COLUMN requires_credentials INTEGER NOT NULL DEFAULT 0;
