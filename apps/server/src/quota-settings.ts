import { AppError } from "@lore-portal/shared";
import type { QueryExecutor } from "./db/index.ts";
import { setSystemSetting } from "./settings.ts";

const MIB = 1024 * 1024;

export const REGULAR_USER_MAX_REPOSITORIES =
  "regular_user_max_repositories";
export const REGULAR_USER_QUOTA_ENABLED = "regular_user_quota_enabled";
export const REGULAR_USER_MAX_SIZE_BYTES = "regular_user_max_size_bytes";
export const REGULAR_USER_IMPORT_MAX_BYTES =
  "regular_user_import_max_bytes";
export const REGULAR_USER_REPOSITORY_CLEANUP_HOURS =
  "regular_user_repository_cleanup_hours";
export const REGULAR_USER_REPOSITORY_LAST_CLEANUP_AT =
  "regular_user_repository_last_cleanup_at";

export interface QuotaSettings {
  enabled: boolean;
  maxRepositories: number;
  maxSizeBytes: number;
  importMaxBytes: number;
  cleanupHours: number;
}

export const DEFAULT_QUOTA_SETTINGS: QuotaSettings = {
  enabled: false,
  maxRepositories: 1,
  maxSizeBytes: 5 * MIB,
  importMaxBytes: 5 * MIB,
  cleanupHours: 24,
};

export async function readQuotaSettings(
  db: QueryExecutor,
): Promise<QuotaSettings> {
  const result = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM system_settings
      WHERE key IN ($1, $2, $3, $4, $5)`,
    [
      REGULAR_USER_QUOTA_ENABLED,
      REGULAR_USER_MAX_REPOSITORIES,
      REGULAR_USER_MAX_SIZE_BYTES,
      REGULAR_USER_IMPORT_MAX_BYTES,
      REGULAR_USER_REPOSITORY_CLEANUP_HOURS,
    ],
  );
  const values = new Map(result.rows.map((row) => [row.key, row.value]));
  return {
    enabled: values.get(REGULAR_USER_QUOTA_ENABLED) === "true",
    maxRepositories: integerSetting(
      values.get(REGULAR_USER_MAX_REPOSITORIES),
      DEFAULT_QUOTA_SETTINGS.maxRepositories,
    ),
    maxSizeBytes: integerSetting(
      values.get(REGULAR_USER_MAX_SIZE_BYTES),
      DEFAULT_QUOTA_SETTINGS.maxSizeBytes,
    ),
    importMaxBytes: integerSetting(
      values.get(REGULAR_USER_IMPORT_MAX_BYTES),
      DEFAULT_QUOTA_SETTINGS.importMaxBytes,
    ),
    cleanupHours: integerSetting(
      values.get(REGULAR_USER_REPOSITORY_CLEANUP_HOURS),
      DEFAULT_QUOTA_SETTINGS.cleanupHours,
    ),
  };
}

export async function writeQuotaSettings(
  db: QueryExecutor,
  settings: QuotaSettings,
): Promise<void> {
  await Promise.all([
    setSystemSetting(
      db,
      REGULAR_USER_QUOTA_ENABLED,
      settings.enabled ? "true" : "false",
    ),
    setSystemSetting(
      db,
      REGULAR_USER_MAX_REPOSITORIES,
      String(settings.maxRepositories),
    ),
    setSystemSetting(
      db,
      REGULAR_USER_MAX_SIZE_BYTES,
      String(settings.maxSizeBytes),
    ),
    setSystemSetting(
      db,
      REGULAR_USER_IMPORT_MAX_BYTES,
      String(settings.importMaxBytes),
    ),
    setSystemSetting(
      db,
      REGULAR_USER_REPOSITORY_CLEANUP_HOURS,
      String(settings.cleanupHours),
    ),
  ]);
}

export async function assertPersonalRepositoryCountQuota(
  db: QueryExecutor,
  userId: string,
): Promise<void> {
  const user = await db.query<{ global_role: string }>(
    `SELECT global_role FROM users WHERE id = $1`,
    [userId],
  );
  if (user.rows[0]?.global_role === "admin") return;
  const settings = await readQuotaSettings(db);
  if (!settings.enabled || settings.maxRepositories === 0) return;
  const count = await db.query<{ count: number }>(
    `SELECT count(*) AS count
       FROM repositories
      WHERE owner_user_id = $1
        AND status IN ('active', 'pending')`,
    [userId],
  );
  const used = Number(count.rows[0]?.count ?? 0);
  if (used >= settings.maxRepositories) {
    throw new AppError(
      "conflict",
      409,
      `Regular users may have at most ${settings.maxRepositories} personal repositories`,
      {
        limit: settings.maxRepositories,
        used,
      },
    );
  }
}

function integerSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
