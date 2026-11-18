import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, decodeJwt, generateKeyPair } from "jose";
import type { SessionUser } from "@lore-portal/shared";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { TokenService } from "../src/auth/token-service.ts";
import { createDatabase, type Database } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";

let directory: string;
let config: AppConfig;
let tokens: TokenService;
let db: Database;

const user: SessionUser = {
  id: "019be4b0-1736-7a42-9f77-46d000000001",
  email: "alice@example.com",
  username: "alice",
  displayName: "Alice",
  globalRole: "user",
};

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "lore-portal-token-test-"));
  config = loadConfig({
    APP_PUBLIC_URL: "http://localhost:3000",
    API_INTERNAL_URL: "http://localhost:4000",
    LORE_HTTP_URL: "http://localhost:41339",
    LORE_PUBLIC_URL: "lores://lore.example.com",
    LORE_AUDIENCE: "lore-portal",
    OIDC_KEY_DIR: directory,
  });
  db = createDatabase(path.join(directory, "portal.sqlite"));
  await migrate(db);
  await db.query(
    `INSERT INTO users
       (id, email, username, display_name, password_hash, global_role, status)
     VALUES ($1, $2, $3, $4, 'unused', 'user', 'active')`,
    [user.id, user.email, user.username, user.displayName],
  );
  tokens = await TokenService.create(config, db);
});

afterAll(async () => {
  await db.end();
  rmSync(directory, { recursive: true, force: true });
});

describe("TokenService", () => {
  it("issues a verifiable Lore login token with identity and send-check claims", async () => {
    const token = await tokens.signLoginToken(user);
    const verified = await tokens.verify(token);
    const claims = decodeJwt(token);

    expect(verified.user.id).toBe(user.id);
    expect(claims.identity).toBe("alice");
    expect(claims.preferred_username).toBe("alice");
    expect(claims.root_domains).toEqual(["lore.example.com"]);
    expect(claims.iss).toBe("http://localhost:3000");
    expect(claims.aud).toBe("lore-portal");
    expect(claims.oauth_epoch).toBe(0);
  });

  it("scopes a token to one repository action set", async () => {
    const repositoryId = "019be4b0-1736-7a42-9f77-46d000000002";
    const token = await tokens.signRepositoryToken({
      user,
      repositoryId,
      resource: `urc-${repositoryId.replaceAll("-", "")}`,
      actions: ["read", "write"],
    });
    const verified = await tokens.verify(token);

    expect(verified.payload.root_domains).toEqual([
      "lore.example.com",
    ]);
    expect(verified.payload.resources).toEqual([
      {
        resource_id: `urc-${repositoryId.replaceAll("-", "")}`,
        permission: ["read", "write"],
      },
    ]);
  });

  it("publishes only public RSA signing material", () => {
    const jwks = tokens.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe(config.oidcKeyId);
    expect(jwks.keys[0]?.kty).toBe("RSA");
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(jwks.keys[0]).not.toHaveProperty("p");
  });

  it("rejects a token signed by another issuer key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({
      identity: "alice",
      preferred_username: "alice",
    })
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt" })
      .setIssuer(config.publicUrl)
      .setAudience(config.loreAudience)
      .setSubject(user.id)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);

    await expect(tokens.verify(forged)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

});
