import {
  forbidden,
  isUuid,
  loreActionsForPermission,
  newId,
  notFound,
  resourceForRepository,
  unauthorized,
  type SessionUser,
} from "@lore-portal/shared";
import type { AppConfig } from "../config.ts";
import type { Database } from "../db/index.ts";
import {
  isoAfterSeconds,
  nowIso,
  withTransaction,
} from "../db/index.ts";
import {
  findRepositoryById,
  repositoryPermission,
} from "../repositories.ts";
import { findUserById } from "./users.ts";
import {
  formatUserCode,
  hashToken,
  normalizeUserCode,
  randomToken,
  randomUserCode,
} from "./random.ts";
import type { TokenService } from "./token-service.ts";
import {
  deviceRequestMetadata,
  createApprovalDeviceKey,
  linkRefreshTokenToDevice,
  recordDeviceRequest,
  refreshDeviceStatus,
  upsertVerifiedDevice,
  createDeviceKey,
} from "./devices.ts";
import {
  revokeRefreshTokensForDevice,
} from "./oauth-identities.ts";

export class OAuthProtocolError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthProtocolError";
  }
}

interface DeviceCodeRow {
  device_code_hash: string;
  client_id: string;
  user_id: string | null;
  status: "pending" | "approved" | "denied" | "used";
  interval_seconds: number;
  last_polled_at: string | null;
  expires_at: string;
}

interface RefreshTokenRow {
  token_hash: string;
  oauth_session_id: string;
  session_started_at: string;
  user_id: string;
  client_id: string;
  scope: string;
  expires_at: string;
  revoked_at: string | null;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  issued_token_type?: string;
}

export class OAuthService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly tokens: TokenService,
  ) {}

  async startDevice(input: {
    clientId: string;
    userAgent: string;
    ip: string;
  }): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }> {
    this.assertClient(input.clientId);
    const deviceCode = randomToken(32);
    const userCode = randomUserCode();
    const deviceCodeHash = hashToken(deviceCode);
    const deviceKey = createDeviceKey(input);
    const expiresIn = 600;
    const interval = 5;
    await this.db.query(
      `INSERT INTO oauth_device_codes
         (device_code_hash, user_code_hash, client_id, user_id, status,
          interval_seconds, expires_at, approved_at)
       VALUES ($1, $2, $3, NULL, 'pending', $4, $5, NULL)`,
      [
        deviceCodeHash,
        hashToken(normalizeUserCode(userCode)),
        input.clientId,
        interval,
        isoAfterSeconds(expiresIn),
      ],
    );
    await recordDeviceRequest(this.db, {
      deviceCodeHash,
      deviceKey,
      userAgent: input.userAgent,
      ip: input.ip,
    });
    const verificationUri = `${this.config.publicUrl}/device`;
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: expiresIn,
      interval,
    };
  }

  async deviceForUserCode(userCode: string): Promise<{
    status: "pending" | "approved" | "denied" | "used" | "expired";
    clientId: string;
  } | null> {
    const result = await this.db.query<DeviceCodeRow>(
      `SELECT * FROM oauth_device_codes WHERE user_code_hash = $1`,
      [hashToken(normalizeUserCode(userCode))],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      status:
        Date.parse(row.expires_at) <= Date.now() ? "expired" : row.status,
      clientId: row.client_id,
    };
  }

  async approveDevice(userCode: string, user: SessionUser): Promise<void> {
    const userCodeHash = hashToken(normalizeUserCode(userCode));
    const device = await this.db.query<{ device_code_hash: string }>(
      `SELECT device_code_hash
         FROM oauth_device_codes
        WHERE user_code_hash = $1
          AND status = 'pending'
          AND expires_at > $2`,
      [userCodeHash, nowIso()],
    );
    const deviceCodeHash = device.rows[0]?.device_code_hash;
    const metadata = deviceCodeHash
      ? await this.deviceMetadataForCode(deviceCodeHash)
      : null;
    const result = await this.db.query(
      `UPDATE oauth_device_codes
         SET status = 'approved', user_id = $2, approved_at = $3
        WHERE user_code_hash = $1
          AND status = 'pending'
          AND expires_at > $3`,
      [userCodeHash, user.id, nowIso()],
    );
    if (result.rowCount !== 1) {
      throw notFound("This device code is invalid or expired");
    }
    if (metadata && deviceCodeHash) {
      await upsertVerifiedDevice(this.db, {
        userId: user.id,
        deviceCode: formatUserCode(userCode),
        deviceKey: createApprovalDeviceKey(
          metadata.deviceKey,
          deviceCodeHash,
        ),
        userAgent: metadata.userAgent,
        ip: metadata.ip,
      });
    }
  }

  async denyDevice(userCode: string, user: SessionUser): Promise<void> {
    const result = await this.db.query(
      `UPDATE oauth_device_codes
         SET status = 'denied', user_id = $2, approved_at = $3
        WHERE user_code_hash = $1
          AND status = 'pending'
          AND expires_at > $3`,
      [hashToken(normalizeUserCode(userCode)), user.id, nowIso()],
    );
    if (result.rowCount !== 1) {
      throw notFound("This device code is invalid or expired");
    }
  }

  async pollDevice(
    deviceCode: string,
    clientId: string,
  ): Promise<TokenResponse> {
    this.assertClient(clientId);
    const result = await this.db.query<DeviceCodeRow>(
      `SELECT * FROM oauth_device_codes WHERE device_code_hash = $1`,
      [hashToken(deviceCode)],
    );
    const row = result.rows[0];
    if (!row || row.client_id !== clientId) {
      throw new OAuthProtocolError("invalid_grant", "Unknown device code");
    }
    const metadata = await this.deviceMetadataForCode(row.device_code_hash);
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new OAuthProtocolError("expired_token", "The device code expired");
    }
    if (
      row.last_polled_at &&
      Date.now() - Date.parse(row.last_polled_at) <
        row.interval_seconds * 1000
    ) {
      await this.db.query(
        `UPDATE oauth_device_codes SET last_polled_at = $2
          WHERE device_code_hash = $1`,
        [row.device_code_hash, nowIso()],
      );
      throw new OAuthProtocolError(
        "slow_down",
        "Poll less frequently",
      );
    }
    await this.db.query(
      `UPDATE oauth_device_codes SET last_polled_at = $2
        WHERE device_code_hash = $1`,
      [row.device_code_hash, nowIso()],
    );
    switch (row.status) {
      case "pending":
        throw new OAuthProtocolError(
          "authorization_pending",
          "The user has not approved this login",
        );
      case "denied":
        throw new OAuthProtocolError("access_denied", "Login was denied");
      case "used":
        throw new OAuthProtocolError("invalid_grant", "Device code already used");
      case "approved":
        break;
    }
    if (!row.user_id) {
      throw new OAuthProtocolError("invalid_grant", "Device code has no user");
    }
    const user = await findUserById(this.db, row.user_id);
    if (!user) {
      throw new OAuthProtocolError("invalid_grant", "The user is unavailable");
    }
    await this.db.query(
      `UPDATE oauth_device_codes SET status = 'used'
        WHERE device_code_hash = $1`,
      [row.device_code_hash],
    );
    const device = metadata
      ? await this.activeDeviceForUser(
          row.user_id,
          createApprovalDeviceKey(
            metadata.deviceKey,
            row.device_code_hash,
          ),
        )
      : null;
    return this.issueLoginTokens(
      user,
      clientId,
      "openid offline_access",
      true,
      {
        ...(device ? { deviceId: device.id } : {}),
      },
    );
  }

  async refresh(
    refreshToken: string,
    clientId: string,
  ): Promise<TokenResponse> {
    this.assertClient(clientId);
    const result = await this.db.query<RefreshTokenRow>(
      `SELECT * FROM oauth_refresh_tokens WHERE token_hash = $1`,
      [hashToken(refreshToken)],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.client_id !== clientId ||
      row.revoked_at ||
      Date.parse(row.expires_at) <= Date.now()
    ) {
      throw new OAuthProtocolError(
        "invalid_grant",
        "The refresh token is invalid or expired",
      );
    }
    const device = await refreshDeviceStatus(this.db, row.token_hash);
    if (device && !device.active) {
      throw new OAuthProtocolError(
        "invalid_grant",
        "The refresh token is invalid or expired",
      );
    }
    const user = await findUserById(this.db, row.user_id);
    if (!user) {
      throw new OAuthProtocolError("invalid_grant", "The user is unavailable");
    }
    await this.db.query(
      `UPDATE oauth_refresh_tokens SET revoked_at = $2
        WHERE token_hash = $1`,
      [row.token_hash, nowIso()],
    );
    return this.issueLoginTokens(
      user,
      clientId,
      row.scope,
      true,
      {
        ...(device ? { deviceId: device.deviceId } : {}),
        oauthSessionId: row.oauth_session_id,
        sessionStartedAt: row.session_started_at,
        refreshExpiresAt: row.expires_at,
      },
    );
  }

  async exchange(input: {
    subjectToken: string;
    subjectTokenType: string;
    resource?: string;
    clientId: string;
  }): Promise<TokenResponse> {
    this.assertClient(input.clientId);
    if (input.subjectTokenType === "urn:lore:params:oauth:token-type:api-key") {
      const user = await this.exchangeApiKey(input.subjectToken);
      const accessToken = await this.tokens.signLoginToken(
        user,
        this.config.accessTokenTtlSeconds,
        { oauthExempt: true },
      );
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: this.config.accessTokenTtlSeconds,
        issued_token_type:
          "urn:ietf:params:oauth:token-type:access_token",
      };
    }
    if (
      input.subjectTokenType !==
      "urn:ietf:params:oauth:token-type:access_token"
    ) {
      throw new OAuthProtocolError(
        "invalid_request",
        "Unsupported subject_token_type",
      );
    }
    const verified = await this.tokens.verify(input.subjectToken);
    const user = await findUserById(this.db, verified.user.id);
    if (!user) {
      throw new OAuthProtocolError("invalid_grant", "The user is unavailable");
    }
    const oauthExempt = verified.payload.oauth_exempt === true;
    const oauthSessionId =
      typeof verified.payload.oauth_session_id === "string"
        ? verified.payload.oauth_session_id
        : undefined;
    if (!input.resource) {
      const accessToken = await this.tokens.signLoginToken(
        user,
        this.config.accessTokenTtlSeconds,
        {
          oauthExempt,
          ...(oauthSessionId ? { oauthSessionId } : {}),
        },
      );
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: this.config.accessTokenTtlSeconds,
        issued_token_type:
          "urn:ietf:params:oauth:token-type:access_token",
      };
    }
    const repositoryId = resourceIdFromAbsoluteResource(
      input.resource,
      this.config.publicUrl,
    );
    const repository = await findRepositoryById(this.db, repositoryId);
    if (!repository || repository.status !== "active") {
      throw new OAuthProtocolError("invalid_target", "Unknown repository");
    }
    const permission = await repositoryPermission(this.db, user, repository);
    if (!permission) {
      throw forbidden("You do not have access to this repository");
    }
    const accessToken = await this.tokens.signRepositoryToken({
      user,
      repositoryId,
      resource: resourceForRepository(repositoryId),
      actions: loreActionsForPermission(permission),
      oauthExempt,
      ...(oauthSessionId ? { oauthSessionId } : {}),
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.repositoryTokenTtlSeconds,
      issued_token_type:
        "urn:ietf:params:oauth:token-type:access_token",
    };
  }

  async verifyBearerUser(authorization: string | undefined): Promise<SessionUser> {
    return (await this.verifyBearerContext(authorization)).user;
  }

  async verifyBearerContext(
    authorization: string | undefined,
  ): Promise<{
    user: SessionUser;
    payload: Record<string, unknown>;
  }> {
    const token = bearerValue(authorization);
    const verified = await this.tokens.verify(token);
    const user = await findUserById(this.db, verified.user.id);
    if (!user) {
      throw new OAuthProtocolError("invalid_token", "The user is unavailable");
    }
    if (verified.payload.oauth_exempt !== true) {
      const result = await this.db.query<{ oauth_epoch: number }>(
        "SELECT oauth_epoch FROM users WHERE id = $1",
        [user.id],
      );
      const currentEpoch = Number(result.rows[0]?.oauth_epoch ?? 0);
      const tokenEpoch = Number(verified.payload.oauth_epoch ?? 0);
      if (tokenEpoch !== currentEpoch) {
        throw unauthorized("OAuth authentication has been revoked");
      }
      const oauthSessionId = verified.payload.oauth_session_id;
      if (typeof oauthSessionId === "string" && oauthSessionId) {
        const session = await this.db.query<{ count: number }>(
          `SELECT count(*) AS count
             FROM oauth_refresh_tokens
            WHERE oauth_session_id = $1
              AND user_id = $2
              AND revoked_at IS NULL
              AND expires_at > $3`,
          [oauthSessionId, user.id, nowIso()],
        );
        if (Number(session.rows[0]?.count ?? 0) === 0) {
          throw unauthorized("OAuth session has been revoked");
        }
      }
    }
    return {
      user,
      payload: verified.payload as Record<string, unknown>,
    };
  }

  async createApiToken(
    user: SessionUser,
    name: string,
  ): Promise<{ id: string; token: string; prefix: string }> {
    const id = newId();
    const token = `lore_${randomToken(32)}`;
    const prefix = token.slice(0, 12);
    await this.db.query(
      `INSERT INTO api_tokens (id, user_id, name, prefix, token_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, user.id, name, prefix, hashToken(token)],
    );
    return { id, token, prefix };
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.db.query(
      `UPDATE oauth_refresh_tokens SET revoked_at = $2
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(refreshToken), nowIso()],
    );
  }

  private async issueLoginTokens(
    user: SessionUser,
    clientId: string,
    scope: string,
    includeRefresh: boolean,
    options: {
      deviceId?: string;
      oauthSessionId?: string;
      sessionStartedAt?: string;
      refreshExpiresAt?: string;
    } = {},
  ): Promise<TokenResponse> {
    const sessionId = options.oauthSessionId ?? newId();
    const sessionStartedAt = options.sessionStartedAt ?? nowIso();
    const accessToken = await this.tokens.signLoginToken(
      user,
      this.config.accessTokenTtlSeconds,
      { oauthSessionId: sessionId },
    );
    if (!includeRefresh) {
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: this.config.accessTokenTtlSeconds,
        scope,
      };
    }
    const refreshToken = randomToken(48);
    const refreshTokenHash = hashToken(refreshToken);
    await withTransaction(this.db, async (client) => {
      if (options.deviceId) {
        await revokeRefreshTokensForDevice(client, options.deviceId);
      }
      await client.query(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, oauth_session_id, user_id, client_id, scope,
            expires_at, session_started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          refreshTokenHash,
          sessionId,
          user.id,
          clientId,
          scope,
          options.refreshExpiresAt ??
            isoAfterSeconds(this.config.refreshTokenTtlSeconds),
          sessionStartedAt,
        ],
      );
      if (options.deviceId) {
        await linkRefreshTokenToDevice(client, {
          tokenHash: refreshTokenHash,
          deviceId: options.deviceId,
        });
      }
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope,
    };
  }

  private async exchangeApiKey(apiKey: string): Promise<SessionUser> {
    const result = await this.db.query<ApiTokenRow>(
      `SELECT id, user_id, expires_at, revoked_at
         FROM api_tokens WHERE token_hash = $1`,
      [hashToken(apiKey)],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.revoked_at ||
      (row.expires_at && Date.parse(row.expires_at) <= Date.now())
    ) {
      throw new OAuthProtocolError("invalid_grant", "The API key is invalid");
    }
    const user = await findUserById(this.db, row.user_id);
    if (!user) {
      throw new OAuthProtocolError("invalid_grant", "The user is unavailable");
    }
    await this.db.query(
      `UPDATE api_tokens SET last_used_at = $2 WHERE id = $1`,
      [row.id, nowIso()],
    );
    return user;
  }

  private assertClient(clientId: string): void {
    if (clientId !== this.config.oidcClientId) {
      throw new OAuthProtocolError("invalid_client", "Unknown client_id");
    }
  }

  private async deviceMetadataForCode(deviceCodeHash: string) {
    return deviceRequestMetadata(this.db, deviceCodeHash);
  }

  private async activeDeviceForUser(
    userId: string,
    deviceKey: string,
  ): Promise<{ id: string } | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM user_devices
        WHERE user_id = $1 AND device_key = $2 AND revoked_at IS NULL`,
      [userId, deviceKey],
    );
    return result.rows[0] ?? null;
  }

}

export function resourceIdFromAbsoluteResource(
  resource: string,
  publicUrl: string,
): string {
  const prefix = `${publicUrl}/lore/repositories/`;
  if (!resource.startsWith(prefix)) {
    throw new OAuthProtocolError("invalid_target", "Unsupported resource");
  }
  const id = resource.slice(prefix.length);
  if (isUuid(id)) {
    return id;
  }
  if (/^[0-9a-f]{32}$/i.test(id)) {
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }
  throw new OAuthProtocolError("invalid_target", "Malformed repository id");
}

export function bearerValue(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) {
    throw new OAuthProtocolError("invalid_token", "Bearer token required", 401);
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new OAuthProtocolError("invalid_token", "Bearer token required", 401);
  }
  return token;
}
