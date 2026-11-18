import type { QueryExecutor } from "../db/index.ts";
import { newId } from "@lore-portal/shared";

export async function audit(
  db: QueryExecutor,
  input: {
    actorUserId?: string | null;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (id, actor_user_id, action, target_type, target_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newId(),
      input.actorUserId ?? null,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.metadata ?? {}),
      input.ip ?? null,
    ],
  );
}
