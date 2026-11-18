import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@lore-portal/shared";
import { buildApp } from "../src/app.ts";
import { SessionService } from "../src/auth/session.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";
import {
  addOrganizationMember,
  createOrganization,
} from "../src/organizations.ts";
import { findUserById } from "../src/auth/users.ts";

describe("organization membership and lifecycle", () => {
  it("enforces leave, ownership transfer, and empty-organization deletion rules", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-org-test-"));
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
      const admin = (await findUserById(db, adminRow.rows[0]!.id))!;
      const aliceId = newId();
      const bobId = newId();
      for (const user of [
        {
          id: aliceId,
          email: "alice@example.com",
          username: "alice",
          displayName: "Alice",
        },
        {
          id: bobId,
          email: "bob@example.com",
          username: "bob",
          displayName: "Bob",
        },
      ]) {
        await db.query(
          `INSERT INTO users
             (id, email, username, display_name, password_hash, global_role, status)
           VALUES ($1, $2, $3, $4, 'unused', 'user', 'active')`,
          [user.id, user.email, user.username, user.displayName],
        );
      }
      const organization = await createOrganization(db, {
        slug: "test-org",
        name: "Test Organization",
        actor: admin,
      });
      await addOrganizationMember(db, {
        organizationId: organization.id,
        userId: aliceId,
        role: "member",
      });
      await addOrganizationMember(db, {
        organizationId: organization.id,
        userId: bobId,
        role: "member",
      });

      const session = new SessionService(db, config);
      const adminSession = await session.create(admin.id);
      const aliceSession = await session.create(aliceId);
      const bobSession = await session.create(bobId);
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
      const cookie = (token: string) => ({
        cookie: `lore_portal_session=${token}`,
      });

      const memberDelete = await app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${organization.id}`,
        headers: cookie(aliceSession.token),
        payload: { confirmation: "test-org" },
      });
      expect(memberDelete.statusCode).toBe(403);

      const memberTransfer = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${organization.id}/owner`,
        headers: cookie(aliceSession.token),
        payload: { userId: bobId },
      });
      expect(memberTransfer.statusCode).toBe(403);

      const transfer = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${organization.id}/owner`,
        headers: cookie(adminSession.token),
        payload: { userId: aliceId },
      });
      expect(transfer.statusCode).toBe(200);
      const roles = await db.query<{ user_id: string; role: string }>(
        `SELECT user_id, role FROM organization_members
          WHERE organization_id = $1
          ORDER BY user_id`,
        [organization.id],
      );
      expect(
        Object.fromEntries(roles.rows.map((row) => [row.user_id, row.role])),
      ).toMatchObject({
        [admin.id]: "admin",
        [aliceId]: "owner",
        [bobId]: "member",
      });

      const adminLeave = await app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${organization.id}/members/me`,
        headers: cookie(adminSession.token),
      });
      expect(adminLeave.statusCode).toBe(403);

      const leave = await app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${organization.id}/members/me`,
        headers: cookie(bobSession.token),
      });
      expect(leave.statusCode).toBe(200);

      await db.query(
        `INSERT INTO repositories
           (id, organization_id, owner_user_id, slug, lore_name,
            default_branch_id, created_by)
         VALUES ($1, $2, NULL, 'owned-repo', 'test-org/owned-repo', $3, $4)`,
        [newId(), organization.id, newId(), admin.id],
      );
      const blockedDelete = await app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${organization.id}`,
        headers: cookie(adminSession.token),
        payload: { confirmation: "test-org" },
      });
      expect(blockedDelete.statusCode).toBe(409);

      await db.query(
        `DELETE FROM repositories WHERE organization_id = $1`,
        [organization.id],
      );
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${organization.id}`,
        headers: cookie(adminSession.token),
        payload: { confirmation: "test-org" },
      });
      expect(deleted.statusCode).toBe(200);
      const remaining = await db.query<{ count: number }>(
        `SELECT count(*) AS count FROM organizations WHERE id = $1`,
        [organization.id],
      );
      expect(Number(remaining.rows[0]?.count)).toBe(0);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
