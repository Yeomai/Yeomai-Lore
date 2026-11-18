import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { SessionService } from "../src/auth/session.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";

describe("audit pagination", () => {
  it("loads 50 events by default and continues past offset 300", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-audit-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const admin = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username = 'admin'",
      );
      const userId = admin.rows[0]!.id;
      const params: unknown[] = [userId];
      const values: string[] = [];
      for (let index = 0; index < 305; index += 1) {
        const idIndex = params.length + 1;
        const targetIndex = params.length + 2;
        const createdIndex = params.length + 3;
        values.push(
          `($${idIndex}, $1, 'test.event', 'audit', $${targetIndex}, $${createdIndex})`,
        );
        params.push(
          `audit-${String(index).padStart(3, "0")}`,
          `target-${index}`,
          new Date(Date.UTC(2026, 0, 1, 0, 0, 305 - index)).toISOString(),
        );
      }
      await db.query(
        `INSERT INTO audit_events
           (id, actor_user_id, action, target_type, target_id, created_at)
         VALUES ${values.join(",")}`,
        params,
      );

      const session = new SessionService(db, config);
      const browserSession = await session.create(userId);
      app = await buildApp({
        config,
        db,
        lore: {},
        session,
        tokens: {},
        oauth: {},
        mailer: { send: async () => {} },
        logger: false,
      } as never);
      const headers = {
        cookie: `lore_portal_session=${browserSession.token}`,
      };

      const firstPage = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit",
        headers,
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json().events).toHaveLength(50);

      const pageAfterThreeHundred = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit?limit=50&offset=300",
        headers,
      });
      expect(pageAfterThreeHundred.statusCode).toBe(200);
      expect(pageAfterThreeHundred.json().events).toHaveLength(5);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
