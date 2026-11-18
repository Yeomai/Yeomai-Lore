ALTER TABLE repository_import_revisions
  ADD COLUMN git_committer_time INTEGER NOT NULL DEFAULT 0;
