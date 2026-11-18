import path from "node:path";
import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  PORTAL_VERSION: z.string().default("1.1.4"),
  APP_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  API_INTERNAL_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_PATH: z.string().default("./data/local/portal.sqlite"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  REPOSITORY_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7_776_000),
  INVITE_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  OIDC_KEY_DIR: z.string().default("./data/keys"),
  LORE_GRPC_URL: z.string().default("localhost:41337"),
  LORE_HTTP_URL: z.string().url().default("http://localhost:41339"),
  LORE_PUBLIC_URL: z.string().default("lore://localhost:3000"),
  LORE_INTERNAL_URL: z.string().default("lore://localhost:41337"),
  LORE_CLI_PATH: z.string().default("data/local/bin/lore"),
  LORE_RUNTIME_CONFIG_PATH: z
    .string()
    .default("./data/local/config/local.toml"),
  LORE_STORAGE_PATH: z.string().default("./data/local/lore"),
  LORE_QUIC_TLS_CERT_FILE: z.string().optional(),
  LORE_QUIC_TLS_KEY_FILE: z.string().optional(),
  LORE_SUPERVISOR_PID_FILE: z
    .string()
    .default("./data/local/run/lore-supervisor.pid"),
  LORE_SUPERVISOR_SOCKET: z
    .string()
    .default("./data/local/run/lore-supervisor.sock"),
  LORE_IMPORT_WORK_DIR: z.string().default("data/local/imports"),
  LORE_IMPORT_MAX_SOURCE_BYTES: z.coerce.number().int().nonnegative().default(0),
  LORE_IMPORT_GIT_USERNAME: z.string().min(1).default("oauth2"),
  GIT_PATH: z.string().default("git"),
  LORE_TLS: booleanFromEnv,
  LORE_CA_FILE: z.string().optional(),
  LORE_AUDIENCE: z.string().default("lore-portal"),
  GRPC_HOST: z.string().default("0.0.0.0"),
  GRPC_PORT: z.coerce.number().int().positive().default(50051),
  GRPC_TLS_CERT_FILE: z.string().optional(),
  GRPC_TLS_KEY_FILE: z.string().optional(),
  OIDC_CLIENT_ID: z.string().default("lore-cli"),
  OIDC_KEY_ID: z.string().default("lore-portal-1"),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  BOOTSTRAP_ADMIN_USERNAME: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/)
    .default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(6).default("123456"),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default("Yeomai Lore <noreply@example.com>"),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  portalVersion: string;
  publicUrl: string;
  apiInternalUrl: string;
  databasePath: string;
  sessionTtlSeconds: number;
  accessTokenTtlSeconds: number;
  repositoryTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  inviteTtlSeconds: number;
  oidcKeyDir: string;
  oidcClientId: string;
  oidcKeyId: string;
  loreGrpcUrl: string;
  loreHttpUrl: string;
  lorePublicUrl: string;
  loreInternalUrl: string;
  loreCliPath: string;
  loreRuntimeConfigPath: string;
  loreStoragePath: string;
  loreQuicTlsCertFile: string;
  loreQuicTlsKeyFile: string;
  loreSupervisorPidFile: string;
  loreSupervisorSocket: string;
  loreImportWorkDir: string;
  loreImportMaxSourceBytes: number;
  loreImportGitUsername: string;
  gitPath: string;
  loreTls: boolean;
  loreCaFile: string | undefined;
  loreAudience: string;
  grpcHost: string;
  grpcPort: number;
  grpcTlsCertFile: string | undefined;
  grpcTlsKeyFile: string | undefined;
  bootstrapAdminEmail: string;
  bootstrapAdminUsername: string;
  bootstrapAdminPassword: string;
  smtpUrl: string | undefined;
  smtpFrom: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const grpcTlsCertFile = parsed.GRPC_TLS_CERT_FILE
    ? resolveProjectPath(parsed.GRPC_TLS_CERT_FILE)
    : undefined;
  const grpcTlsKeyFile = parsed.GRPC_TLS_KEY_FILE
    ? resolveProjectPath(parsed.GRPC_TLS_KEY_FILE)
    : undefined;
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    portalVersion: parsed.PORTAL_VERSION,
    publicUrl: trimTrailingSlash(parsed.APP_PUBLIC_URL),
    apiInternalUrl: trimTrailingSlash(parsed.API_INTERNAL_URL),
    databasePath: resolveProjectPath(parsed.DATABASE_PATH),
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS,
    accessTokenTtlSeconds: parsed.ACCESS_TOKEN_TTL_SECONDS,
    repositoryTokenTtlSeconds: parsed.REPOSITORY_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: parsed.REFRESH_TOKEN_TTL_SECONDS,
    inviteTtlSeconds: parsed.INVITE_TTL_SECONDS,
    oidcKeyDir: resolveProjectPath(parsed.OIDC_KEY_DIR),
    oidcClientId: parsed.OIDC_CLIENT_ID,
    oidcKeyId: parsed.OIDC_KEY_ID,
    loreGrpcUrl: parsed.LORE_GRPC_URL,
    loreHttpUrl: trimTrailingSlash(parsed.LORE_HTTP_URL),
    lorePublicUrl: trimTrailingSlash(parsed.LORE_PUBLIC_URL),
    loreInternalUrl: trimTrailingSlash(parsed.LORE_INTERNAL_URL),
    loreCliPath: resolveProjectPath(parsed.LORE_CLI_PATH),
    loreRuntimeConfigPath: resolveProjectPath(parsed.LORE_RUNTIME_CONFIG_PATH),
    loreStoragePath: resolveProjectPath(parsed.LORE_STORAGE_PATH),
    loreQuicTlsCertFile: parsed.LORE_QUIC_TLS_CERT_FILE
      ? resolveProjectPath(parsed.LORE_QUIC_TLS_CERT_FILE)
      : (grpcTlsCertFile ??
        resolveProjectPath("./data/dev-certs/grpc.crt")),
    loreQuicTlsKeyFile: parsed.LORE_QUIC_TLS_KEY_FILE
      ? resolveProjectPath(parsed.LORE_QUIC_TLS_KEY_FILE)
      : (grpcTlsKeyFile ??
        resolveProjectPath("./data/dev-certs/grpc.key")),
    loreSupervisorPidFile: resolveProjectPath(
      parsed.LORE_SUPERVISOR_PID_FILE,
    ),
    loreSupervisorSocket: resolveProjectPath(
      parsed.LORE_SUPERVISOR_SOCKET,
    ),
    loreImportWorkDir: resolveProjectPath(parsed.LORE_IMPORT_WORK_DIR),
    loreImportMaxSourceBytes: parsed.LORE_IMPORT_MAX_SOURCE_BYTES,
    loreImportGitUsername: parsed.LORE_IMPORT_GIT_USERNAME,
    gitPath: parsed.GIT_PATH,
    loreTls: parsed.LORE_TLS,
    loreCaFile: parsed.LORE_CA_FILE
      ? resolveProjectPath(parsed.LORE_CA_FILE)
      : undefined,
    loreAudience: parsed.LORE_AUDIENCE,
    grpcHost: parsed.GRPC_HOST,
    grpcPort: parsed.GRPC_PORT,
    grpcTlsCertFile,
    grpcTlsKeyFile,
    bootstrapAdminEmail: parsed.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),
    bootstrapAdminUsername: parsed.BOOTSTRAP_ADMIN_USERNAME,
    bootstrapAdminPassword: parsed.BOOTSTRAP_ADMIN_PASSWORD,
    smtpUrl: parsed.SMTP_URL,
    smtpFrom: parsed.SMTP_FROM,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveProjectPath(value: string): string {
  if (path.isAbsolute(value)) return value;
  const cwd = process.cwd();
  const projectRoot =
    path.basename(cwd) === "server"
      ? path.resolve(cwd, "../..")
      : cwd;
  return path.resolve(projectRoot, value);
}
