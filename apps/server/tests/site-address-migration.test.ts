import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrateLegacyUnifiedAddress } from "../src/setup.ts";

describe("unified site address migration", () => {
  it.each([
    [
      "https://lore-web.example.com",
      "lores://lore-server.example.com",
      "https://lore-server.example.com",
      "lores://lore-server.example.com",
    ],
    [
      "https://lore.example.com:8443",
      "lores://old-lore.example.com:443",
      "https://old-lore.example.com:8443",
      "lores://old-lore.example.com:8443",
    ],
    [
      "http://localhost:3000",
      "lore://localhost:41337",
      "http://localhost:3000",
      "lore://localhost:3000",
    ],
  ])(
    "converts %s and %s to one Lore host",
    async (webPublicUrl, lorePublicUrl, expectedWeb, expectedLore) => {
      const directory = mkdtempSync(
        path.join(tmpdir(), "lore-site-address-test-"),
      );
      const db = createDatabase(path.join(directory, "portal.sqlite"));
      try {
        await migrate(db);
        await db.query(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ('web_public_url', $1, CURRENT_TIMESTAMP),
                  ('lore_public_url', $2, CURRENT_TIMESTAMP)`,
          [webPublicUrl, lorePublicUrl],
        );

        await expect(migrateLegacyUnifiedAddress(db)).resolves.toMatchObject({
          previousWebPublicUrl: webPublicUrl,
          webPublicUrl: expectedWeb,
          previousLorePublicUrl: lorePublicUrl,
          lorePublicUrl: expectedLore,
        });
        await expect(migrateLegacyUnifiedAddress(db)).resolves.toBeNull();

        const result = await db.query<{ key: string; value: string }>(
          `SELECT key, value FROM system_settings
            WHERE key IN ('web_public_url', 'lore_public_url')
            ORDER BY key`,
        );
        expect(result.rows).toEqual([
          { key: "lore_public_url", value: expectedLore },
          { key: "web_public_url", value: expectedWeb },
        ]);
        const migration = await db.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = $1",
          ["site_addresses_unified_v2"],
        );
        expect(migration.rows).toHaveLength(1);
      } finally {
        await db.end();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("invalidates authentication created for the legacy address", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "lore-site-address-auth-test-"),
    );
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash)
         VALUES ('user-1', 'user@example.com', 'user', 'User', 'hash')`,
      );
      await db.query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES ('session-1', 'user-1', 'session-hash', '2099-01-01T00:00:00Z')`,
      );
      await db.query(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, user_id, client_id, expires_at)
         VALUES ('oauth-hash', 'user-1', 'lore-cli', '2099-01-01T00:00:00Z')`,
      );
      await db.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ('web_public_url', 'https://lore.example.com', CURRENT_TIMESTAMP),
                ('lore_public_url', 'lores://old-lore.example.com', CURRENT_TIMESTAMP)`,
      );

      await expect(migrateLegacyUnifiedAddress(db)).resolves.toMatchObject({
        revokedSessions: 1,
        revokedOAuthTokens: 1,
        invalidatedUsers: 1,
      });

      const user = await db.query<{ oauth_epoch: number }>(
        "SELECT oauth_epoch FROM users WHERE id = 'user-1'",
      );
      const session = await db.query<{ revoked_at: string | null }>(
        "SELECT revoked_at FROM sessions WHERE id = 'session-1'",
      );
      const token = await db.query<{ revoked_at: string | null }>(
        "SELECT revoked_at FROM oauth_refresh_tokens WHERE token_hash = 'oauth-hash'",
      );
      expect(user.rows[0]?.oauth_epoch).toBe(1);
      expect(session.rows[0]?.revoked_at).not.toBeNull();
      expect(token.rows[0]?.revoked_at).not.toBeNull();
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores the legacy Lore host after the earlier Web-host migration", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "lore-site-address-v1-test-"),
    );
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      await db.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ('web_public_url', 'https://lore-web.example.com', CURRENT_TIMESTAMP),
                ('lore_public_url', 'lores://lore-web.example.com', CURRENT_TIMESTAMP),
                ('legacy_lore_public_url', 'lores://lore-server.example.com', CURRENT_TIMESTAMP)`,
      );

      await expect(migrateLegacyUnifiedAddress(db)).resolves.toMatchObject({
        webPublicUrl: "https://lore-server.example.com",
        lorePublicUrl: "lores://lore-server.example.com",
      });
      const values = await db.query<{ key: string; value: string }>(
        `SELECT key, value FROM system_settings
          WHERE key IN ('web_public_url', 'lore_public_url')
          ORDER BY key`,
      );
      expect(values.rows).toEqual([
        {
          key: "lore_public_url",
          value: "lores://lore-server.example.com",
        },
        {
          key: "web_public_url",
          value: "https://lore-server.example.com",
        },
      ]);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses an external migration without a matching certificate", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "lore-site-address-cert-test-"),
    );
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      await db.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ('web_public_url', 'https://lore.example.com', CURRENT_TIMESTAMP),
                ('lore_public_url', 'lores://old-lore.example.com', CURRENT_TIMESTAMP)`,
      );
      const config = loadConfig({
        NODE_ENV: "test",
        APP_PUBLIC_URL: "https://lore.example.com",
        LORE_PUBLIC_URL: "lores://old-lore.example.com",
        LORE_INTERNAL_URL: "lore://localhost:41337",
        LORE_QUIC_TLS_CERT_FILE: path.join(directory, "missing.crt"),
        LORE_QUIC_TLS_KEY_FILE: path.join(directory, "missing.key"),
        DATABASE_PATH: path.join(directory, "portal.sqlite"),
        OIDC_KEY_DIR: path.join(directory, "keys"),
        LORE_RUNTIME_CONFIG_PATH: path.join(directory, "config", "local.toml"),
        LORE_STORAGE_PATH: path.join(directory, "lore"),
      });

      await expect(migrateLegacyUnifiedAddress(db, config)).rejects.toThrow(
        "requires a readable certificate",
      );
      const lore = await db.query<{ value: string }>(
        "SELECT value FROM system_settings WHERE key = 'lore_public_url'",
      );
      expect(lore.rows[0]?.value).toBe("lores://old-lore.example.com");
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
