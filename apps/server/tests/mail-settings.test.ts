import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TokenService } from "../src/auth/token-service.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  applySmtpSettings,
  hasSmtpPassword,
  readSmtpSettings,
  saveSmtpSettings,
} from "../src/mail-settings.ts";

describe("SMTP settings", () => {
  it("persists an encrypted password and applies the mail transport", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-smtp-test-"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
      SMTP_URL: "",
    });
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      await TokenService.create(config, db);
      expect((await readSmtpSettings(db)).security).toBe("ssl");
      await saveSmtpSettings(db, config, {
        enabled: true,
        host: "smtp.example.com",
        port: 465,
        security: "ssl",
        username: "mailer@example.com",
        password: "smtp-secret",
        fromName: "Lore",
        fromEmail: "noreply@example.com",
      });

      const stored = await db.query<{ value: string }>(
        `SELECT value FROM system_settings
          WHERE key = 'smtp_password_ciphertext'`,
      );
      expect(stored.rows[0]?.value).not.toContain("smtp-secret");

      config.smtpUrl = undefined;
      config.smtpFrom = "";
      await applySmtpSettings(db, config);
      expect(config.smtpUrl).toBe(
        "smtps://mailer%40example.com:smtp-secret@smtp.example.com:465",
      );
      expect(config.smtpFrom).toBe("Lore <noreply@example.com>");
      expect(await readSmtpSettings(db)).toMatchObject({
        enabled: true,
        host: "smtp.example.com",
        port: 465,
        security: "ssl",
        username: "mailer@example.com",
        fromName: "Lore",
        fromEmail: "noreply@example.com",
      });
      expect(await hasSmtpPassword(db)).toBe(true);

      await saveSmtpSettings(
        db,
        config,
        {
          enabled: true,
          host: "smtp.example.com",
          port: 465,
          security: "ssl",
          username: "mailer@example.com",
          password: "",
          fromName: "Lore",
          fromEmail: "noreply@example.com",
        },
        true,
      );
      expect(await hasSmtpPassword(db)).toBe(true);
      config.smtpUrl = undefined;
      await applySmtpSettings(db, config);
      expect(config.smtpUrl).toContain("smtp-secret");

      await saveSmtpSettings(db, config, {
        enabled: false,
        host: "",
        port: 587,
        security: "starttls",
        username: "",
        password: "",
        fromName: "",
        fromEmail: "",
      });
      await applySmtpSettings(db, config);
      expect(config.smtpUrl).toBeUndefined();
      expect(config.smtpFrom).toBe("");
      expect(await hasSmtpPassword(db)).toBe(false);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
