import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "@lore-portal/shared";
import { describe, expect, it } from "vitest";
import { TokenService } from "../src/auth/token-service.ts";
import { findUserById } from "../src/auth/users.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";
import {
  createPendingRepository,
  findRepositoryById,
  markRepositoryStatus,
} from "../src/repositories.ts";
import { runRegularRepositoryCleanup } from "../src/regular-repository-cleanup.ts";
import { writeQuotaSettings } from "../src/quota-settings.ts";
import {
  assertPersonalRepositoryQuota,
  assertPersonalRepositoryPushQuota,
  assertRegularUserImportQuota,
} from "../src/user-quota.ts";

describe("regular user quotas", () => {
  it("does not enforce quotas while the master switch is disabled", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-quota-off-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      const regularId = await insertUser(db, "member");
      await createRepository(db, regularId, "member", "first");
      await createRepository(db, regularId, "member", "second");
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("limits personal repository count and exempts administrators", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-quota-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const regularId = await insertUser(db, "member");
      await writeQuotaSettings(db, {
        enabled: true,
        maxRepositories: 1,
        maxSizeBytes: 5 * 1024 * 1024,
        importMaxBytes: 5 * 1024 * 1024,
        cleanupHours: 24,
      });
      const regular = await findUserById(db, regularId);
      const adminRow = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE username = 'admin'`,
      );
      const admin = await findUserById(db, adminRow.rows[0]!.id);
      expect(regular).not.toBeNull();
      expect(admin).not.toBeNull();

      await createRepository(db, regularId, "member", "first");
      await expect(
        createRepository(db, regularId, "member", "second"),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { limit: 1, used: 1 },
      });

      await createRepository(db, admin!.id, "admin", "first");
      await createRepository(db, admin!.id, "admin", "second");
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cleans regular user personal repositories only", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-cleanup-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const regularId = await insertUser(db, "member");
      const adminRow = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE username = 'admin'`,
      );
      const regularRepo = await createRepository(
        db,
        regularId,
        "member",
        "personal",
      );
      const adminRepo = await createRepository(
        db,
        adminRow.rows[0]!.id,
        "admin",
        "retained",
      );
      await markRepositoryStatus(db, regularRepo.id, "active");
      await markRepositoryStatus(db, adminRepo.id, "active");
      const tokens = await TokenService.create(config, db);
      const deleted: string[] = [];
      const result = await runRegularRepositoryCleanup(
        db,
        {
          deleteRepository: async (repositoryId: string) => {
            deleted.push(repositoryId);
          },
        } as never,
        tokens,
      );
      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(deleted).toEqual([regularRepo.id]);
      expect(await findRepositoryById(db, regularRepo.id)).toBeNull();
      expect(await findRepositoryById(db, adminRepo.id)).not.toBeNull();
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects new repositories when logical size exceeds the limit", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-size-quota-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    try {
      await migrate(db);
      const regularId = await insertUser(db, "member");
      const regular = await findUserById(db, regularId);
      await writeQuotaSettings(db, {
        enabled: true,
        maxRepositories: 1,
        maxSizeBytes: 5 * 1024 * 1024,
        importMaxBytes: 5 * 1024 * 1024,
        cleanupHours: 24,
      });
      const repository = await createRepository(
        db,
        regularId,
        "member",
        "large",
      );
      await markRepositoryStatus(db, repository.id, "active");
      await writeQuotaSettings(db, {
        enabled: true,
        maxRepositories: 2,
        maxSizeBytes: 5 * 1024 * 1024,
        importMaxBytes: 5 * 1024 * 1024,
        cleanupHours: 0,
      });
      const tokens = await TokenService.create(config, db);
      await expect(
        assertPersonalRepositoryQuota({
          db,
          lore: {
            getRepositorySnapshot: async () => ({
              sizeBytes: 6 * 1024 * 1024,
              latestRevision: "",
              lastCommitAt: 0,
            }),
          } as never,
          tokens,
          user: regular!,
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: {
          limit: 5 * 1024 * 1024,
          used: 6 * 1024 * 1024,
        },
      });
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects Git imports larger than the regular-user import limit", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-import-quota-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      const regularId = await insertUser(db, "member");
      const regular = await findUserById(db, regularId);
      await writeQuotaSettings(db, {
        enabled: true,
        maxRepositories: 1,
        maxSizeBytes: 5 * 1024 * 1024,
        importMaxBytes: 5 * 1024 * 1024,
        cleanupHours: 24,
      });
      await expect(
        assertRegularUserImportQuota(
          db,
          regular!,
          5 * 1024 * 1024 + 1,
        ),
      ).rejects.toMatchObject({
        code: "bad_request",
        details: { limit: 5 * 1024 * 1024 },
      });
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a BranchPush that would exceed personal repository storage", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-push-quota-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    try {
      await migrate(db);
      const regularId = await insertUser(db, "member");
      const regular = await findUserById(db, regularId);
      await writeQuotaSettings(db, {
        enabled: true,
        maxRepositories: 1,
        maxSizeBytes: 5 * 1024 * 1024,
        importMaxBytes: 5 * 1024 * 1024,
        cleanupHours: 0,
      });
      const repository = await createRepository(
        db,
        regularId,
        "member",
        "push-limit",
      );
      await markRepositoryStatus(db, repository.id, "active");
      const tokens = await TokenService.create(config, db);

      await expect(
        assertPersonalRepositoryPushQuota({
          db,
          lore: {
            getRevisionSize: async () => 5 * 1024 * 1024 + 1,
            listBranches: async () => [
              { id: repository.defaultBranchId, name: "main" },
            ],
          } as never,
          tokens,
          user: regular!,
          repository,
          revisionSignature: "a".repeat(64),
          branchId: repository.defaultBranchId,
          fastForwardMerge: false,
          token: "repository-token",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: {
          limit: 5 * 1024 * 1024,
          used: 5 * 1024 * 1024 + 1,
          repositoryId: repository.id,
        },
      });

      await expect(
        assertPersonalRepositoryPushQuota({
          db,
          lore: {
            getRevisionSize: async () => 5 * 1024 * 1024,
            listBranches: async () => [
              { id: repository.defaultBranchId, name: "main" },
            ],
          } as never,
          tokens,
          user: regular!,
          repository,
          revisionSignature: "a".repeat(64),
          branchId: repository.defaultBranchId,
          fastForwardMerge: false,
          token: "repository-token",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("counts every live branch in the personal repository quota", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-branch-quota-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    try {
      await migrate(db);
      const regularId = await insertUser(db, "member");
      const regular = await findUserById(db, regularId);
      await writeQuotaSettings(db, {
        enabled: true,
        maxRepositories: 1,
        maxSizeBytes: 5 * 1024 * 1024,
        importMaxBytes: 5 * 1024 * 1024,
        cleanupHours: 0,
      });
      const repository = await createRepository(
        db,
        regularId,
        "member",
        "multi-branch",
      );
      await markRepositoryStatus(db, repository.id, "active");
      const tokens = await TokenService.create(config, db);
      const featureBranchId = newId();
      let proposedBytes = 3 * 1024 * 1024;

      await expect(
        assertPersonalRepositoryPushQuota({
          db,
          lore: {
            getRevisionSize: async () => proposedBytes,
            listBranches: async () => [
              { id: repository.defaultBranchId, name: "main" },
              { id: featureBranchId, name: "feature" },
            ],
            getRevisionTree: async (input: { branchId: string }) => {
              expect(input.branchId).toBe(featureBranchId);
              return [{ type: "directory", path: "src", size: 3 * 1024 * 1024 }];
            },
          } as never,
          tokens,
          user: regular!,
          repository,
          revisionSignature: "a".repeat(64),
          branchId: repository.defaultBranchId,
          fastForwardMerge: false,
          token: "repository-token",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: {
          limit: 5 * 1024 * 1024,
          used: 6 * 1024 * 1024,
          repositoryId: repository.id,
        },
      });

      proposedBytes = 0;
      await expect(
        assertPersonalRepositoryPushQuota({
          db,
          lore: {
            getRevisionSize: async () => proposedBytes,
            listBranches: async () => [
              { id: repository.defaultBranchId, name: "main" },
              { id: featureBranchId, name: "feature" },
            ],
            getRevisionTree: async () => [
              { type: "directory", path: "src", size: 3 * 1024 * 1024 },
            ],
          } as never,
          tokens,
          user: regular!,
          repository,
          revisionSignature: "b".repeat(64),
          branchId: repository.defaultBranchId,
          fastForwardMerge: false,
          token: "repository-token",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function insertUser(
  db: ReturnType<typeof createDatabase>,
  username: string,
): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO users
       (id, email, username, display_name, password_hash, global_role,
        status, email_verified_at)
     VALUES ($1, $2, $3, $3, 'test', 'user', 'active',
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    [id, `${username}@example.com`, username],
  );
  return id;
}

async function createRepository(
  db: ReturnType<typeof createDatabase>,
  userId: string,
  username: string,
  slug: string,
) {
  return createPendingRepository(db, {
    organizationId: null,
    ownerUserId: userId,
    organizationSlug: username,
    slug,
    description: "",
    userId,
  });
}
