import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrateLegacyUnifiedAddress } from "../src/setup.ts";

describe("database migrations", () => {
  it("moves the legacy local Lore address to the unified port", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-migration-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      await db.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ('web_public_url', 'http://localhost:3000', CURRENT_TIMESTAMP),
                ('lore_public_url', 'lore://localhost:41337', CURRENT_TIMESTAMP)`,
      );

      await migrate(db);
      await migrateLegacyUnifiedAddress(db);

      const result = await db.query<{ value: string }>(
        "SELECT value FROM system_settings WHERE key = 'lore_public_url'",
      );
      expect(result.rows[0]?.value).toBe("lore://localhost:3000");
      const applied = await db.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(applied.rows.some((row) => row.version === "001_initial")).toBe(
        true,
      );
      expect(
        applied.rows.some(
          (row) => row.version === "019_unified_lore_address",
        ),
      ).toBe(true);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
