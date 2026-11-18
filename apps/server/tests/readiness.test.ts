import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { SessionService } from "../src/auth/session.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";

describe("service readiness", () => {
  it("reports unavailable until Lore is ready", async () => {
    const db = createDatabase(":memory:");
    const config = loadConfig({ NODE_ENV: "test" });
    let ready = false;
    await migrate(db);
    const app = await buildApp({
      config,
      db,
      lore: {},
      session: new SessionService(db, config),
      tokens: {},
      oauth: {},
      mailer: { send: async () => {} },
      serviceReadiness: async () => ready,
      logger: false,
    } as never);

    try {
      const unavailable = await app.inject({
        method: "GET",
        url: "/api/v1/ready",
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ ready: false });

      ready = true;
      const available = await app.inject({
        method: "GET",
        url: "/api/v1/ready",
      });
      expect(available.statusCode).toBe(200);
      expect(available.json()).toEqual({ ready: true });
    } finally {
      await app.close();
      await db.end();
    }
  });
});
