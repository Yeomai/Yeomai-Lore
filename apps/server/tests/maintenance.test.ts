import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";
import { runMaintenanceCleanup } from "../src/maintenance.ts";

const now = new Date("2026-11-12T12:00:00.000Z");
const twoDaysAgo = "2026-11-10T12:00:00.000Z";
const fortyDaysAgo = "2026-10-03T12:00:00.000Z";
const tomorrow = "2026-11-13T12:00:00.000Z";

describe("maintenance cleanup", () => {
  it("removes only expired, revoked, or used authentication and invite records", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-maintenance-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        OIDC_KEY_DIR: path.join(directory, "keys"),
      });
      await migrate(db);
      await seedInitialAdmin(db, config);
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const userId = admin.rows[0]!.id;
      await db.query(
        `INSERT INTO organizations (id, slug, name, created_by)
         VALUES ('maintenance-org', 'maintenance-org', 'Maintenance', $1)`,
        [userId],
      );

      await db.query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at)
         VALUES
           ('expired-session', $1, 'session-expired', $2, NULL),
           ('old-revoked-session', $1, 'session-revoked', $3, $4),
           ('active-session', $1, 'session-active', $3, NULL)`,
        [userId, twoDaysAgo, tomorrow, fortyDaysAgo],
      );
      await db.query(
        `INSERT INTO oauth_device_codes
           (device_code_hash, user_code_hash, client_id, expires_at)
         VALUES
           ('expired-device', 'device-expired', 'lore-cli', $1),
           ('active-device', 'device-active', 'lore-cli', $2)`,
        [twoDaysAgo, tomorrow],
      );
      await db.query(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, user_id, client_id, expires_at, revoked_at)
         VALUES
           ('expired-refresh', $1, 'lore-cli', $2, NULL),
           ('old-revoked-refresh', $1, 'lore-cli', $3, $4),
           ('active-refresh', $1, 'lore-cli', $3, NULL)`,
        [userId, twoDaysAgo, tomorrow, fortyDaysAgo],
      );
      await db.query(
        `INSERT INTO password_resets
           (id, user_id, token_hash, expires_at, used_at)
         VALUES
           ('expired-reset', $1, 'reset-expired', $2, NULL),
           ('old-used-reset', $1, 'reset-used', $3, $4),
           ('active-reset', $1, 'reset-active', $3, NULL)`,
        [userId, twoDaysAgo, tomorrow, fortyDaysAgo],
      );
      await db.query(
        `INSERT INTO invites
           (id, email, token_hash, organization_id, organization_role,
            invited_by, expires_at, accepted_at)
         VALUES
           ('expired-invite', 'expired@example.com', 'expired-invite-token',
            'maintenance-org', 'member', $1, $2, NULL),
           ('accepted-invite', 'accepted@example.com', 'accepted-invite-token',
            'maintenance-org', 'member', $1, $2, $3),
           ('active-invite', 'active@example.com', 'active-invite-token',
            'maintenance-org', 'member', $1, $4, NULL)`,
        [userId, twoDaysAgo, fortyDaysAgo, tomorrow],
      );
      await db.query(
        `INSERT INTO audit_events
           (id, actor_user_id, action, target_type, target_id, created_at)
         VALUES
           ('old-audit', $1, 'test.old', 'test', 'old', $2),
           ('recent-audit', $1, 'test.recent', 'test', 'recent', $3)`,
        [userId, fortyDaysAgo, twoDaysAgo],
      );

      const result = await runMaintenanceCleanup(db, now);

      expect(result).toEqual({
        sessions: 2,
        deviceCodes: 1,
        refreshTokens: 2,
        resets: 2,
        invites: 1,
        auditEvents: 1,
      });

      const sessions = await db.query<{ id: string }>(
        "SELECT id FROM sessions ORDER BY id",
      );
      expect(sessions.rows.map((row) => row.id)).toEqual(["active-session"]);

      const devices = await db.query<{ device_code_hash: string }>(
        "SELECT device_code_hash FROM oauth_device_codes",
      );
      expect(devices.rows.map((row) => row.device_code_hash)).toEqual([
        "active-device",
      ]);

      const refreshes = await db.query<{ token_hash: string }>(
        "SELECT token_hash FROM oauth_refresh_tokens",
      );
      expect(refreshes.rows.map((row) => row.token_hash)).toEqual([
        "active-refresh",
      ]);

      const resets = await db.query<{ id: string }>(
        "SELECT id FROM password_resets",
      );
      expect(resets.rows.map((row) => row.id)).toEqual(["active-reset"]);

      const invites = await db.query<{ id: string }>(
        "SELECT id FROM invites ORDER BY id",
      );
      expect(invites.rows.map((row) => row.id)).toEqual([
        "accepted-invite",
        "active-invite",
      ]);

      const auditEvents = await db.query<{ id: string }>(
        "SELECT id FROM audit_events ORDER BY id",
      );
      expect(auditEvents.rows.map((row) => row.id)).toEqual([
        "recent-audit",
      ]);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
