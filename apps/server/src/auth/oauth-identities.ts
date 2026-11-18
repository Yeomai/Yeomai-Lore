import type { Database, QueryExecutor } from "../db/index.ts";
import { nowIso, withTransaction } from "../db/index.ts";

export interface OAuthIdentity {
  id: string;
  clientId: string;
  scope: string;
  createdAt: string;
  accessExpiresAt: string;
  expiresAt: string;
  deviceId: string | null;
  deviceCode: string | null;
  note: string | null;
  userAgent: string | null;
  lastIp: string | null;
  lastSeenAt: string | null;
}

interface OAuthIdentityRow {
  oauth_session_id: string;
  token_hash: string;
  client_id: string;
  scope: string;
  created_at: string;
  expires_at: string;
  device_id: string | null;
  device_code: string | null;
  note: string | null;
  user_agent: string | null;
  last_ip: string | null;
  last_seen_at: string | null;
}

export async function listOAuthIdentities(
  db: QueryExecutor,
  userId: string,
  accessTokenTtlSeconds: number,
): Promise<OAuthIdentity[]> {
  const result = await db.query<OAuthIdentityRow>(
    `SELECT COALESCE(t.oauth_session_id, t.token_hash) AS oauth_session_id,
            t.token_hash, t.client_id, t.scope, t.created_at, t.expires_at,
            d.id AS device_id, d.device_code, d.note, d.user_agent,
            d.last_ip, d.last_seen_at
       FROM oauth_refresh_tokens t
       LEFT JOIN oauth_refresh_devices rd ON rd.token_hash = t.token_hash
       LEFT JOIN user_devices d ON d.id = rd.device_id
      WHERE t.user_id = $1
        AND t.revoked_at IS NULL
        AND t.expires_at > $2
      ORDER BY t.created_at DESC`,
    [userId, nowIso()],
  );
  return result.rows.map((row) => ({
    id: row.oauth_session_id,
    clientId: row.client_id,
    scope: row.scope,
    createdAt: row.created_at,
    accessExpiresAt: new Date(
      Date.parse(row.created_at) + accessTokenTtlSeconds * 1000,
    ).toISOString(),
    expiresAt: row.expires_at,
    deviceId: row.device_id,
    deviceCode: row.device_code,
    note: row.note,
    userAgent: row.user_agent,
    lastIp: row.last_ip,
    lastSeenAt: row.last_seen_at,
  }));
}

export async function revokeOAuthIdentity(
  db: QueryExecutor,
  input: { sessionId: string; userId: string },
): Promise<number> {
  const result = await db.query(
    `UPDATE oauth_refresh_tokens
        SET revoked_at = $3
      WHERE user_id = $1
        AND COALESCE(oauth_session_id, token_hash) = $2
        AND revoked_at IS NULL`,
    [input.userId, input.sessionId, nowIso()],
  );
  return result.rowCount;
}

export async function revokeAllOAuthIdentities(
  db: Database,
  userId: string,
): Promise<{ revokedCount: number; oauthEpoch: number }> {
  return withTransaction(db, async (client) => {
    const timestamp = nowIso();
    const revoked = await client.query(
      `UPDATE oauth_refresh_tokens
          SET revoked_at = $2
        WHERE user_id = $1
          AND revoked_at IS NULL`,
      [userId, timestamp],
    );
    if (revoked.rowCount === 0) {
      const current = await client.query<{ oauth_epoch: number }>(
        "SELECT oauth_epoch FROM users WHERE id = $1",
        [userId],
      );
      return {
        revokedCount: 0,
        oauthEpoch: Number(current.rows[0]?.oauth_epoch ?? 0),
      };
    }
    const epoch = await client.query<{ oauth_epoch: number }>(
      `UPDATE users
          SET oauth_epoch = oauth_epoch + 1,
              updated_at = $2
        WHERE id = $1
        RETURNING oauth_epoch`,
      [userId, timestamp],
    );
    return {
      revokedCount: revoked.rowCount,
      oauthEpoch: Number(epoch.rows[0]?.oauth_epoch ?? 0),
    };
  });
}

export async function revokeRefreshTokensForDevice(
  db: QueryExecutor,
  deviceId: string,
): Promise<void> {
  await db.query(
    `UPDATE oauth_refresh_tokens
        SET revoked_at = $2
      WHERE revoked_at IS NULL
        AND token_hash IN (
          SELECT token_hash FROM oauth_refresh_devices WHERE device_id = $1
        )`,
    [deviceId, nowIso()],
  );
}

