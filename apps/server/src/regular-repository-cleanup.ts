import { AppError } from "@lore-portal/shared";
import { audit } from "./auth/audit.ts";
import { issueRepositoryToken } from "./auth/repository-auth.ts";
import type { TokenService } from "./auth/token-service.ts";
import { findUserById } from "./auth/users.ts";
import type { Database } from "./db/index.ts";
import type { LoreClient } from "./lore/types.ts";
import {
  readQuotaSettings,
  REGULAR_USER_REPOSITORY_LAST_CLEANUP_AT,
} from "./quota-settings.ts";
import { findRepositoryById } from "./repositories.ts";
import { setSystemSetting } from "./settings.ts";

const CHECK_INTERVAL_MS = 60_000;

interface CleanupLogger {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface RegularRepositoryCleanupResult {
  deleted: number;
  failed: number;
}

export async function runRegularRepositoryCleanup(
  db: Database,
  lore: LoreClient,
  tokens: TokenService,
): Promise<RegularRepositoryCleanupResult> {
  const repositories = await db.query<{
    id: string;
    owner_user_id: string;
  }>(
    `SELECT r.id, r.owner_user_id
       FROM repositories r
       JOIN users u ON u.id = r.owner_user_id
      WHERE u.global_role = 'user'
        AND u.status = 'active'
        AND r.organization_id IS NULL
        AND r.owner_user_id IS NOT NULL
        AND r.status = 'active'
        AND NOT EXISTS (
          SELECT 1
            FROM repository_imports ri
           WHERE ri.target_repository_id = r.id
             AND ri.status IN ('queued', 'running')
        )
      ORDER BY r.created_at, r.id`,
  );
  let deleted = 0;
  let failed = 0;
  for (const row of repositories.rows) {
    const user = await findUserById(db, row.owner_user_id);
    const repository = await findRepositoryById(db, row.id);
    if (!user || !repository) {
      failed += 1;
      continue;
    }
    try {
      const token = await issueRepositoryToken(
        db,
        tokens,
        user,
        repository,
      );
      try {
        await lore.deleteRepository(repository.id, token);
      } catch (error) {
        if (!(error instanceof AppError && error.code === "not_found")) {
          throw error;
        }
      }
      await db.query(`DELETE FROM repositories WHERE id = $1`, [
        repository.id,
      ]);
      await audit(db, {
        actorUserId: user.id,
        action: "repository.auto_cleaned",
        targetType: "repository",
        targetId: repository.id,
        metadata: { name: repository.name },
      });
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}

export function startRegularRepositoryCleanup(
  db: Database,
  lore: LoreClient,
  tokens: TokenService,
  logger: CleanupLogger,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  const ensureLastCleanup = async (): Promise<Date> => {
    const row = await db.query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [REGULAR_USER_REPOSITORY_LAST_CLEANUP_AT],
    );
    const parsed = new Date(row.rows[0]?.value ?? "");
    if (!Number.isNaN(parsed.getTime())) return parsed;
    const now = new Date();
    await setSystemSetting(
      db,
      REGULAR_USER_REPOSITORY_LAST_CLEANUP_AT,
      now.toISOString(),
    );
    return now;
  };

  const tick = async () => {
    const settings = await readQuotaSettings(db);
    if (!settings.enabled || settings.cleanupHours <= 0) return;
    const last = await ensureLastCleanup();
    const dueAt =
      last.getTime() + settings.cleanupHours * 60 * 60 * 1000;
    if (Date.now() < dueAt) return;
    const result = await runRegularRepositoryCleanup(db, lore, tokens);
    await setSystemSetting(
      db,
      REGULAR_USER_REPOSITORY_LAST_CLEANUP_AT,
      new Date().toISOString(),
    );
    logger.info(
      { cleanup: result },
      "Regular user repository cleanup complete",
    );
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = tick()
        .catch((error) => {
          logger.error(
            { err: error },
            "Regular user repository cleanup failed",
          );
        })
        .finally(() => {
          inFlight = undefined;
          schedule();
        });
    }, CHECK_INTERVAL_MS);
    timer.unref();
  };

  void ensureLastCleanup().catch((error) => {
    logger.error(
      { err: error },
      "Failed to initialize regular user cleanup schedule",
    );
  });
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
