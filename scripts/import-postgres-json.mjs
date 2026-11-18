import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const exportDir = process.argv[2];
const databasePath = process.argv[3];
if (!exportDir || !databasePath) {
  throw new Error("Usage: node import-postgres-json.mjs <export-dir> <sqlite-file>");
}

const tables = [
  "users",
  "organizations",
  "organization_members",
  "teams",
  "team_members",
  "repositories",
  "repository_grants",
  "invites",
  "api_tokens",
  "audit_events",
  "oauth_device_codes",
  "oauth_refresh_tokens",
  "password_resets",
  "sessions",
];

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("BEGIN IMMEDIATE");
try {
  for (const table of tables) {
    const rows = JSON.parse(
      readFileSync(path.join(exportDir, `${table}.json`), "utf8"),
    );
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((column) =>
        row[column] !== null && typeof row[column] === "object"
          ? JSON.stringify(row[column])
          : row[column],
      );
      const placeholders = columns.map(() => "?").join(", ");
      db.prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
      ).run(...values);
    }
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}
