import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@lore-portal/shared";
import { buildApp } from "../src/app.ts";
import { findUserById } from "../src/auth/users.ts";
import { SessionService } from "../src/auth/session.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";
import type {
  InitializeEmptyRepositoryInput,
  InitializeIgnoreTemplateInput,
} from "../src/lore/template-initializer.ts";
import {
  findRepositoryBySlug,
  LORE_MAIN_BRANCH_ID,
  listAccessibleRepositories,
  listAccessibleRepositoriesWithPermission,
  registerRepositoryFromLore,
  repositoryPermission,
} from "../src/repositories.ts";

describe("repository ownership and deletion", () => {
  it("registers repositories created directly by Lore clients", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-desktop-repo-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const row = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const admin = await findUserById(db, row.rows[0]!.id);
      expect(admin).not.toBeNull();
      const repositoryId = newId();

      const registered = await registerRepositoryFromLore(db, {
        repositoryId,
        name: "admin/desktop-project",
        user: admin!,
      });
      expect(registered).toMatchObject({
        id: repositoryId,
        organizationId: null,
        ownerUserId: admin!.id,
        organizationSlug: "admin",
        slug: "desktop-project",
        name: "admin/desktop-project",
        defaultBranchId: LORE_MAIN_BRANCH_ID,
        defaultBranchName: "main",
        status: "pending",
      });

      const repeated = await registerRepositoryFromLore(db, {
        repositoryId,
        name: "admin/desktop-project",
        user: admin!,
      });
      expect(repeated.id).toBe(repositoryId);
      const grants = await db.query<{ permission: string }>(
        `SELECT permission FROM repository_grants
          WHERE repository_id = $1 AND subject_id = $2`,
        [repositoryId, admin!.id],
      );
      expect(grants.rows).toEqual([{ permission: "admin" }]);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a Lore client repository namespace the user cannot use", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-desktop-repo-denied-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const row = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const admin = await findUserById(db, row.rows[0]!.id);
      await expect(
        registerRepositoryFromLore(db, {
          repositoryId: newId(),
          name: "another-user/not-allowed",
          user: admin!,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a repository directly in the current user's namespace", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-personal-repo-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
    });
    const lore = {
      createRepository: async (input: {
        id: string;
        defaultBranchId: string;
        name: string;
        description: string;
      }) => ({
        id: input.id,
        name: input.name,
        description: input.description,
        defaultBranchId: input.defaultBranchId,
        defaultBranchName: "main",
        creator: "admin",
        created: 0,
      }),
      deleteRepository: async () => {},
    };
    const initializedTemplates: string[] = [];
    const initializedEmptyRepositories: InitializeEmptyRepositoryInput[] = [];
    let initializedAccessToken = "";
    let initializedIdentityToken = "";
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const session = new SessionService(db, config);
      const browserSession = await session.create(admin.rows[0]!.id);
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
        templateInitializer: async (input: InitializeIgnoreTemplateInput) => {
          initializedTemplates.push(input.template);
          initializedAccessToken = input.accessToken;
          initializedIdentityToken = input.identityToken;
        },
        emptyRepositoryInitializer: async (
          input: InitializeEmptyRepositoryInput,
        ) => {
          initializedEmptyRepositories.push(input);
        },
        logger: false,
      } as never);

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/repos",
        headers: {
          cookie: `lore_portal_session=${browserSession.token}`,
        },
        payload: {
          slug: "personal-project",
          description: "My personal repository",
          ignoreTemplate: "unreal",
        },
      });

      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        organizationId: null,
        ownerUserId: admin.rows[0]!.id,
        organizationSlug: "admin",
        slug: "personal-project",
        name: "admin/personal-project",
        description: "My personal repository",
        status: "active",
      });
      expect(initializedTemplates).toEqual(["unreal"]);
      expect(initializedAccessToken).toBe("repository-token");
      expect(initializedIdentityToken).toBe("login-token");

      const createdEmpty = await app.inject({
        method: "POST",
        url: "/api/v1/repos",
        headers: {
          cookie: `lore_portal_session=${browserSession.token}`,
        },
        payload: {
          slug: "empty-project",
          description: "An empty repository",
        },
      });

      expect(createdEmpty.statusCode).toBe(200);
      expect(createdEmpty.json()).toMatchObject({
        slug: "empty-project",
        name: "admin/empty-project",
        status: "active",
      });
      expect(initializedEmptyRepositories).toEqual([
        expect.objectContaining({
          repositoryName: "admin/empty-project",
          identityToken: "login-token",
          accessToken: "repository-token",
        }),
      ]);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists and authorizes a repository owned directly by a user", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-owner-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const created = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const adminId = created.rows[0]!.id;
      const admin = await findUserById(db, adminId);
      expect(admin).not.toBeNull();
      await db.query(
        `INSERT INTO repositories
           (id, organization_id, owner_user_id, slug, lore_name,
            default_branch_id, created_by)
         VALUES ($1, NULL, $2, 'personal', 'legacy/personal', $3, $2)`,
        [newId(), adminId, newId()],
      );

      const repositories = await listAccessibleRepositories(db, admin!);
      expect(repositories).toHaveLength(1);
      expect(repositories[0]).toMatchObject({
        organizationId: null,
        ownerUserId: adminId,
        organizationSlug: "admin",
        slug: "personal",
        name: "legacy/personal",
      });
      const repository = await findRepositoryBySlug(db, "admin", "personal");
      expect(repository?.id).toBe(repositories[0]!.id);
      expect(await repositoryPermission(db, admin!, repository!)).toBe("admin");
      const organizations = await db.query<{ count: number }>(
        `SELECT count(*) AS count FROM organizations`,
      );
      expect(Number(organizations.rows[0]?.count)).toBe(0);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds repository size and latest commit time, newest first", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-repo-summary-test-"));
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
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const adminId = admin.rows[0]!.id;
      const olderId = newId();
      const newerId = newId();
      await db.query(
        `INSERT INTO repositories
           (id, organization_id, owner_user_id, slug, lore_name,
            default_branch_id, created_by, status)
         VALUES ($1, NULL, $3, 'older', 'admin/older', $2, $3, 'active'),
                ($4, NULL, $3, 'newer', 'admin/newer', $2, $3, 'active')`,
        [olderId, newId(), adminId, newerId],
      );
      const session = new SessionService(db, config);
      const browserSession = await session.create(adminId);
      app = await buildApp({
        config,
        db,
        lore: {
          getRepositorySnapshot: async (repositoryId: string) =>
            repositoryId === olderId
              ? {
                  sizeBytes: 1024,
                  latestRevision: "1".repeat(64),
                  lastCommitAt: 1_000,
                }
              : {
                  sizeBytes: 2048,
                  latestRevision: "2".repeat(64),
                  lastCommitAt: 2_000,
                },
        },
        session,
        tokens: { signRepositoryToken: async () => "repository-token" },
        oauth: {},
        mailer: { send: async () => {} },
        logger: false,
      } as never);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/repos",
        headers: {
          cookie: `lore_portal_session=${browserSession.token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().repositories).toMatchObject([
        { id: newerId, sizeBytes: 2048, lastCommitAt: 2_000 },
        { id: olderId, sizeBytes: 1024, lastCommitAt: 1_000 },
      ]);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not expose or authorize another user's repository to a global admin", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-admin-repo-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
    });
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const ownerId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role, status)
         VALUES ($1, 'owner@example.com', 'owner', 'Owner',
                 'unused', 'user', 'active')`,
        [ownerId],
      );
      const repositoryId = newId();
      await db.query(
        `INSERT INTO repositories
           (id, organization_id, owner_user_id, slug, lore_name,
            default_branch_id, created_by)
         VALUES ($1, NULL, $2, 'private', 'owner/private', $3, $2)`,
        [repositoryId, ownerId, newId()],
      );
      const adminUser = await findUserById(db, admin.rows[0]!.id);

      expect(await listAccessibleRepositories(db, adminUser!)).toHaveLength(0);
      const hidden = await findRepositoryBySlug(db, "owner", "private");
      expect(
        await repositoryPermission(db, adminUser!, hidden!),
      ).toBeNull();

      await db.query(
        `INSERT INTO repository_grants
           (repository_id, subject_type, subject_id, permission)
         VALUES ($1, 'user', $2, 'read')`,
        [repositoryId, admin.rows[0]!.id],
      );
      expect(await listAccessibleRepositories(db, adminUser!)).toHaveLength(1);
      expect(
        await listAccessibleRepositoriesWithPermission(db, adminUser!),
      ).toMatchObject([
        {
          id: repositoryId,
          organizationSlug: "owner",
          slug: "private",
          permission: "read",
        },
      ]);
      expect(
        await repositoryPermission(db, adminUser!, hidden!),
      ).toBe("read");
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prevents another repository manager from revoking the owner's grant", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-owner-grant-test-"));
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
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const repositoryId = newId();
      await db.query(
        `INSERT INTO repositories
           (id, organization_id, owner_user_id, slug, lore_name,
            default_branch_id, created_by)
         VALUES ($1, NULL, $2, 'owned', 'admin/owned', $3, $2)`,
        [repositoryId, admin.rows[0]!.id, newId()],
      );
      const managerId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role, status)
         VALUES ($1, 'manager@example.com', 'manager', 'Manager',
                 'unused', 'user', 'active')`,
        [managerId],
      );
      await db.query(
        `INSERT INTO repository_grants
           (repository_id, subject_type, subject_id, permission)
         VALUES ($1, 'user', $2, 'admin'), ($1, 'user', $3, 'admin')`,
        [repositoryId, admin.rows[0]!.id, managerId],
      );
      const session = new SessionService(db, config);
      const managerSession = await session.create(managerId);
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

      const deleteAttempt = await app.inject({
        method: "DELETE",
        url: "/api/v1/repos/admin/owned",
        headers: { cookie: `lore_portal_session=${managerSession.token}` },
        payload: { confirmation: "admin/owned" },
      });
      expect(deleteAttempt.statusCode).toBe(403);

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/repos/admin/owned/grants",
        headers: { cookie: `lore_portal_session=${managerSession.token}` },
        payload: {
          subjectType: "user",
          subjectId: admin.rows[0]!.id,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toBe(
        "You cannot revoke the repository owner's grant",
      );
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an exact confirmation and removes the Lore and portal records", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-repo-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
    });
    const deleted: Array<{ repositoryId: string; token: string }> = [];
    const lore = {
      createRepository: async (input: {
        id: string;
        defaultBranchId: string;
        name: string;
        description: string;
      }) => ({
        id: input.id,
        name: input.name,
        description: input.description,
        defaultBranchId: input.defaultBranchId,
        defaultBranchName: "main",
        creator: "admin",
        created: 0,
      }),
      deleteRepository: async (repositoryId: string, token: string) => {
        deleted.push({ repositoryId, token });
      },
    };
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const session = new SessionService(db, config);
      const browserSession = await session.create(admin.rows[0]!.id);
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
        emptyRepositoryInitializer: async () => {},
        logger: false,
      } as never);
      const cookie = `lore_portal_session=${browserSession.token}`;

      const organization = await app.inject({
        method: "POST",
        url: "/api/v1/orgs",
        headers: { cookie },
        payload: { slug: "default", name: "Default" },
      });
      expect(organization.statusCode).toBe(200);

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/repos",
        headers: { cookie },
        payload: {
          organizationId: organization.json().id,
          slug: "delete-me",
          description: "",
        },
      });
      expect(created.statusCode).toBe(200);

      const granteeId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role, status)
         VALUES ($1, 'grantee@example.com', 'grantee', 'Grantee',
                 'unused', 'user', 'active')`,
        [granteeId],
      );
      const selfGrant = await app.inject({
        method: "POST",
        url: "/api/v1/repos/default/delete-me/grants",
        headers: { cookie },
        payload: {
          subjectType: "user",
          subjectId: admin.rows[0]!.id,
          permission: "read",
        },
      });
      expect(selfGrant.statusCode).toBe(409);
      const granted = await app.inject({
        method: "POST",
        url: "/api/v1/repos/default/delete-me/grants",
        headers: { cookie },
        payload: {
          subjectType: "user",
          subjectId: granteeId,
          permission: "read",
        },
      });
      expect(granted.statusCode).toBe(200);
      const revoked = await app.inject({
        method: "DELETE",
        url: "/api/v1/repos/default/delete-me/grants",
        headers: { cookie },
        payload: { subjectType: "user", subjectId: granteeId },
      });
      expect(revoked.statusCode).toBe(200);
      const grants = await db.query<{ count: number }>(
        `SELECT count(*) AS count FROM repository_grants
          WHERE repository_id = $1 AND subject_id = $2`,
        [created.json().id, granteeId],
      );
      expect(Number(grants.rows[0]?.count)).toBe(0);

      const selfRevoke = await app.inject({
        method: "DELETE",
        url: "/api/v1/repos/default/delete-me/grants",
        headers: { cookie },
        payload: {
          subjectType: "user",
          subjectId: admin.rows[0]!.id,
        },
      });
      expect(selfRevoke.statusCode).toBe(409);

      const rejected = await app.inject({
        method: "DELETE",
        url: "/api/v1/repos/default/delete-me",
        headers: { cookie },
        payload: { confirmation: "wrong" },
      });
      expect(rejected.statusCode).toBe(400);
      expect(deleted).toHaveLength(0);

      const removed = await app.inject({
        method: "DELETE",
        url: "/api/v1/repos/default/delete-me",
        headers: { cookie },
        payload: { confirmation: "default/delete-me" },
      });
      expect(removed.statusCode).toBe(200);
      expect(deleted).toEqual([
        {
          repositoryId: created.json().id,
          token: "repository-token",
        },
      ]);
      const remaining = await db.query<{ count: number }>(
        `SELECT count(*) AS count FROM repositories`,
      );
      expect(Number(remaining.rows[0]?.count)).toBe(0);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
