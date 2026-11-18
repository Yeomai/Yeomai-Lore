import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@lore-portal/shared";
import { findUserById } from "../src/auth/users.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";
import {
  isMetadataOnlyGitCommit,
  isPrivateAddress,
  loreBranchSwitchArgs,
  loreCommandEnvironment,
  parseGitNameStatus,
  RepositoryImportService,
} from "../src/imports/service.ts";

describe("Git import support", () => {
  it("rejects private and link-local network addresses", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.20.1.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.8")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("identifies empty root and single-parent commits without treating merges as empty", () => {
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const populatedTree = "a".repeat(40);

    expect(
      isMetadataOnlyGitCommit({
        parents: [],
        tree: emptyTree,
        firstParentTree: null,
      }),
    ).toBe(true);
    expect(
      isMetadataOnlyGitCommit({
        parents: ["parent"],
        tree: populatedTree,
        firstParentTree: populatedTree,
      }),
    ).toBe(true);
    expect(
      isMetadataOnlyGitCommit({
        parents: ["parent"],
        tree: populatedTree,
        firstParentTree: "b".repeat(40),
      }),
    ).toBe(false);
    expect(
      isMetadataOnlyGitCommit({
        parents: ["parent", "merged-parent"],
        tree: populatedTree,
        firstParentTree: populatedTree,
      }),
    ).toBe(false);
  });

  it("parses NUL-delimited Git change lists including renames", () => {
    expect(
      parseGitNameStatus(
        "M\0data/one.json\0A\0data/two.json\0D\0data/old.json\0" +
          "R100\0data/from.json\0data/to.json\0T\0data/link\0",
      ),
    ).toEqual([
      { status: "M", path: "data/one.json" },
      { status: "A", path: "data/two.json" },
      { status: "D", path: "data/old.json" },
      {
        status: "R100",
        oldPath: "data/from.json",
        path: "data/to.json",
      },
      { status: "T", path: "data/link" },
    ]);
  });

  it("passes identity and repository access tokens to Lore commands", () => {
    const env = loreCommandEnvironment("identity-token", "repository-token");

    expect(env.LORE_IDENTITY_TOKEN).toBe("identity-token");
    expect(env.LORE_ACCESS_TOKEN).toBe("repository-token");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
  });

  it("does not pass a zero revision when switching from an empty history", () => {
    const zero = "0".repeat(64);

    expect(loreBranchSwitchArgs("main", zero)).toEqual([
      "branch",
      "switch",
      "main",
      "--force",
      "--reset",
    ]);
    expect(loreBranchSwitchArgs("main", "abc123")).toEqual([
      "branch",
      "switch",
      "main",
      "abc123",
      "--force",
      "--reset",
    ]);
  });

  it("creates the durable import job tables", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-import-db-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'repository_imports',
              'repository_import_revisions',
              'repository_import_warnings',
              'repository_revision_git_times',
              'repository_tags'
            )
          ORDER BY name`,
      );
      expect(tables.rows.map((row) => row.name)).toEqual([
        "repository_import_revisions",
        "repository_import_warnings",
        "repository_imports",
        "repository_revision_git_times",
        "repository_tags",
      ]);
      const importColumns = await db.query<{ name: string }>(
        "PRAGMA table_info(repository_imports)",
      );
      expect(importColumns.rows.some((column) => column.name === "requested_at"))
        .toBe(true);
      expect(importColumns.rows.some((column) => column.name === "queue_slot"))
        .toBe(true);
      const globalRunningIndex = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND name = 'repository_imports_one_running'`,
      );
      expect(globalRunningIndex.rows).toEqual([
        { name: "repository_imports_one_running" },
      ]);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces one active queue slot for regular users but not administrators", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-import-slots-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const userId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role)
         VALUES ($1, 'member@example.com', 'member', 'Member', 'unused', 'user')`,
        [userId],
      );
      const admin = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username = 'admin'",
      );
      const insertJob = async (
        actorUserId: string,
        queueSlot: string | null,
        slug: string,
      ) => {
        await db.query(
          `INSERT INTO repository_imports
             (id, actor_user_id, source_kind, remote_protocol, provider,
              source_value, target_owner_user_id, target_organization_slug,
              target_slug, requested_at, queue_slot)
           VALUES ($1, $2, 'https', 'https', 'github', $3, $2, $4, $5, $6, $7)`,
          [
            newId(),
            actorUserId,
            `https://example.com/${slug}.git`,
            slug,
            slug,
            new Date().toISOString(),
            queueSlot,
          ],
        );
      };

      await insertJob(userId, userId, "member-one");
      await expect(insertJob(userId, userId, "member-two")).rejects.toThrow();
      await insertJob(admin.rows[0]!.id, null, "admin-one");
      await insertJob(admin.rows[0]!.id, null, "admin-two");
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finalizes a job without crashing when Windows cleanup reports EBUSY", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-import-ebusy-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
      LORE_IMPORT_WORK_DIR: path.join(directory, "imports"),
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const admin = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username = 'admin'",
      );
      const actor = await findUserById(db, admin.rows[0]!.id);
      const jobId = newId();
      await db.query(
        `INSERT INTO repository_imports
           (id, actor_user_id, source_kind, remote_protocol, provider,
            source_value, target_owner_user_id, target_organization_slug,
            target_slug, requested_at)
         VALUES ($1, $2, 'https', 'https', 'github', $3, $2, 'admin', $4, $5)`,
        [
          jobId,
          actor!.id,
          "https://example.com/ebusy.git",
          "ebusy",
          new Date().toISOString(),
        ],
      );
      const service = new RepositoryImportService(
        config,
        db,
        {} as never,
        {} as never,
      );
      const internals = service as unknown as {
        pump: () => Promise<void>;
        running: Promise<void> | null;
        run: () => Promise<void>;
        cleanupTarget: () => Promise<void>;
      };
      internals.run = async () => {
        throw new Error("simulated cancellation");
      };
      internals.cleanupTarget = async () => {
        const error = new Error("resource busy or locked") as Error & {
          code: string;
        };
        error.code = "EBUSY";
        throw error;
      };

      await internals.pump();
      const active = internals.running;
      expect(active).not.toBeNull();
      await active;

      const row = await db.query<{ status: string; queue_slot: string | null }>(
        "SELECT status, queue_slot FROM repository_imports WHERE id = $1",
        [jobId],
      );
      expect(row.rows[0]).toEqual({
        status: "failed",
        queue_slot: null,
      });
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates user jobs and orders the shared queue by request time", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-import-auth-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
      LORE_IMPORT_WORK_DIR: path.join(directory, "imports"),
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const userId = newId();
      const otherUserId = newId();
      const freshUserId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role)
         VALUES
           ($1, 'member@example.com', 'member', 'Member', 'unused', 'user'),
           ($2, 'other@example.com', 'other', 'Other', 'unused', 'user'),
           ($3, 'fresh@example.com', 'fresh', 'Fresh', 'unused', 'user')`,
        [userId, otherUserId, freshUserId],
      );
      const admin = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username = 'admin'",
      );
      const adminUser = await findUserById(db, admin.rows[0]!.id);
      const member = await findUserById(db, userId);
      const other = await findUserById(db, otherUserId);
      const fresh = await findUserById(db, freshUserId);
      expect(adminUser && member && other && fresh).not.toBeNull();

      const insertJob = async (
        id: string,
        actorUserId: string,
        requestedAt: string,
        slug: string,
        status = "queued",
      ) => {
        await db.query(
          `INSERT INTO repository_imports
             (id, actor_user_id, source_kind, remote_protocol, provider,
              source_value, target_owner_user_id, target_organization_slug,
              target_slug, requested_at, created_at, status)
           VALUES ($1, $2, 'https', 'https', 'github', $3, $2, $4, $5, $6, $6, $7)`,
          [
            id,
            actorUserId,
            `https://example.com/${slug}.git`,
            slug === "other-job" ? "other" : "member",
            slug,
            requestedAt,
            status,
          ],
        );
      };
      const laterId = newId();
      const earlierId = newId();
      const otherJobId = newId();
      await insertJob(
        laterId,
        userId,
        "2026-11-16T10:00:02.000Z",
        "later-job",
      );
      await insertJob(
        earlierId,
        userId,
        "2026-11-16T10:00:01.000Z",
        "earlier-job",
      );
      await insertJob(
        otherJobId,
        otherUserId,
        "2026-11-16T10:00:00.500Z",
        "other-job",
        "running",
      );

      const service = new RepositoryImportService(
        config,
        db,
        {} as never,
        {} as never,
      );
      expect(
        (await service.list(member!)).map((job) => ({
          id: job.id,
          queuePosition: job.queuePosition,
        })),
      ).toEqual([
        { id: earlierId, queuePosition: 2 },
        { id: laterId, queuePosition: 3 },
      ]);
      expect(
        (await service.list(adminUser!)).map((job) => ({
          id: job.id,
          queuePosition: job.queuePosition,
        })),
      ).toEqual([
        { id: otherJobId, queuePosition: 1 },
        { id: earlierId, queuePosition: 2 },
        { id: laterId, queuePosition: 3 },
      ]);
      expect(await service.getVisible(otherJobId, member!)).toBeNull();
      await expect(service.cancel(otherJobId, member!)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        service.create(member!, {
          sourceValue: "https://example.com/team/another-repo.git",
          includeTags: false,
          slug: "another-repo",
          description: "",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        service.create(fresh!, {
          sourceValue: "https://example.com/team/repo.git",
          includeTags: false,
          organizationId: newId(),
          slug: "forbidden-org",
          description: "",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      const [firstCancel, repeatedCancel] = await Promise.all([
        service.cancel(earlierId, member!),
        service.cancel(earlierId, member!),
      ]);
      expect(firstCancel.status).toBe("cancelled");
      expect(repeatedCancel.status).toBe("cancelled");
      expect((await service.get(earlierId))?.status).toBe("cancelled");
      expect((await service.get(otherJobId))?.status).toBe("running");
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
