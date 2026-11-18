import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import type { LoreAction, SessionUser } from "@lore-portal/shared";
import { AppError, unauthorized } from "@lore-portal/shared";
import type { AppConfig } from "../config.ts";
import type { Database } from "../db/index.ts";
import { randomToken } from "./random.ts";

interface SigningMaterial {
  privateKey: KeyObject;
  publicJwk: JWK;
}

export interface VerifiedAccessToken {
  user: {
    id: string;
    username: string;
    displayName: string;
  };
  payload: JWTPayload;
}

export interface TokenIdentityOptions {
  oauthExempt?: boolean;
  oauthSessionId?: string;
}

export class TokenService {
  private constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly material: SigningMaterial,
  ) {}

  static async create(config: AppConfig, db: Database): Promise<TokenService> {
    await mkdir(config.oidcKeyDir, { recursive: true });
    const keyPath = path.join(config.oidcKeyDir, "oidc-private.pem");
    let pem: string;
    try {
      pem = await readFile(keyPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      await writeFile(keyPath, pem, { mode: 0o600 });
    }
    const privateKey = createPrivateKey(pem);
    const publicJwk = await exportJWK(createPublicKey(privateKey));
    publicJwk.kid = config.oidcKeyId;
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";
    return new TokenService(config, db, { privateKey, publicJwk });
  }

  async signLoginToken(
    user: SessionUser,
    ttlSeconds = this.config.accessTokenTtlSeconds,
    options: TokenIdentityOptions = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const host = new URL(this.config.lorePublicUrl).hostname;
    return new SignJWT({
      ...(await this.identityVersionClaims(user.id, options)),
      identity: user.username,
      preferred_username: user.username,
      name: user.displayName,
      env: "local",
      idp: "lore-portal",
      is_service_account: false,
      root_domains: [host],
      roles: [user.globalRole],
    })
      .setProtectedHeader({
        alg: "RS256",
        typ: "at+jwt",
        kid: this.config.oidcKeyId,
      })
      .setIssuer(this.config.publicUrl)
      .setAudience(this.config.loreAudience)
      .setSubject(user.id)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .setJti(randomToken(16))
      .sign(this.configOidcKey());
  }

  async signRepositoryToken(input: {
    user: SessionUser;
    repositoryId: string;
    resource: string;
    actions: LoreAction[];
    oauthExempt?: boolean;
    oauthSessionId?: string;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const host = new URL(this.config.lorePublicUrl).hostname;
    return new SignJWT({
      ...(await this.identityVersionClaims(input.user.id, input)),
      identity: input.user.username,
      preferred_username: input.user.username,
      name: input.user.displayName,
      env: "local",
      idp: "lore-portal",
      is_service_account: false,
      root_domains: [host],
      resources: [
        {
          resource_id: input.resource,
          permission: input.actions,
        },
      ],
    })
      .setProtectedHeader({
        alg: "RS256",
        typ: "at+jwt",
        kid: this.config.oidcKeyId,
      })
      .setIssuer(this.config.publicUrl)
      .setAudience(this.config.loreAudience)
      .setSubject(input.user.id)
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.repositoryTokenTtlSeconds)
      .setJti(randomToken(16))
      .sign(this.configOidcKey());
  }

  async verify(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet({
        keys: [this.material.publicJwk],
      }), {
        issuer: this.config.publicUrl,
        audience: this.config.loreAudience,
        algorithms: ["RS256"],
      });
      const protectedHeader = JSON.parse(
        Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
      ) as { typ?: string };
      if (protectedHeader.typ !== "at+jwt" || typeof payload.sub !== "string") {
        throw new Error("Not an access token");
      }
      return {
        user: {
          id: payload.sub,
          username:
            typeof payload.preferred_username === "string"
              ? payload.preferred_username
              : payload.sub,
          displayName:
            typeof payload.name === "string" ? payload.name : payload.sub,
        },
        payload,
      };
    } catch {
      throw unauthorized("Invalid or expired token");
    }
  }

  jwks(): { keys: JWK[] } {
    return { keys: [this.material.publicJwk] };
  }

  discoveryDocument(): Record<string, unknown> {
    return {
      issuer: this.config.publicUrl,
      authorization_endpoint: `${this.config.publicUrl}/device`,
      token_endpoint: `${this.config.publicUrl}/oauth/token`,
      jwks_uri: `${this.config.publicUrl}/.well-known/jwks.json`,
      device_authorization_endpoint: `${this.config.publicUrl}/oauth/device_authorization`,
      revocation_endpoint: `${this.config.publicUrl}/oauth/revoke`,
      userinfo_endpoint: `${this.config.publicUrl}/oauth/userinfo`,
      response_types_supported: ["none"],
      grant_types_supported: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:token-exchange",
      ],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "offline_access"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: [
        "sub",
        "iss",
        "aud",
        "exp",
        "iat",
        "identity",
        "preferred_username",
        "name",
        "root_domains",
        "oauth_epoch",
      ],
    };
  }

  private configOidcKey(): KeyObject {
    return this.material.privateKey;
  }

  private async identityVersionClaims(
    userId: string,
    options: TokenIdentityOptions,
  ): Promise<Record<string, unknown>> {
    if (options.oauthExempt) {
      return { oauth_exempt: true };
    }
    const result = await this.db.query<{ oauth_epoch: number }>(
      "SELECT oauth_epoch FROM users WHERE id = $1",
      [userId],
    );
    return {
      oauth_epoch: Number(result.rows[0]?.oauth_epoch ?? 0),
      ...(options.oauthSessionId
        ? { oauth_session_id: options.oauthSessionId }
        : {}),
    };
  }
}

export function tokenError(error: string, description: string): AppError {
  return new AppError("unauthorized", 400, description, {
    error,
    error_description: description,
  });
}
