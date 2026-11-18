import { newId } from "@lore-portal/shared";
import type { QueryExecutor } from "../db/index.ts";
import { nowIso } from "../db/index.ts";
import { hashToken } from "./random.ts";

export function createDeviceKey(input: {
  clientId: string;
  userAgent: string;
  ip: string;
}): string {
  const normalizedIp = input.ip.replace(/^::ffff:/, "");
  return hashToken(
    [
      "lore-portal-device-v1",
      input.clientId.trim(),
      input.userAgent.trim(),
      normalizedIp,
    ].join("\n"),
  );
}

export function createApprovalDeviceKey(
  deviceKey: string,
  deviceCodeHash: string,
): string {
  return hashToken(
    [
      "lore-portal-device-approval-v1",
      deviceKey,
      deviceCodeHash,
    ].join("\n"),
  );
}

export async function upsertVerifiedDevice(
  db: QueryExecutor,
  input: {
    userId: string;
    deviceCode: string;
    deviceKey: string;
    userAgent: string;
    ip: string;
  },
): Promise<string> {
  const id = newId();
  const timestamp = nowIso();
  const result = await db.query<{ id: string }>(
    `INSERT INTO user_devices
       (id, user_id, device_code, device_key, user_agent, last_ip, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, device_key)
     DO UPDATE SET device_code = EXCLUDED.device_code,
                   user_agent = EXCLUDED.user_agent,
                   last_ip = EXCLUDED.last_ip,
                   last_seen_at = EXCLUDED.last_seen_at,
                   revoked_at = NULL
     RETURNING id`,
    [
      id,
      input.userId,
      input.deviceCode,
      input.deviceKey,
      input.userAgent,
      input.ip,
      timestamp,
    ],
  );
  return result.rows[0]!.id;
}

export async function recordDeviceRequest(
  db: QueryExecutor,
  input: {
    deviceCodeHash: string;
    deviceKey: string;
    userAgent: string;
    ip: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_device_metadata
       (device_code_hash, device_key, user_agent, request_ip)
     VALUES ($1, $2, $3, $4)`,
    [
      input.deviceCodeHash,
      input.deviceKey,
      input.userAgent,
      input.ip,
    ],
  );
}

export async function deviceRequestMetadata(
  db: QueryExecutor,
  deviceCodeHash: string,
): Promise<{
  deviceKey: string;
  userAgent: string;
  ip: string;
} | null> {
  const result = await db.query<{
    device_key: string;
    user_agent: string;
    request_ip: string;
  }>(
    `SELECT device_key, user_agent, request_ip
       FROM oauth_device_metadata
      WHERE device_code_hash = $1`,
    [deviceCodeHash],
  );
  const row = result.rows[0];
  return row
    ? {
        deviceKey: row.device_key,
        userAgent: row.user_agent,
        ip: row.request_ip,
      }
    : null;
}
export async function linkRefreshTokenToDevice(
  db: QueryExecutor,
  input: {
    tokenHash: string;
    deviceId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_refresh_devices (token_hash, device_id)
     VALUES ($1, $2)
     ON CONFLICT (token_hash) DO UPDATE SET device_id = EXCLUDED.device_id`,
    [input.tokenHash, input.deviceId],
  );
}

export async function refreshDeviceStatus(
  db: QueryExecutor,
  tokenHash: string,
): Promise<{ deviceId: string; active: boolean } | null> {
  const result = await db.query<{ device_id: string; revoked_at: string | null }>(
    `SELECT rd.device_id, d.revoked_at
       FROM oauth_refresh_devices rd
       LEFT JOIN user_devices d ON d.id = rd.device_id
      WHERE rd.token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0]
    ? {
        deviceId: result.rows[0].device_id,
        active: result.rows[0].revoked_at === null,
      }
    : null;
}
