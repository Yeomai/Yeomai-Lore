import { loadConfig } from "../config.ts";
import { createDatabase } from "./index.ts";
import { migrate } from "./migrate.ts";

const config = loadConfig();
const db = createDatabase(config.databasePath);

try {
  await migrate(db);
  console.log("Database schema is up to date.");
} finally {
  await db.end();
}
