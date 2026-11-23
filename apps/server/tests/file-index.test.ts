import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "@lore-portal/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { SessionService } from "../src/auth/session.ts";
import { findUserById } from "../src/auth/users.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";
import {
  markRepositoryStatus,
  registerRepositoryFromLore,
} from "../src/repositories.ts";
import { RepositoryFileIndexCache } from "../src/repository-file-index.ts";

describe("repository file index", () => {
  it("evicts the oldest cached revision when its entry limit is reached", () => {
    const cache = new RepositoryFileIndexCache(60_000, 2);
    cache.set("one", {
      revision: "one",
      entries: ["one.txt"],
      truncated: false,
    });
    cache.set("two", {
      revision: "two",
      entries: ["two.txt"],
      truncated: false,
    });
    cache.set("three", {
      revision: "three",
      entries: ["three.txt"],
      truncated: false,
    });

    expect(cache.get("one")).toBeNull();
    expect(cache.get("two")?.revision).toBe("two");
    expect(cache.get("three")?.revision).toBe("three");
  });

  it("caches file paths by revision and refreshes when branch latest changes", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-file-index-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const adminRow = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const admin = await findUserById(db, adminRow.rows[0]!.id);
      const repositoryId = newId();
      const repository = await registerRepositoryFromLore(db, {
        repositoryId,
        name: "admin/search-project",
        user: admin!,
      });
      await markRepositoryStatus(db, repository.id, "active");

      let latest = "revision-one";
      let treeCalls = 0;
      const lore = {
        listBranches: async () => [
          {
            id: repository.defaultBranchId,
            name: "main",
            latest,
          },
        ],
        getRevisionTree: async (input: { includeLastRevision?: boolean }) => {
          treeCalls += 1;
          expect(input.includeLastRevision).toBe(false);
          return [
            { path: "docs", type: "directory" },
            { path: "docs/guide.md", type: "file" },
            { path: "src", type: "directory" },
            { path: "src/main.tsx", type: "file" },
          ];
        },
      };
      const session = new SessionService(db, config);
      const browserSession = await session.create(admin!.id);
      app = await buildApp({
        config,
        db,
        lore,
        session,
        tokens: {
          signLoginToken: async () => "login-token",
          signRepositoryToken: async () => "repository-token",
        },
        oauth: {},
        mailer: { send: async () => {} },
        logger: false,
      } as never);
      const headers = {
        cookie: `lore_portal_session=${browserSession.token}`,
      };

      const first = await app.inject({
        method: "GET",
        url: "/api/v1/repos/admin/search-project/file-index?branch=main",
        headers,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        revision: "revision-one",
        entries: ["docs/guide.md", "src/main.tsx"],
        truncated: false,
      });
      expect(treeCalls).toBe(1);

      const cached = await app.inject({
        method: "GET",
        url: "/api/v1/repos/admin/search-project/file-index?branch=main",
        headers,
      });
      expect(cached.json().revision).toBe("revision-one");
      expect(treeCalls).toBe(1);

      latest = "revision-two";
      const refreshed = await app.inject({
        method: "GET",
        url: "/api/v1/repos/admin/search-project/file-index?branch=main",
        headers,
      });
      expect(refreshed.json().revision).toBe("revision-two");
      expect(treeCalls).toBe(2);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
