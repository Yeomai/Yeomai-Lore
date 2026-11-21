import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type SessionUser } from "@lore-portal/shared";
import { buildApp } from "../src/app.ts";
import { SessionService } from "../src/auth/session.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";

describe("repository import routes", () => {
  it("allows a regular user to list and create imports in their own scope", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-import-routes-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      const userId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role)
         VALUES ($1, 'member@example.com', 'member', 'Member', 'unused', 'user')`,
        [userId],
      );
      const session = new SessionService(db, config);
      const browserSession = await session.create(userId);
      const listedFor: string[] = [];
      const createdFor: string[] = [];
      const terminalCleanedFor: string[] = [];
      app = await buildApp({
        config,
        db,
        lore: {},
        session,
        tokens: {},
        oauth: {},
        mailer: { send: async () => {} },
        imports: {
          list: async (actor: SessionUser) => {
            listedFor.push(actor.id);
            return [];
          },
          create: async (actor: SessionUser) => {
            createdFor.push(actor.id);
            return {
              id: newId(),
              actorUserId: actor.id,
              actorUsername: actor.username,
              targetRepositoryId: null,
              sourceKind: "url",
              sourceValue: "https://example.com/team/repo.git",
              provider: "github",
              includeTags: false,
              targetOrganizationSlug: actor.username,
              targetSlug: "repo",
              targetDescription: "",
              sourceDefaultBranch: null,
              status: "queued",
              phase: "validating",
              totalCommits: 0,
              importedCommits: 0,
              totalBytes: 0,
              importedBytes: 0,
              errorMessage: "",
              queuePosition: 1,
              requestedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              startedAt: null,
              finishedAt: null,
            };
          },
          removeTerminal: async (actor: SessionUser) => {
            terminalCleanedFor.push(actor.id);
            return { removedCount: 2, failedCount: 0 };
          },
        },
        logger: false,
      } as never);
      const headers = {
        cookie: `lore_portal_session=${browserSession.token}`,
      };

      const unauthenticated = await app.inject({
        method: "GET",
        url: "/api/v1/repository-imports",
      });
      expect(unauthenticated.statusCode).toBe(401);

      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/repository-imports",
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ imports: [] });
      expect(listedFor).toEqual([userId]);

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/repository-imports",
        headers,
        payload: {
          sourceValue: "https://example.com/team/repo.git",
          slug: "repo",
          description: "",
        },
      });
      expect(created.statusCode).toBe(202);
      expect(createdFor).toEqual([userId]);

      const cleaned = await app.inject({
        method: "DELETE",
        url: "/api/v1/repository-imports/terminal",
        headers,
      });
      expect(cleaned.statusCode).toBe(200);
      expect(cleaned.json()).toEqual({ removedCount: 2, failedCount: 0 });
      expect(terminalCleanedFor).toEqual([userId]);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
