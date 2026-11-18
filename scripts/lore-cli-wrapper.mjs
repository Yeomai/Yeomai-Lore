import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [binary, ...args] = process.argv.slice(2);
if (!binary) {
  console.error("Missing Lore binary path");
  process.exit(1);
}

const publicUrl = (process.env.LORE_PUBLIC_URL ?? "lore://localhost:3000").replace(
  /\/+$/,
  "",
);
const databasePath = path.join(root, "data", "local", "portal.sqlite");
const resolved = args.map((argument) => resolveRepositoryUrl(argument));
const result = spawnSync(binary, resolved, {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

function resolveRepositoryUrl(value) {
  const prefix = `${publicUrl}/`;
  if (!value.startsWith(prefix) || !existsSync(databasePath)) {
    return value;
  }
  const segments = value.slice(prefix.length).split("/");
  if (segments.length !== 2) {
    return value;
  }
  const [namespace, slug] = segments;
  let db;
  try {
    db = new DatabaseSync(databasePath);
    const row = db
      .prepare(
        `SELECT r.lore_name
           FROM repositories r
           JOIN users u ON u.id = r.owner_user_id
          WHERE lower(u.username) = lower(?) AND r.slug = ?
            AND r.status <> 'deleted'
          LIMIT 1`,
      )
      .get(namespace, slug);
    return row?.lore_name ? `${publicUrl}/${row.lore_name}` : value;
  } catch {
    return value;
  } finally {
    db?.close();
  }
}
