ALTER TABLE repository_imports
  ADD COLUMN queue_slot TEXT;

UPDATE repository_imports AS target
   SET queue_slot = target.actor_user_id
 WHERE target.status IN ('queued', 'running')
   AND target.id = (
     SELECT candidate.id
       FROM repository_imports AS candidate
       JOIN users AS actor ON actor.id = candidate.actor_user_id
      WHERE candidate.actor_user_id = target.actor_user_id
        AND candidate.status IN ('queued', 'running')
        AND actor.global_role <> 'admin'
      ORDER BY candidate.requested_at, candidate.id
      LIMIT 1
   );

CREATE UNIQUE INDEX IF NOT EXISTS repository_imports_queue_slot_unique
  ON repository_imports (queue_slot)
  WHERE queue_slot IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS repository_imports_one_running
  ON repository_imports ((1))
  WHERE status = 'running';
