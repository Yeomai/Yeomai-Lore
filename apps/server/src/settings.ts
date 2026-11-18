import type { QueryExecutor } from "./db/index.ts";

export const USER_REGISTRATION_ENABLED = "user_registration_enabled";
export const USER_INVITATIONS_ENABLED = "user_invitations_enabled";

export async function setSystemSetting(
  db: QueryExecutor,
  key: string,
  value: string,
): Promise<void> {
  await db.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, value],
  );
}

export async function isUserRegistrationEnabled(
  db: QueryExecutor,
): Promise<boolean> {
  const result = await db.query<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = $1`,
    [USER_REGISTRATION_ENABLED],
  );
  return result.rows[0]?.value !== "false";
}

export async function setUserRegistrationEnabled(
  db: QueryExecutor,
  enabled: boolean,
): Promise<void> {
  await setSystemSetting(
    db,
    USER_REGISTRATION_ENABLED,
    enabled ? "true" : "false",
  );
}

export async function isUserInvitationsEnabled(
  db: QueryExecutor,
): Promise<boolean> {
  const result = await db.query<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = $1`,
    [USER_INVITATIONS_ENABLED],
  );
  return result.rows[0]?.value === "true";
}

export async function setUserInvitationsEnabled(
  db: QueryExecutor,
  enabled: boolean,
): Promise<void> {
  await setSystemSetting(
    db,
    USER_INVITATIONS_ENABLED,
    enabled ? "true" : "false",
  );
}
