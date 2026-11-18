import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/index.ts";
import { migrate } from "./db/migrate.ts";
import { SessionService } from "./auth/session.ts";
import { TokenService } from "./auth/token-service.ts";
import { OAuthService } from "./auth/oauth-service.ts";
import { createMailer } from "./auth/mailer.ts";
import { GrpcLoreClient } from "./lore/grpc-client.ts";
import { startRegistryGrpcServer } from "./grpc/registry-server.ts";
import { startMaintenanceCleanup } from "./maintenance.ts";
import { buildApp } from "./app.ts";
import { RepositoryImportService } from "./imports/service.ts";
import {
  applySiteSettings,
  migrateLegacyUnifiedAddress,
  writeLoreRuntimeConfig,
} from "./setup.ts";
import { applySmtpSettings } from "./mail-settings.ts";
import { isLoreReady } from "./readiness.ts";
import { restartLore } from "./lore-supervisor.ts";

const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
const rootEnvPath = path.resolve(process.cwd(), "../../.env");
if (!existsSync(envPath) && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const config = loadConfig();
const db = createDatabase(config.databasePath);

await migrate(db);
const addressMigration = await migrateLegacyUnifiedAddress(db, config);
if (addressMigration) {
  console.warn(
    {
      previousWebPublicUrl: addressMigration.previousWebPublicUrl,
      webPublicUrl: addressMigration.webPublicUrl,
      previousLorePublicUrl: addressMigration.previousLorePublicUrl,
      lorePublicUrl: addressMigration.lorePublicUrl,
      revokedSessions: addressMigration.revokedSessions,
      revokedOAuthTokens: addressMigration.revokedOAuthTokens,
      invalidatedUsers: addressMigration.invalidatedUsers,
    },
    "Migrated legacy Lore public URL to the unified Web host and port",
  );
}
const siteSettings = await applySiteSettings(db, config);
await writeLoreRuntimeConfig(config, siteSettings);

const tokens = await TokenService.create(config, db);
await applySmtpSettings(db, config);
const session = new SessionService(db, config);
const oauth = new OAuthService(db, config, tokens);
const mailer = createMailer(config);
const lore = new GrpcLoreClient(config);
const imports = new RepositoryImportService(config, db, lore, tokens);
const app = await buildApp({
  config,
  db,
  lore,
  session,
  tokens,
  oauth,
  mailer,
  imports,
  serviceReadiness: () => isLoreReady(config),
  restartLore: () => restartLore(config),
});
const grpcServer = await startRegistryGrpcServer({
  config,
  db,
  oauth,
  tokens,
  lore,
});
const maintenance = startMaintenanceCleanup(db, app.log);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await imports.stop();
  await maintenance.stop();
  await app.close();
  grpcServer.forceShutdown();
  await db.end();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.host, port: config.port });
void imports.start().catch((error: unknown) => {
  app.log.error({ err: error }, "Repository import recovery failed");
});
app.log.info(
  {
    publicUrl: config.publicUrl,
    grpc: `${config.grpcHost}:${config.grpcPort}`,
    loreGrpc: config.loreGrpcUrl,
  },
  "Yeomai Lore API ready",
);
