import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@lore-portal/shared";
import { buildApp } from "../src/app.ts";
import { OAuthService } from "../src/auth/oauth-service.ts";
import { SessionService } from "../src/auth/session.ts";
import { TokenService } from "../src/auth/token-service.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";

describe("OAuth identity management", () => {
  it("requires approval for new device flows and revokes individual sessions", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-device-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
      OIDC_KEY_DIR: path.join(directory, "keys"),
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      await seedInitialAdmin(db, config);
      const admin = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(username) = 'admin'`,
      );
      const session = new SessionService(db, config);
      const browserSession = await session.create(admin.rows[0]!.id);
      const tokens = await TokenService.create(config, db);
      const oauth = new OAuthService(db, config, tokens);
      app = await buildApp({
        config,
        db,
        lore: {},
        session,
        tokens,
        oauth,
        mailer: { send: async () => {} },
        logger: false,
      } as never);
      const headers = {
        cookie: `lore_portal_session=${browserSession.token}`,
        "user-agent": "Lore-Desktop/0.13.0 test-workstation",
      };

      const firstAuthorization = await app.inject({
        method: "POST",
        url: "/oauth/device_authorization",
        headers,
        payload: { client_id: "lore-cli", scope: "openid offline_access" },
      });
      expect(firstAuthorization.statusCode).toBe(200);
      const firstCode = firstAuthorization.json().user_code as string;
      const publicPending = await app.inject({
        method: "GET",
        url: `/api/v1/auth/device/status?user_code=${encodeURIComponent(firstCode)}`,
      });
      expect(publicPending.statusCode).toBe(200);
      expect(publicPending.json()).toMatchObject({
        status: "pending",
        clientId: "lore-cli",
      });

      const bypassApproval = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device/approve",
        payload: { userCode: firstCode },
      });
      expect(bypassApproval.statusCode).toBe(401);

      const pending = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers,
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: firstAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(pending.statusCode).toBe(400);
      expect(pending.json().error).toBe("authorization_pending");

      const approved = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device/approve",
        headers,
        payload: { userCode: firstCode },
      });
      expect(approved.statusCode).toBe(200);
      const publicApproved = await app.inject({
        method: "GET",
        url: `/api/v1/auth/device/status?user_code=${encodeURIComponent(firstCode)}`,
      });
      expect(publicApproved.statusCode).toBe(200);
      expect(publicApproved.json()).toMatchObject({
        status: "approved",
        clientId: "lore-cli",
      });
      await db.query(
        `UPDATE oauth_device_codes
            SET last_polled_at = NULL
          WHERE device_code_hash = $1`,
        [hashTokenForTest(firstAuthorization.json().device_code)],
      );

      const firstTokens = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers,
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: firstAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(firstTokens.statusCode).toBe(200);
      await expect(
        oauth.verifyBearerUser(
          `Bearer ${firstTokens.json().access_token}`,
        ),
      ).resolves.toMatchObject({ id: admin.rows[0]!.id });

      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth-identities",
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().identities).toHaveLength(1);
      expect(listed.json().identities[0]).toMatchObject({
        clientId: "lore-cli",
        scope: "openid offline_access",
      });
      const firstSessionId = listed.json().identities[0].id as string;
      const initialRefreshExpiresAt = Date.parse(
        listed.json().identities[0].expiresAt,
      );
      const initialRefreshCreatedAt = Date.parse(
        listed.json().identities[0].createdAt,
      );
      expect(
        (initialRefreshExpiresAt - initialRefreshCreatedAt) /
          (24 * 60 * 60 * 1000),
      ).toBeCloseTo(90, 5);

      const sameDeviceAuthorization = await app.inject({
        method: "POST",
        url: "/oauth/device_authorization",
        headers,
        payload: { client_id: "lore-cli", scope: "openid offline_access" },
      });
      const sameDevicePending = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers,
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: sameDeviceAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(sameDevicePending.statusCode).toBe(400);
      expect(sameDevicePending.json().error).toBe("authorization_pending");

      const sameDeviceApproval = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device/approve",
        headers,
        payload: { userCode: sameDeviceAuthorization.json().user_code },
      });
      expect(sameDeviceApproval.statusCode).toBe(200);
      await db.query(
        `UPDATE oauth_device_codes
            SET last_polled_at = NULL
          WHERE device_code_hash = $1`,
        [hashTokenForTest(sameDeviceAuthorization.json().device_code)],
      );
      const sameDeviceTokens = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers,
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: sameDeviceAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(sameDeviceTokens.statusCode).toBe(200);
      const sameDeviceList = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth-identities",
        headers,
      });
      expect(sameDeviceList.json().identities).toHaveLength(2);
      const sameDeviceIdentity = sameDeviceList.json().identities.find(
        (identity: { id: string }) => identity.id !== firstSessionId,
      );
      expect(sameDeviceIdentity).toBeTruthy();
      const sameDeviceRefreshExpiresAt = Date.parse(
        sameDeviceIdentity.expiresAt,
      );

      const refreshedTokens = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers,
        payload: {
          grant_type: "refresh_token",
          refresh_token: sameDeviceTokens.json().refresh_token,
          client_id: "lore-cli",
        },
      });
      expect(refreshedTokens.statusCode).toBe(200);
      const refreshedList = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth-identities",
        headers,
      });
      const refreshedIdentity = refreshedList.json().identities.find(
        (identity: { id: string }) => identity.id === sameDeviceIdentity.id,
      );
      expect(Date.parse(refreshedIdentity.expiresAt)).toBe(
        sameDeviceRefreshExpiresAt,
      );

      const sameNetworkAuthorization = await app.inject({
        method: "POST",
        url: "/oauth/device_authorization",
        headers: {
          "user-agent": "Lore-Desktop/0.13.0 test-workstation",
        },
        payload: { client_id: "lore-cli", scope: "openid offline_access" },
      });
      const sameNetworkPending = await app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: sameNetworkAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(sameNetworkPending.statusCode).toBe(400);
      expect(sameNetworkPending.json().error).toBe("authorization_pending");
      const sameNetworkApproval = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device/approve",
        headers,
        payload: { userCode: sameNetworkAuthorization.json().user_code },
      });
      expect(sameNetworkApproval.statusCode).toBe(200);
      await db.query(
        `UPDATE oauth_device_codes
            SET last_polled_at = NULL
          WHERE device_code_hash = $1`,
        [hashTokenForTest(sameNetworkAuthorization.json().device_code)],
      );
      const sameNetworkTokens = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: {
          "user-agent": "Lore-Desktop/0.13.0 test-workstation",
        },
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: sameNetworkAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(sameNetworkTokens.statusCode).toBe(200);

      const secondHeaders = {
        cookie: `lore_portal_session=${browserSession.token}`,
        "user-agent": "Lore-Desktop/0.13.0 second-workstation",
      };
      const automaticAuthorization = await app.inject({
        method: "POST",
        url: "/oauth/device_authorization",
        headers: secondHeaders,
        payload: { client_id: "lore-cli", scope: "openid offline_access" },
      });
      const automaticPending = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: secondHeaders,
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: automaticAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(automaticPending.statusCode).toBe(400);
      expect(automaticPending.json().error).toBe("authorization_pending");
      const secondApproval = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device/approve",
        headers: secondHeaders,
        payload: { userCode: automaticAuthorization.json().user_code },
      });
      expect(secondApproval.statusCode).toBe(200);
      await db.query(
        `UPDATE oauth_device_codes
            SET last_polled_at = NULL
          WHERE device_code_hash = $1`,
        [hashTokenForTest(automaticAuthorization.json().device_code)],
      );
      const automaticTokens = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: secondHeaders,
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: automaticAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(automaticTokens.statusCode).toBe(200);

      const allSessions = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth-identities",
        headers,
      });
      expect(allSessions.json().identities).toHaveLength(4);
      expect(
        new Set(
          allSessions.json().identities.map(
            (identity: { id: string }) => identity.id,
          ),
        ).size,
      ).toBe(4);
      const firstIdentity = allSessions.json().identities.find(
        (identity: { id: string }) => identity.id === firstSessionId,
      );
      expect(firstIdentity).toBeTruthy();

      const otherUserId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role, status)
         VALUES ($1, 'alice@example.com', 'alice', 'Alice', 'unused',
                 'user', 'active')`,
        [otherUserId],
      );
      const otherSession = await session.create(otherUserId);
      const otherHeaders = {
        cookie: `lore_portal_session=${otherSession.token}`,
        "user-agent": "Lore-Desktop/0.13.0 other-workstation",
      };
      const otherList = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth-identities",
        headers: otherHeaders,
      });
      expect(otherList.json().identities).toEqual([]);
      const otherRevoke = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/oauth-identities",
        headers: otherHeaders,
      });
      expect(otherRevoke.statusCode).toBe(200);
      expect(otherRevoke.json().revokedCount).toBe(0);
      expect(otherRevoke.json().oauthEpoch).toBe(0);
      const otherSessionRevoke = await app.inject({
        method: "DELETE",
        url: `/api/v1/auth/oauth-identities/${firstIdentity.id}`,
        headers: otherHeaders,
      });
      expect(otherSessionRevoke.statusCode).toBe(404);

      const sessionRevoked = await app.inject({
        method: "DELETE",
        url: `/api/v1/auth/oauth-identities/${firstIdentity.id}`,
        headers,
      });
      expect(sessionRevoked.statusCode).toBe(200);
      expect(sessionRevoked.json().revokedCount).toBe(1);
      await expect(
        oauth.verifyBearerUser(
          `Bearer ${firstTokens.json().access_token}`,
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        oauth.verifyBearerUser(
          `Bearer ${automaticTokens.json().access_token}`,
        ),
      ).resolves.toMatchObject({ id: admin.rows[0]!.id });
      const adminStillListed = await app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth-identities",
        headers,
      });
      expect(adminStillListed.json().identities).toHaveLength(3);

      const revoked = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/oauth-identities",
        headers,
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().revokedCount).toBe(3);
      expect(revoked.json().oauthEpoch).toBe(1);
      await expect(
        oauth.verifyBearerUser(
          `Bearer ${automaticTokens.json().access_token}`,
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });

      const rejectedRefresh = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers,
        payload: {
          grant_type: "refresh_token",
          refresh_token: automaticTokens.json().refresh_token,
          client_id: "lore-cli",
        },
      });
      expect(rejectedRefresh.statusCode).toBe(400);
      expect(rejectedRefresh.json().error).toBe("invalid_grant");

      const requiredAuthorization = await app.inject({
        method: "POST",
        url: "/oauth/device_authorization",
        headers,
        payload: { client_id: "lore-cli", scope: "openid offline_access" },
      });
      const requiredLogin = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers,
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: requiredAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(requiredLogin.statusCode).toBe(400);
      expect(requiredLogin.json().error).toBe("authorization_pending");

      const denied = await app.inject({
        method: "POST",
        url: "/api/v1/auth/device/deny",
        headers,
        payload: { userCode: requiredAuthorization.json().user_code },
      });
      expect(denied.statusCode).toBe(200);
      await db.query(
        `UPDATE oauth_device_codes
            SET last_polled_at = NULL
          WHERE device_code_hash = $1`,
        [hashTokenForTest(requiredAuthorization.json().device_code)],
      );
      const deniedToken = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers,
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: requiredAuthorization.json().device_code,
          client_id: "lore-cli",
        },
      });
      expect(deniedToken.statusCode).toBe(400);
      expect(deniedToken.json().error).toBe("access_denied");
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function hashTokenForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
