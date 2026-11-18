import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newId, resourceForRepository } from "@lore-portal/shared";
import { OAuthService } from "../src/auth/oauth-service.ts";
import { hashPassword } from "../src/auth/password.ts";
import { TokenService } from "../src/auth/token-service.ts";
import { findUserById } from "../src/auth/users.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { checkResourcePermissions } from "../src/grpc/auth-service.ts";
import { revokeAllOAuthIdentities } from "../src/auth/oauth-identities.ts";

describe("online OAuth authorization", () => {
  it("rejects old access tokens immediately after an OAuth identity revocation", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-oauth-online-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await migrate(db);
      const userId = newId();
      await db.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash, global_role, status)
         VALUES ($1, 'admin@example.com', 'admin', 'Admin', $2, 'admin', 'active')`,
        [userId, await hashPassword("123456")],
      );
      const repositoryId = newId();
      await db.query(
        `INSERT INTO repositories
           (id, organization_id, owner_user_id, slug, lore_name,
            default_branch_id, created_by, status)
         VALUES ($1, NULL, $2, 'demo', 'admin/demo', $3, $2, 'active')`,
        [repositoryId, userId, newId()],
      );
      const config = loadConfig({
        NODE_ENV: "test",
        APP_PUBLIC_URL: "http://localhost:3000",
        API_INTERNAL_URL: "http://localhost:4000",
        OIDC_KEY_DIR: path.join(directory, "keys"),
      });
      const user = await findUserById(db, userId);
      expect(user).not.toBeNull();
      const tokens = await TokenService.create(config, db);
      const oauth = new OAuthService(db, config, tokens);
      await db.query(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, user_id, client_id, scope, expires_at)
         VALUES ($1, $2, 'lore-cli', 'openid offline_access',
                 '2099-01-01T00:00:00.000Z')`,
        ["a".repeat(64), userId],
      );
      const accessToken = await tokens.signLoginToken(user!);
      const authorization = `Bearer ${accessToken}`;

      await expect(oauth.verifyBearerUser(authorization)).resolves.toMatchObject(
        { id: userId },
      );
      const resourceId = resourceForRepository(repositoryId);
      const before = await checkResourcePermissions({
        db,
        user: user!,
        resourceIds: [resourceId],
      });
      expect(before.allowed).toHaveLength(1);
      expect(before.allowed[0]?.permission).toContain("admin");

      const revoked = await revokeAllOAuthIdentities(db, userId);
      expect(revoked.revokedCount).toBe(1);
      expect(revoked.oauthEpoch).toBe(1);
      await expect(oauth.verifyBearerUser(authorization)).rejects.toMatchObject(
        { code: "unauthorized" },
      );

      const reloginToken = await tokens.signLoginToken(user!);
      await expect(
        oauth.verifyBearerUser(`Bearer ${reloginToken}`),
      ).resolves.toMatchObject({ id: userId });

      const apiKeyToken = await tokens.signLoginToken(
        user!,
        config.accessTokenTtlSeconds,
        { oauthExempt: true },
      );
      await expect(
        oauth.verifyBearerUser(`Bearer ${apiKeyToken}`),
      ).resolves.toMatchObject({ id: userId });
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
