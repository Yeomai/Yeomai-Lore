ALTER TABLE repository_imports
  ADD COLUMN provider TEXT NOT NULL DEFAULT '';
ALTER TABLE repository_imports
  ADD COLUMN include_tags INTEGER NOT NULL DEFAULT 0
    CHECK (include_tags IN (0, 1));
