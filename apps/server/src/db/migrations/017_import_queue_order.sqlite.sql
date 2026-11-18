ALTER TABLE repository_imports
  ADD COLUMN requested_at TEXT;

UPDATE repository_imports
   SET requested_at = created_at
 WHERE requested_at IS NULL;

CREATE INDEX IF NOT EXISTS repository_imports_queue_order_idx
  ON repository_imports (status, requested_at, id);
