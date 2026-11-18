import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@lore-portal/shared";
import { hashPassword, verifyPassword } from "../src/auth/password.ts";
import { hashToken } from "../src/auth/random.ts";
import { SessionService } from "../src/auth/session.ts";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";

describe("built-in authentication", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("registers once and logs in with either email or username", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-register-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      const config = loadConfig({
        NODE_ENV: "test",
        APP_PUBLIC_URL: "http://localhost:3000",
        API_INTERNAL_URL: "http://localhost:4000",
      });
      await seedInitialAdmin(db, config);
      const app = await buildApp({
        config,
        db,
        lore: {},
        session: new SessionService(db, config),
        tokens: {},
        oauth: {},
        mailer: { send: async () => {} },
        logger: false,
      } as never);
      apps.push(app);

      const registration = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: "alice@example.com",
          username: "alice",
          password: "123456",
        },
      });
      expect(registration.statusCode).toBe(201);

      for (const identifier of ["alice", "alice@example.com"]) {
        const login = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { identifier, password: "123456" },
        });
        expect(login.statusCode).toBe(200);
      }
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts and verifies the six-character default password", async () => {
    const passwordHash = await hashPassword("123456");
    expect(await verifyPassword(passwordHash, "123456")).toBe(true);
  });

  it("reports a revoked invitation as invalid before rendering its form", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-invite-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      const config = loadConfig({
        NODE_ENV: "test",
        APP_PUBLIC_URL: "http://localhost:3000",
        API_INTERNAL_URL: "http://localhost:4000",
      });
      await seedInitialAdmin(db, config);
      const app = await buildApp({
        config,
        db,
        lore: {},
        session: new SessionService(db, config),
        tokens: {},
        oauth: {},
        mailer: { send: async () => {} },
        logger: false,
      } as never);
      apps.push(app);
      const token = "revoked-invitation-token-with-enough-length";
      await db.query(
        `INSERT INTO organizations (id, slug, name, created_by)
         SELECT 'invite-org', 'invite-org', 'Invite Org', id
           FROM users WHERE lower(username) = 'admin'`,
      );
      await db.query(
        `INSERT INTO invites
           (id, email, token_hash, organization_id, organization_role,
            invited_by, expires_at)
         SELECT 'invite-id', 'invitee@example.com', $1, 'invite-org',
                'member', id, '2099-01-01T00:00:00.000Z'
           FROM users WHERE lower(username) = 'admin'`,
        [hashToken(token)],
      );

      const valid = await app.inject({
        method: "GET",
        url: `/api/v1/auth/invite?token=${encodeURIComponent(token)}`,
      });
      expect(valid.statusCode).toBe(200);

      await db.query("DELETE FROM invites WHERE id = 'invite-id'");
      const revoked = await app.inject({
        method: "GET",
        url: `/api/v1/auth/invite?token=${encodeURIComponent(token)}`,
      });
      expect(revoked.statusCode).toBe(404);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("seeds the administrator without organization membership", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-auth-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      await seedInitialAdmin(
        db,
        loadConfig({
          NODE_ENV: "test",
          APP_PUBLIC_URL: "http://localhost:3000",
          API_INTERNAL_URL: "http://localhost:4000",
        }),
      );
      const user = await db.query<{ global_role: string }>(
        `SELECT global_role FROM users WHERE lower(email) = 'admin@example.com'`,
      );
      expect(user.rows[0]?.global_role).toBe("admin");
      const membership = await db.query<{ count: number }>(
        `SELECT count(*) AS count FROM organization_members`,
      );
      expect(Number(membership.rows[0]?.count)).toBe(0);
      const organizations = await db.query<{ count: number }>(
        `SELECT count(*) AS count FROM organizations`,
      );
      expect(Number(organizations.rows[0]?.count)).toBe(0);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("changes the password and revokes every browser session", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-password-test-"));
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
      const session = new SessionService(db, config);
      const currentSession = await session.create(admin.rows[0]!.id);
      const otherSession = await session.create(admin.rows[0]!.id);
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
        cookie: `lore_portal_session=${currentSession.token}`,
      };

      const wrongPassword = await app.inject({
        method: "PUT",
        url: "/api/v1/auth/password",
        headers,
        payload: {
          oldPassword: "wrong-password",
          newPassword: "654321",
          confirmNewPassword: "654321",
        },
      });
      expect(wrongPassword.statusCode).toBe(400);

      const mismatch = await app.inject({
        method: "PUT",
        url: "/api/v1/auth/password",
        headers,
        payload: {
          oldPassword: "123456",
          newPassword: "654321",
          confirmNewPassword: "654322",
        },
      });
      expect(mismatch.statusCode).toBe(400);

      const changed = await app.inject({
        method: "PUT",
        url: "/api/v1/auth/password",
        headers,
        payload: {
          oldPassword: "123456",
          newPassword: "654321",
          confirmNewPassword: "654321",
        },
      });
      expect(changed.statusCode).toBe(200);
      expect(await session.resolve(currentSession.token)).toBeNull();
      expect(await session.resolve(otherSession.token)).toBeNull();
      const stored = await db.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [admin.rows[0]!.id],
      );
      expect(
        await verifyPassword(stored.rows[0]!.password_hash, "654321"),
      ).toBe(true);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not allow a password reset token to be reused", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-reset-reuse-test-"));
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
      const userId = admin.rows[0]!.id;
      const session = new SessionService(db, config);
      const browserSession = await session.create(userId);
      let resetEmailText = "";
      app = await buildApp({
        config,
        db,
        lore: {},
        session,
        tokens: {},
        oauth: {},
        mailer: {
          send: async (
            _to: string,
            _subject: string,
            body: { text?: string; html?: string },
          ) => {
            resetEmailText = body.text ?? "";
          },
        },
        logger: false,
      } as never);

      const request = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/request",
        payload: { email: "admin@example.com" },
      });
      expect(request.statusCode).toBe(200);
      const token = resetEmailText.match(
        /\/reset-password\?token=([^\s]+)/,
      )?.[1];
      expect(token).toBeTruthy();

      const firstReset = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token, password: "654321" },
      });
      expect(firstReset.statusCode).toBe(200);
      expect(await session.resolve(browserSession.token)).toBeNull();

      const secondReset = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token, password: "new-password" },
      });
      expect(secondReset.statusCode).toBe(404);
      expect(secondReset.json().error.message).toBe(
        "Password reset link is invalid or expired",
      );

      const stored = await db.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [userId],
      );
      expect(await verifyPassword(stored.rows[0]!.password_hash, "654321")).toBe(
        true,
      );
      expect(
        await verifyPassword(stored.rows[0]!.password_hash, "new-password"),
      ).toBe(false);
      const reset = await db.query<{ used_at: string | null }>(
        `SELECT used_at FROM password_resets WHERE token_hash = $1`,
        [hashToken(decodeURIComponent(token!))],
      );
      expect(reset.rows[0]?.used_at).toBeTruthy();
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows same-origin writes through a forwarded host and rejects other origins", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-origin-test-"));
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
      const session = new SessionService(db, config);
      const current = await session.create(admin.rows[0]!.id);
      const other = await session.create(admin.rows[0]!.id);
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

      const sameOrigin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          cookie: `lore_portal_session=${current.token}`,
          origin: "http://127.0.0.1:3000",
          "x-forwarded-host": "127.0.0.1:3000",
        },
      });
      expect(sameOrigin.statusCode).toBe(200);

      const crossOrigin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          cookie: `lore_portal_session=${other.token}`,
          origin: "https://attacker.example",
          "x-forwarded-host": "127.0.0.1:3000",
        },
      });
      expect(crossOrigin.statusCode).toBe(401);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deletes a non-admin account only when it owns no repositories", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-account-delete-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      const userId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role, status)
         VALUES ($1, 'delete@example.com', 'deleteuser', 'Delete User',
                 'unused', 'user', 'active')`,
        [userId],
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

      const wrongConfirmation = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/account",
        headers,
        payload: { confirmation: "delete" },
      });
      expect(wrongConfirmation.statusCode).toBe(400);

      const repositoryId = newId();
      await db.query(
        `INSERT INTO repositories
           (id, organization_id, owner_user_id, slug, lore_name,
            default_branch_id, created_by)
         VALUES ($1, NULL, $2, 'owned', 'deleteuser/owned', $3, $2)`,
        [repositoryId, userId, newId()],
      );
      const blocked = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/account",
        headers,
        payload: { confirmation: "DELETE" },
      });
      expect(blocked.statusCode).toBe(409);

      await db.query(`DELETE FROM repositories WHERE id = $1`, [repositoryId]);
      const deleted = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/account",
        headers,
        payload: { confirmation: "DELETE" },
      });
      expect(deleted.statusCode).toBe(200);
      expect(await session.resolve(browserSession.token)).toBeNull();
      const remaining = await db.query<{ count: number }>(
        `SELECT count(*) AS count FROM users WHERE id = $1`,
        [userId],
      );
      expect(Number(remaining.rows[0]?.count)).toBe(0);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("searches only active users and exposes limited directory fields", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-user-search-test-"));
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
      const aliceId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role, status)
         VALUES ($1, 'alice@example.com', 'alice', 'Alice Example',
                 'unused', 'user', 'active')`,
        [aliceId],
      );
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role, status)
         VALUES ($1, 'disabled@example.com', 'alicedisabled', 'Disabled Alice',
                 'unused', 'user', 'disabled')`,
        [newId()],
      );
      const session = new SessionService(db, config);
      const browserSession = await session.create(admin.rows[0]!.id);
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

      const search = await app.inject({
        method: "GET",
        url: "/api/v1/auth/users/search?q=ali",
        headers: { cookie: `lore_portal_session=${browserSession.token}` },
      });
      expect(search.statusCode).toBe(200);
      expect(search.json()).toEqual({
        users: [
          {
            id: aliceId,
            username: "alice",
            displayName: "Alice Example",
          },
        ],
      });
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
