CREATE TABLE IF NOT EXISTS repository_revision_git_times (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  lore_revision TEXT NOT NULL,
  git_committer_time INTEGER NOT NULL,
  PRIMARY KEY (repository_id, lore_revision)
);

INSERT INTO repository_revision_git_times
  (repository_id, lore_revision, git_committer_time)
SELECT ri.target_repository_id, rir.lore_revision, rir.git_committer_time
  FROM repository_import_revisions rir
  JOIN repository_imports ri ON ri.id = rir.import_id
 WHERE ri.target_repository_id IS NOT NULL
   AND rir.git_committer_time > 0
ON CONFLICT (repository_id, lore_revision)
DO UPDATE SET git_committer_time = EXCLUDED.git_committer_time;
