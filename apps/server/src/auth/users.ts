import type { GlobalRole, SessionUser } from "@lore-portal/shared";
import type { QueryExecutor } from "../db/index.ts";

interface UserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  password_hash: string;
  global_role: GlobalRole;
  status: string;
}

export interface AuthenticatedUserRecord {
  user: SessionUser;
  passwordHash: string;
}

function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    globalRole: row.global_role,
  };
}

export async function findAuthenticatedUser(
  db: QueryExecutor,
  identifier: string,
): Promise<AuthenticatedUserRecord | null> {
  const result = await db.query<UserRow>(
    `SELECT id, email, username, display_name, password_hash, global_role, status
       FROM users
      WHERE lower(email) = lower($1) OR lower(username) = lower($1)`,
    [identifier],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") {
    return null;
  }
  return { user: toSessionUser(row), passwordHash: row.password_hash };
}

export async function findUserById(
  db: QueryExecutor,
  userId: string,
): Promise<SessionUser | null> {
  const result = await db.query<UserRow>(
    `SELECT id, email, username, display_name, password_hash, global_role, status
       FROM users
      WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return row && row.status === "active" ? toSessionUser(row) : null;
}

export async function findUserByUsername(
  db: QueryExecutor,
  username: string,
): Promise<SessionUser | null> {
  const result = await db.query<UserRow>(
    `SELECT id, email, username, display_name, password_hash, global_role, status
       FROM users
      WHERE lower(username) = lower($1)`,
    [username],
  );
  const row = result.rows[0];
  return row && row.status === "active" ? toSessionUser(row) : null;
}

export async function listUsersByIds(
  db: QueryExecutor,
  ids: string[],
): Promise<SessionUser[]> {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
  const result = await db.query<UserRow>(
    `SELECT id, email, username, display_name, password_hash, global_role, status
       FROM users
      WHERE id IN (${placeholders}) AND status = 'active'`,
    ids,
  );
  return result.rows.map(toSessionUser);
}

export async function searchUserDirectory(
  db: QueryExecutor,
  input: { query: string; excludeUserId: string },
): Promise<Array<{ id: string; username: string; displayName: string }>> {
  const escaped = input.query.replace(/[!%_]/g, "!$&");
  const result = await db.query<{
    id: string;
    username: string;
    display_name: string;
  }>(
    `SELECT id, username, display_name
       FROM users
      WHERE status = 'active'
        AND id <> $2
        AND (
          lower(username) LIKE lower($1) ESCAPE '!'
          OR lower(display_name) LIKE lower($1) ESCAPE '!'
        )
      ORDER BY lower(username)
      LIMIT 10`,
    [`%${escaped}%`, input.excludeUserId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
  }));
}
