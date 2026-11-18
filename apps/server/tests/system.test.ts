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

describe("system restart", () => {
  it("restarts Lore only for an authenticated administrator", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-restart-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    let restarts = 0;
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const session = new SessionService(db, config);
      const admin = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username = 'admin'",
      );
      const browserSession = await session.create(admin.rows[0]!.id);
      app = await buildApp({
        config,
        db,
        lore: {},
        session,
        tokens: {},
        oauth: {},
        mailer: { send: async () => {} },
        restartLore: async () => {
          restarts += 1;
        },
        logger: false,
      } as never);

      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/system/restart-lore",
      });
      expect(rejected.statusCode).toBe(401);
      expect(restarts).toBe(0);

      const restarted = await app.inject({
        method: "POST",
        url: "/api/v1/system/restart-lore",
        headers: {
          cookie: `lore_portal_session=${browserSession.token}`,
        },
      });
      expect(restarted.statusCode).toBe(200);
      expect(restarted.json()).toMatchObject({ ok: true });
      expect(restarts).toBe(1);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
