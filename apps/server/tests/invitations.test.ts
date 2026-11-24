import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "@lore-portal/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { hashPassword } from "../src/auth/password.ts";
import { SessionService } from "../src/auth/session.ts";
import { TokenService } from "../src/auth/token-service.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";

describe("platform invitations", () => {
  it("lets administrators manage all links and optionally lets users invite", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-invites-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
      OIDC_KEY_DIR: path.join(directory, "keys"),
      SMTP_URL: "smtp://mailer:secret@smtp.example.com:587",
    });
    const session = new SessionService(db, config);
    const sentEmails: Array<{
      to: string;
      subject: string;
      text?: string;
      html?: string;
    }> = [];
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      await TokenService.create(config, db);
      const admin = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username = 'admin'",
      );
      const normalId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role,
            status, email_verified_at)
         VALUES ($1, 'member@example.com', 'member', 'Member', $2, 'user',
                 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        [normalId, await hashPassword("123456")],
      );
      const adminCookie = `lore_portal_session=${
        (await session.create(admin.rows[0]!.id)).token
      }`;
      const memberCookie = `lore_portal_session=${
        (await session.create(normalId)).token
      }`;
      app = await buildApp({
        config,
        db,
        lore: {},
        session,
        tokens: {},
        oauth: {},
        mailer: {
          send: async (
            to: string,
            subject: string,
            body: { text?: string; html?: string },
          ) => {
            sentEmails.push({
              to,
              subject,
              ...body,
            });
          },
        },
        logger: false,
      } as never);
      await db.query(
        `INSERT INTO organizations (id, slug, name, created_by)
         VALUES ($1, 'visible-team', 'Visible Team', $3),
                ($2, 'secret-team', 'Secret Team', $3)`,
        [newId(), newId(), admin.rows[0]!.id],
      );

      const inviteColumns = await db.query<{
        name: string;
        notnull: number;
      }>("PRAGMA table_info(invites)");
      expect(
        inviteColumns.rows.find(
          (column) => column.name === "organization_id",
        )?.notnull,
      ).toBe(0);

      const adminInvite = await app.inject({
        method: "POST",
        url: "/api/v1/admin/invites",
        headers: { cookie: adminCookie },
        payload: { email: "admin-invite@example.com" },
      });
      expect(adminInvite.statusCode).toBe(200);
      expect(adminInvite.json().emailSent).toBe(true);
      const adminInviteUrl = adminInvite.json().inviteUrl as string;
      const inviteToken = new URL(adminInviteUrl).searchParams.get("token");
      expect(sentEmails[0]).toMatchObject({
        to: "admin-invite@example.com",
        subject: "Lore邀请",
      });
      expect(sentEmails[0]?.text).toBeUndefined();
      expect(sentEmails[0]?.html).toContain(
        `<a href="${adminInviteUrl}">${adminInviteUrl}</a>`,
      );
      const inviteValidation = await app.inject({
        method: "GET",
        url: `/api/v1/auth/invite?token=${encodeURIComponent(inviteToken!)}`,
      });
      expect(inviteValidation.statusCode).toBe(200);
      expect(inviteValidation.body).not.toContain("Visible Team");
      expect(inviteValidation.body).not.toContain("Secret Team");

      const disabledInvite = await app.inject({
        method: "POST",
        url: "/api/v1/admin/invites",
        headers: { cookie: memberCookie },
        payload: { email: "disabled@example.com" },
      });
      expect(disabledInvite.statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/meta",
          })
        ).json().userInvitationsEnabled,
      ).toBe(false);

      const enabled = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/settings",
        headers: { cookie: adminCookie },
        payload: {
          userRegistrationEnabled: true,
          userInvitationsEnabled: true,
          regularUserQuotaEnabled: false,
          regularUserMaxRepositories: 1,
          regularUserMaxSizeBytes: 5 * 1024 * 1024,
          regularUserImportMaxBytes: 5 * 1024 * 1024,
          regularUserRepositoryCleanupHours: 24,
          loginAnnouncement: "",
        },
      });
      expect(enabled.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/meta",
          })
        ).json().userInvitationsEnabled,
      ).toBe(true);

      const memberInvite = await app.inject({
        method: "POST",
        url: "/api/v1/admin/invites",
        headers: { cookie: memberCookie },
        payload: { email: "member-invite@example.com" },
      });
      expect(memberInvite.statusCode).toBe(200);
      expect(
        (await app.inject({
          method: "GET",
          url: "/api/v1/admin/invites",
          headers: { cookie: adminCookie },
        })).json().invites,
      ).toHaveLength(2);
      const memberInvites = await app.inject({
        method: "GET",
        url: "/api/v1/admin/invites",
        headers: { cookie: memberCookie },
      });
      expect(memberInvites.json().invites).toHaveLength(1);
      expect(memberInvites.json().invites[0].email).toBe(
        "member-invite@example.com",
      );

      const revokedOther = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/invites/${
          (await app.inject({
            method: "GET",
            url: "/api/v1/admin/invites",
            headers: { cookie: adminCookie },
          })).json().invites.find(
            (invite: { email: string }) =>
              invite.email === "admin-invite@example.com",
          ).id
        }`,
        headers: { cookie: memberCookie },
      });
      expect(revokedOther.statusCode).toBe(404);

      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/auth/accept-invite",
        payload: {
          token: inviteToken,
          username: "invited-user",
          displayName: "Invited User",
          password: "123456",
        },
      });
      expect(accepted.statusCode).toBe(200);
      const memberships = await db.query<{ count: number }>(
        "SELECT count(*) AS count FROM organization_members",
      );
      expect(Number(memberships.rows[0]?.count)).toBe(0);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
