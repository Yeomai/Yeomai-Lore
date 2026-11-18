import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(db: Database): Promise<void> {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);
  const columns = await db.query<{ name: string }>(
    "PRAGMA table_info(repositories)",
  );
  const hasRepositories = columns.rows.length > 0;
  const hasOwnerColumn = columns.rows.some(
    (column) => column.name === "owner_user_id",
  );
  if (hasRepositories && !hasOwnerColumn) {
    db.exec(
      await readFile(
        path.join(here, "migrations", "002_repository_owners.sqlite.sql"),
        "utf8",
      ),
    );
  }
  await markMigration(db, "002_repository_owners");
  db.exec(
    await readFile(
      path.join(here, "migrations", "001_initial.sqlite.sql"),
      "utf8",
    ),
  );
  await markMigration(db, "001_initial");
  db.exec(
    await readFile(
      path.join(here, "migrations", "003_system_settings.sqlite.sql"),
      "utf8",
    ),
  );
  await markMigration(db, "003_system_settings");
  db.exec(
    await readFile(
      path.join(here, "migrations", "004_user_devices.sqlite.sql"),
      "utf8",
    ),
  );
  await markMigration(db, "004_user_devices");
  const deviceColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(user_devices)",
  );
  if (!deviceColumns.rows.some((column) => column.name === "device_code")) {
    db.exec(
      await readFile(
        path.join(here, "migrations", "005_device_codes.sqlite.sql"),
        "utf8",
      ),
    );
  }
  await markMigration(db, "005_device_codes");
  db.exec(
    await readFile(
      path.join(here, "migrations", "006_repository_imports.sqlite.sql"),
      "utf8",
    ),
  );
  await markMigration(db, "006_repository_imports");
  const tagColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(repository_tags)",
  );
  if (!tagColumns.rows.some((column) => column.name === "branch_name")) {
    db.exec(
      await readFile(
        path.join(here, "migrations", "007_import_tag_branch.sqlite.sql"),
        "utf8",
      ),
    );
  }
  await markMigration(db, "007_import_tag_branch");
  const importRevisionColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(repository_import_revisions)",
  );
  if (
    !importRevisionColumns.rows.some(
      (column) => column.name === "git_committer_time",
    )
  ) {
    db.exec(
      await readFile(
        path.join(
          here,
          "migrations",
          "008_import_commit_times.sqlite.sql",
        ),
        "utf8",
      ),
    );
  }
  await markMigration(db, "008_import_commit_times");
  const importColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(repository_imports)",
  );
  if (!importColumns.rows.some((column) => column.name === "remote_protocol")) {
    db.exec(
      await readFile(
        path.join(here, "migrations", "009_import_credentials.sqlite.sql"),
        "utf8",
      ),
    );
  }
  await markMigration(db, "009_import_credentials");
  if (!importColumns.rows.some((column) => column.name === "provider")) {
    db.exec(
      await readFile(
        path.join(
          here,
          "migrations",
          "010_import_provider_tags.sqlite.sql",
        ),
        "utf8",
      ),
    );
  }
  await markMigration(db, "010_import_provider_tags");
  db.exec(
    await readFile(
      path.join(
        here,
        "migrations",
        "011_revision_git_times.sqlite.sql",
      ),
      "utf8",
    ),
  );
  await markMigration(db, "011_revision_git_times");
  const inviteColumns = await db.query<{
    name: string;
    notnull: number;
  }>(
    "PRAGMA table_info(invites)",
  );
  if (
    !inviteColumns.rows.some(
      (column) => column.name === "token_ciphertext",
    )
  ) {
    db.exec(
      await readFile(
        path.join(
          here,
          "migrations",
          "012_invite_token_ciphertext.sqlite.sql",
        ),
        "utf8",
      ),
    );
  }
  await markMigration(db, "012_invite_token_ciphertext");
  const platformInviteColumns = await db.query<{
    name: string;
    notnull: number;
  }>("PRAGMA table_info(invites)");
  if (
    platformInviteColumns.rows.some(
      (column) => column.name === "organization_id" && Number(column.notnull) === 1,
    )
  ) {
    db.exec(
      await readFile(
        path.join(
          here,
          "migrations",
          "013_platform_invites.sqlite.sql",
        ),
        "utf8",
      ),
    );
  }
  await markMigration(db, "013_platform_invites");
  const userColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(users)",
  );
  if (!userColumns.rows.some((column) => column.name === "oauth_epoch")) {
    db.exec(
      await readFile(
        path.join(here, "migrations", "014_oauth_epoch.sqlite.sql"),
        "utf8",
      ),
    );
  }
  await markMigration(db, "014_oauth_epoch");
  const refreshTokenColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(oauth_refresh_tokens)",
  );
  if (
    !refreshTokenColumns.rows.some(
      (column) => column.name === "oauth_session_id",
    )
  ) {
    db.exec(
      await readFile(
        path.join(here, "migrations", "015_oauth_sessions.sqlite.sql"),
        "utf8",
      ),
    );
  }
  await markMigration(db, "015_oauth_sessions");
  const sessionColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(oauth_refresh_tokens)",
  );
  if (
    !sessionColumns.rows.some(
      (column) => column.name === "session_started_at",
    )
  ) {
    db.exec(
      await readFile(
        path.join(
          here,
          "migrations",
          "016_oauth_session_started_at.sqlite.sql",
        ),
        "utf8",
      ),
    );
  }
  await markMigration(db, "016_oauth_session_started_at");
  const importQueueColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(repository_imports)",
  );
  if (
    !importQueueColumns.rows.some(
      (column) => column.name === "requested_at",
    )
  ) {
    db.exec(
      await readFile(
        path.join(
          here,
          "migrations",
          "017_import_queue_order.sqlite.sql",
        ),
        "utf8",
      ),
    );
  }
  await markMigration(db, "017_import_queue_order");
  const importQueueSlotColumns = await db.query<{ name: string }>(
    "PRAGMA table_info(repository_imports)",
  );
  if (
    !importQueueSlotColumns.rows.some(
      (column) => column.name === "queue_slot",
    )
  ) {
    db.exec(
      await readFile(
        path.join(
          here,
          "migrations",
          "018_import_per_user_concurrency.sqlite.sql",
        ),
        "utf8",
      ),
    );
  }
  await markMigration(db, "018_import_per_user_concurrency");
  db.exec(
    await readFile(
      path.join(
        here,
        "migrations",
        "019_unified_lore_address.sqlite.sql",
      ),
      "utf8",
    ),
  );
  await markMigration(db, "019_unified_lore_address");
}

async function markMigration(db: Database, version: string): Promise<void> {
  await db.query(
    `INSERT INTO schema_migrations (version)
     VALUES ($1)
     ON CONFLICT (version) DO NOTHING`,
    [version],
  );
}
