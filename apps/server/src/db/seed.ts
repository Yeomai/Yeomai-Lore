import { newId } from "@lore-portal/shared";
import type { AppConfig } from "../config.ts";
import type { Database } from "./index.ts";
import { hashPassword } from "../auth/password.ts";
import { withTransaction } from "./index.ts";
import { nowIso } from "./index.ts";

export async function seedInitialAdmin(
  db: Database,
  config: AppConfig,
): Promise<void> {
  const users = await db.query<{ count: number }>(
    "SELECT count(*) AS count FROM users",
  );
  if (Number(users.rows[0]?.count ?? 0) > 0) {
    return;
  }
  const userId = newId();
  const passwordHash = await hashPassword(config.bootstrapAdminPassword);
  await withTransaction(db, async (client) => {
    await client.query(
      `INSERT INTO users
         (id, email, username, display_name, password_hash, global_role,
          status, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, 'admin', 'active', $6)`,
      [
        userId,
        config.bootstrapAdminEmail,
        config.bootstrapAdminUsername,
        config.bootstrapAdminUsername,
        passwordHash,
        nowIso(),
      ],
    );
  });
  console.info(`Seeded administrator ${config.bootstrapAdminEmail}`);
}
