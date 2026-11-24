import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { SessionService } from "../src/auth/session.ts";
import { TokenService } from "../src/auth/token-service.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";
import type { SmtpSettings } from "../src/mail-settings.ts";

describe("system settings", () => {
  it("defaults registration on and enforces the administrator toggle", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-settings-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
      OIDC_KEY_DIR: path.join(directory, "keys"),
      LORE_RUNTIME_CONFIG_PATH: path.join(directory, "config", "local.toml"),
      SMTP_URL: "",
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    let testedSmtp: SmtpSettings | undefined;
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      await TokenService.create(config, db);
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const browserSession = await new SessionService(db, config).create(
        admin.rows[0]!.id,
      );
      app = await buildApp({
        config,
        db,
        lore: {},
        session: new SessionService(db, config),
        tokens: {},
        oauth: {},
        mailer: { send: async () => {} },
        smtpVerifier: async (settings: SmtpSettings) => {
          testedSmtp = settings;
        },
        logger: false,
      } as never);
      const headers = {
        cookie: `lore_portal_session=${browserSession.token}`,
      };

      const initial = await app.inject({
        method: "GET",
        url: "/api/v1/admin/settings",
        headers,
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({
        userRegistrationEnabled: true,
        userInvitationsEnabled: false,
        regularUserQuotaEnabled: false,
        regularUserMaxRepositories: 1,
        regularUserMaxSizeBytes: 5 * 1024 * 1024,
        regularUserImportMaxBytes: 5 * 1024 * 1024,
        regularUserRepositoryCleanupHours: 24,
        loginAnnouncement: "",
      });

      const systemInfo = await app.inject({
        method: "GET",
        url: "/api/v1/admin/system-info",
        headers,
      });
      expect(systemInfo.statusCode).toBe(200);
      expect(systemInfo.json()).toEqual({
        deploymentMode: "local",
        webPublicUrl: "http://localhost:3000",
        lorePublicUrl: "lore://localhost:3000",
        loreReady: true,
        loreStoreMaxSizeBytes: 80_530_636_800,
        loreStoreCompactionDelayMs: 172_800_000,
      });

      mkdirSync(path.dirname(config.loreRuntimeConfigPath), {
        recursive: true,
      });
      writeFileSync(
        config.loreRuntimeConfigPath,
        `[immutable_store.local]
max_size = 68719476736
compaction_delay = 86400000
`,
      );
      const customSystemInfo = await app.inject({
        method: "GET",
        url: "/api/v1/admin/system-info",
        headers,
      });
      expect(customSystemInfo.json()).toMatchObject({
        loreStoreMaxSizeBytes: 68_719_476_736,
        loreStoreCompactionDelayMs: 86_400_000,
      });

      const unauthenticatedSystemInfo = await app.inject({
        method: "GET",
        url: "/api/v1/admin/system-info",
      });
      expect(unauthenticatedSystemInfo.statusCode).toBe(401);

      const initialSmtp = await app.inject({
        method: "GET",
        url: "/api/v1/admin/smtp",
        headers,
      });
      expect(initialSmtp.statusCode).toBe(200);
      expect(initialSmtp.json()).toMatchObject({
        settings: {
          enabled: false,
          port: 587,
          security: "ssl",
          password: "",
        },
        hasPassword: false,
      });

      const savedSmtp = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/smtp",
        headers,
        payload: {
          enabled: true,
          host: "smtp.example.com",
          port: 465,
          security: "ssl",
          username: "mailer@example.com",
          password: "smtp-secret",
          fromName: "Lore",
          fromEmail: "mailer@example.com",
        },
      });
      expect(savedSmtp.statusCode).toBe(200);
      expect(savedSmtp.json()).toMatchObject({
        settings: {
          enabled: true,
          host: "smtp.example.com",
          port: 465,
          security: "ssl",
          username: "mailer@example.com",
          password: "",
        },
        hasPassword: true,
      });
      expect(savedSmtp.body).not.toContain("smtp-secret");

      const smtpTest = await app.inject({
        method: "POST",
        url: "/api/v1/admin/smtp/test",
        headers,
        payload: {
          enabled: true,
          host: "smtp.example.com",
          port: 465,
          security: "ssl",
          username: "mailer@example.com",
          password: "",
          fromName: "Lore",
          fromEmail: "mailer@example.com",
          recipientEmail: "recipient@example.com",
        },
      });
      expect(smtpTest.statusCode).toBe(200);
      expect(testedSmtp?.password).toBe("smtp-secret");

      const disabled = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/settings",
        headers,
        payload: {
          userRegistrationEnabled: false,
          userInvitationsEnabled: false,
          regularUserQuotaEnabled: false,
          regularUserMaxRepositories: 1,
          regularUserMaxSizeBytes: 5 * 1024 * 1024,
          regularUserImportMaxBytes: 5 * 1024 * 1024,
          regularUserRepositoryCleanupHours: 24,
          loginAnnouncement: "Scheduled maintenance at 22:00.",
        },
      });
      expect(disabled.statusCode).toBe(200);
      const publicMeta = (
        await app.inject({
          method: "GET",
          url: "/api/v1/meta",
        })
      ).json();
      expect(publicMeta.userRegistrationEnabled).toBe(false);
      expect(publicMeta.loginAnnouncement).toBe(
        "Scheduled maintenance at 22:00.",
      );

      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: "closed@example.com",
          username: "closeduser",
          password: "123456",
        },
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().error.message).toBe(
        "User registration is disabled",
      );

      const enabled = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/settings",
        headers,
        payload: {
          userRegistrationEnabled: true,
          userInvitationsEnabled: false,
          regularUserQuotaEnabled: false,
          regularUserMaxRepositories: 1,
          regularUserMaxSizeBytes: 5 * 1024 * 1024,
          regularUserImportMaxBytes: 5 * 1024 * 1024,
          regularUserRepositoryCleanupHours: 24,
          loginAnnouncement: "Scheduled maintenance at 22:00.",
        },
      });
      expect(enabled.statusCode).toBe(200);
      const registered = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: "open@example.com",
          username: "openuser",
          password: "123456",
        },
      });
      expect(registered.statusCode).toBe(201);
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
