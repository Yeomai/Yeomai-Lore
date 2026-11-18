import {
  withTransaction,
  type Database,
} from "./db/index.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

export interface MaintenanceCleanupResult {
  sessions: number;
  deviceCodes: number;
  refreshTokens: number;
  resets: number;
  invites: number;
  auditEvents: number;
}

interface MaintenanceLogger {
  info(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface MaintenanceTask {
  run(): Promise<MaintenanceCleanupResult>;
  stop(): Promise<void>;
}

export async function runMaintenanceCleanup(
  db: Database,
  now = new Date(),
): Promise<MaintenanceCleanupResult> {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS).toISOString();

  return withTransaction(db, async (client) => {
    const sessions = await client.query(
      `DELETE FROM sessions
        WHERE expires_at < $1
           OR revoked_at < $2`,
      [dayAgo, monthAgo],
    );
    const deviceCodes = await client.query(
      `DELETE FROM oauth_device_codes WHERE expires_at < $1`,
      [dayAgo],
    );
    const refreshTokens = await client.query(
      `DELETE FROM oauth_refresh_tokens
        WHERE expires_at < $1 OR revoked_at < $1`,
      [dayAgo],
    );
    const resets = await client.query(
      `DELETE FROM password_resets
        WHERE expires_at < $1 OR used_at < $1`,
      [dayAgo],
    );
    const invites = await client.query(
      `DELETE FROM invites
        WHERE accepted_at IS NULL AND expires_at <= $1`,
      [now.toISOString()],
    );
    const auditEvents = await client.query(
      `DELETE FROM audit_events WHERE created_at < $1`,
      [monthAgo],
    );

    return {
      sessions: sessions.rowCount,
      deviceCodes: deviceCodes.rowCount,
      refreshTokens: refreshTokens.rowCount,
      resets: resets.rowCount,
      invites: invites.rowCount,
      auditEvents: auditEvents.rowCount,
    };
  });
}

export function startMaintenanceCleanup(
  db: Database,
  logger: MaintenanceLogger,
  intervalMs = MAINTENANCE_INTERVAL_MS,
): MaintenanceTask {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<MaintenanceCleanupResult> | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void run().catch(() => {});
    }, delayMs);
    timer.unref();
  };

  const execute = async (): Promise<MaintenanceCleanupResult> => {
    try {
      const result = await runMaintenanceCleanup(db);
      logger.info({ maintenance: result }, "Maintenance cleanup complete");
      return result;
    } catch (error) {
      logger.error({ err: error }, "Maintenance cleanup failed");
      throw error;
    }
  };

  const run = (): Promise<MaintenanceCleanupResult> => {
    if (inFlight) return inFlight;
    inFlight = execute().finally(() => {
      inFlight = undefined;
      schedule(intervalMs);
    });
    return inFlight;
  };

  schedule(0);

  return {
    run,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) {
        await inFlight.catch(() => {});
      }
    },
  };
}
