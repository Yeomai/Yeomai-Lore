import {
  X509Certificate,
  randomBytes,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { badRequest } from "@lore-portal/shared";
import type { AppConfig } from "./config.ts";
import {
  withTransaction,
  type Database,
  type QueryExecutor,
} from "./db/index.ts";
import { isUserRegistrationEnabled } from "./settings.ts";

const SITE_NAME = "site_name";
const WEB_PUBLIC_URL = "web_public_url";
const LORE_PUBLIC_URL = "lore_public_url";
export const LORE_STORE_MAX_SIZE_BYTES = 80_530_636_800;
export const LORE_STORE_COMPACTION_DELAY_MS = 48 * 60 * 60 * 1_000;

export interface SiteSettings {
  siteName: string;
  webPublicUrl: string;
  lorePublicUrl: string;
}

export interface LoreStoreGcConfig {
  maxSize: number;
  compactionDelay: number;
}

export type DeploymentMode = "local" | "ip" | "domain";

export function deploymentModeForAddress(webPublicUrl: string): DeploymentMode {
  const host = new URL(webPublicUrl).hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  ) {
    return "local";
  }
  return isIP(host) > 0 ? "ip" : "domain";
}

const execFileAsync = promisify(execFile);

export interface LegacyAddressMigration {
  previousWebPublicUrl: string;
  webPublicUrl: string;
  previousLorePublicUrl: string;
  lorePublicUrl: string;
  revokedSessions: number;
  revokedOAuthTokens: number;
  invalidatedUsers: number;
}

export async function isSetupRequired(db: QueryExecutor): Promise<boolean> {
  const result = await db.query<{ count: number }>(
    "SELECT count(*) AS count FROM users",
  );
  return Number(result.rows[0]?.count ?? 0) === 0;
}

export async function readSiteSettings(
  db: QueryExecutor,
  config: AppConfig,
): Promise<SiteSettings> {
  const result = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM system_settings
      WHERE key IN ($1, $2, $3)`,
    [SITE_NAME, WEB_PUBLIC_URL, LORE_PUBLIC_URL],
  );
  const values = new Map(result.rows.map((row) => [row.key, row.value]));
  return {
    siteName: values.get(SITE_NAME) || "Yeomai Lore",
    webPublicUrl: values.get(WEB_PUBLIC_URL) || config.publicUrl,
    lorePublicUrl: values.get(LORE_PUBLIC_URL) || config.lorePublicUrl,
  };
}

export async function applySiteSettings(
  db: QueryExecutor,
  config: AppConfig,
): Promise<SiteSettings> {
  const settings = await readSiteSettings(db, config);
  config.publicUrl = settings.webPublicUrl;
  config.lorePublicUrl = settings.lorePublicUrl;
  return settings;
}

export async function migrateLegacyUnifiedAddress(
  db: Database,
  config?: AppConfig,
): Promise<LegacyAddressMigration | null> {
  const result = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM system_settings
      WHERE key IN ($1, $2, $3)`,
    [WEB_PUBLIC_URL, LORE_PUBLIC_URL, "legacy_lore_public_url"],
  );
  const values = new Map(result.rows.map((row) => [row.key, row.value]));
  const webPublicUrl = values.get(WEB_PUBLIC_URL);
  const lorePublicUrl = values.get(LORE_PUBLIC_URL);
  if (!webPublicUrl || !lorePublicUrl) return null;
  const sourceLorePublicUrl =
    values.get("legacy_lore_public_url") ?? lorePublicUrl;

  const desired = unifiedSiteUrls(webPublicUrl, sourceLorePublicUrl);
  if (
    !desired ||
    (desired.webPublicUrl === webPublicUrl &&
      desired.lorePublicUrl === lorePublicUrl)
  ) {
    return null;
  }

  if (config && loreCertificateRequired(desired.lorePublicUrl)) {
    let certificateChain: string;
    let privateKey: string;
    try {
      [certificateChain, privateKey] = await Promise.all([
        readFile(config.loreQuicTlsCertFile, "utf8"),
        readFile(config.loreQuicTlsKeyFile, "utf8"),
      ]);
    } catch (error) {
      throw new Error(
        `Unified Lore address ${desired.lorePublicUrl} requires a readable certificate at ${config.loreQuicTlsCertFile}`,
        { cause: error },
      );
    }
    await validateLoreCertificate({
      lorePublicUrl: desired.lorePublicUrl,
      certificateChain,
      privateKey,
    });
  }

  return withTransaction(db, async (client) => {
    await client.query(
      `UPDATE system_settings
          SET value = $1, updated_at = CURRENT_TIMESTAMP
        WHERE key = $2`,
      [desired.webPublicUrl, WEB_PUBLIC_URL],
    );
    await client.query(
      `UPDATE system_settings
          SET value = $1, updated_at = CURRENT_TIMESTAMP
        WHERE key = $2`,
      [desired.lorePublicUrl, LORE_PUBLIC_URL],
    );
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('legacy_web_public_url', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO NOTHING`,
      [webPublicUrl],
    );
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('legacy_lore_public_url', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO NOTHING`,
      [lorePublicUrl],
    );
    const sessions = await client.query(
      `UPDATE sessions
          SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
        WHERE revoked_at IS NULL`,
    );
    const tokens = await client.query(
      `UPDATE oauth_refresh_tokens
          SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
        WHERE revoked_at IS NULL`,
    );
    const users = await client.query(
      `UPDATE users
          SET oauth_epoch = oauth_epoch + 1,
              updated_at = CURRENT_TIMESTAMP`,
    );
    await client.query(
      `INSERT INTO schema_migrations (version, applied_at)
       VALUES ('site_addresses_unified_v2', CURRENT_TIMESTAMP)
       ON CONFLICT (version) DO NOTHING`,
    );
    return {
      previousWebPublicUrl: webPublicUrl,
      webPublicUrl: desired.webPublicUrl,
      previousLorePublicUrl: lorePublicUrl,
      lorePublicUrl: desired.lorePublicUrl,
      revokedSessions: sessions.rowCount,
      revokedOAuthTokens: tokens.rowCount,
      invalidatedUsers: users.rowCount,
    };
  });
}

export async function readSetupDefaults(
  db: QueryExecutor,
  config: AppConfig,
): Promise<{
  siteName: string;
  webPublicUrl: string;
  lorePublicUrl: string;
  userRegistrationEnabled: boolean;
}> {
  return {
    ...(await readSiteSettings(db, config)),
    userRegistrationEnabled: await isUserRegistrationEnabled(db),
  };
}

function unifiedSiteUrls(
  webPublicUrl: string,
  lorePublicUrl: string,
): { webPublicUrl: string; lorePublicUrl: string } | null {
  let web: URL;
  let lore: URL;
  try {
    web = new URL(webPublicUrl);
    lore = new URL(lorePublicUrl);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(web.protocol) ||
    !["lore:", "lores:", "grpc:", "grpcs:"].includes(lore.protocol)
  ) {
    return null;
  }

  const loreHost = lore.hostname.replace(/^\[|\]$/g, "");
  const webHost = web.hostname.replace(/^\[|\]$/g, "");
  const canonicalHost = ["127.0.0.1", "::1"].includes(loreHost)
    ? webHost
    : loreHost;
  const renderedHost = canonicalHost.includes(":")
    ? `[${canonicalHost}]`
    : canonicalHost;
  const port = web.port || (web.protocol === "https:" ? "443" : "80");
  const loreProtocol = web.protocol === "https:" ? "lores:" : "lore:";
  return {
    webPublicUrl: `${web.protocol}//${renderedHost}${
      web.port ? `:${web.port}` : ""
    }`,
    lorePublicUrl: `${loreProtocol}//${renderedHost}${
      loreProtocol === "lores:" && port === "443" ? "" : `:${port}`
    }`,
  };
}

export function validateWebPublicUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("Web address is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw badRequest("Web address must use http:// or https://");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw badRequest("Web address must contain only a scheme, host, and port");
  }
}

export function normalizeUnifiedSiteAddress(value: string): {
  webPublicUrl: string;
  lorePublicUrl: string;
} {
  const trimmed = value.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const authority = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = authority.match(/^\[([^\]]+)\]/)?.[1] ??
    authority.split(":")[0] ??
    "";
  const candidate = hasScheme
    ? trimmed
    : `${isLocalOrCommonLanHost(host) ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw badRequest("Site address is invalid");
  }
  validateWebPublicUrl(parsed.origin);
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw badRequest("Site address must contain only a host and optional port");
  }
  const loreProtocol = parsed.protocol === "https:" ? "lores:" : "lore:";
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return {
    webPublicUrl: parsed.origin,
    lorePublicUrl: `${loreProtocol}//${parsed.hostname}${
      loreProtocol === "lores:" && port === "443" ? "" : `:${port}`
    }`,
  };
}

export function normalizeLorePublicUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("Lore address is invalid");
  }
  const normalizedProtocol =
    parsed.protocol === "https:"
      ? "grpcs:"
      : parsed.protocol === "http:"
        ? "grpc:"
        : parsed.protocol;
  if (!["lore:", "lores:", "grpc:", "grpcs:"].includes(normalizedProtocol)) {
    throw badRequest(
      "Lore address must use lore://, lores://, grpcs://, or https://",
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw badRequest("Lore address must contain only a scheme, host, and port");
  }
  const hostname =
    parsed.hostname.startsWith("[") || !parsed.hostname.includes(":")
      ? parsed.hostname
      : `[${parsed.hostname}]`;
  const defaultPort = ["https:", "grpcs:", "lores:"].includes(
    normalizedProtocol,
  )
    ? "443"
    : normalizedProtocol === "lore:"
      ? "3000"
      : "80";
  const port = parsed.port || defaultPort;
  return `${normalizedProtocol}//${hostname}${
    defaultPort === "443" && port === "443" ? "" : `:${port}`
  }`;
}

export function isLocalOrCommonLanHost(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) {
    return true;
  }
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

export function loreCertificateRequired(lorePublicUrl: string): boolean {
  const parsed = new URL(lorePublicUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return !isLocalOrCommonLanHost(host) && isIP(host) === 0;
}

export async function validateLoreCertificate(input: {
  lorePublicUrl: string;
  certificateChain: string;
  privateKey: string;
}): Promise<void> {
  if (!input.certificateChain.trim() || !input.privateKey.trim()) {
    throw badRequest("Lore certificate and private key are required");
  }

  let certificate: X509Certificate;
  let privateKey;
  try {
    certificate = new X509Certificate(input.certificateChain);
    privateKey = createPrivateKey(input.privateKey);
  } catch {
    throw badRequest("Lore certificate or private key is invalid");
  }

  const certificateKey = certificate.publicKey.export({
    type: "spki",
    format: "der",
  });
  const privatePublicKey = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  if (!certificateKey.equals(privatePublicKey)) {
    throw badRequest("Lore certificate and private key do not match");
  }

  const now = Date.now();
  if (now < Date.parse(certificate.validFrom)) {
    throw badRequest("Lore certificate is not valid yet");
  }
  if (now > Date.parse(certificate.validTo)) {
    throw badRequest("Lore certificate has expired");
  }

  const hostname = new URL(input.lorePublicUrl).hostname.replace(/^\[|\]$/g, "");
  const matches =
    isIP(hostname) > 0
      ? certificate.checkIP(hostname)
      : certificate.checkHost(hostname);
  if (!matches) {
    throw badRequest("Lore certificate does not cover the Lore address hostname");
  }
}

export async function writeLoreCertificate(
  config: AppConfig,
  certificateChain: string,
  privateKey: string,
): Promise<void> {
  await writeFileAtomic(config.loreQuicTlsCertFile, certificateChain, 0o644);
  await writeFileAtomic(config.loreQuicTlsKeyFile, privateKey, 0o600);
}

export async function readLoreCertificateStatus(config: AppConfig) {
  const [certificatePem, privateKeyPem] = await Promise.all([
    readFile(config.loreQuicTlsCertFile, "utf8").catch(() => null),
    readFile(config.loreQuicTlsKeyFile, "utf8").catch(() => null),
  ]);
  if (!certificatePem || !privateKeyPem) {
    return {
      configured: false,
      invalid: false,
      subject: null,
      issuer: null,
      validFrom: null,
      validTo: null,
      fingerprint256: null,
      ipAddresses: [],
    };
  }
  try {
    const certificate = new X509Certificate(certificatePem);
    const privateKey = createPrivateKey(privateKeyPem);
    const certificateKey = certificate.publicKey.export({
      type: "spki",
      format: "der",
    });
    const privatePublicKey = createPublicKey(privateKey).export({
      type: "spki",
      format: "der",
    });
    if (!certificateKey.equals(privatePublicKey)) {
      throw new Error("Certificate key mismatch");
    }
    return {
      configured: true,
      invalid: false,
      subject: certificate.subject.replaceAll("\n", ", "),
      issuer: certificate.issuer.replaceAll("\n", ", "),
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString(),
      fingerprint256: certificate.fingerprint256,
      ipAddresses: certificate.subjectAltName
        ?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("IP Address:"))
        .map((entry) => entry.slice("IP Address:".length))
        .filter(
          (address) =>
            ![
              "127.0.0.1",
              "::1",
              "0:0:0:0:0:0:0:1",
            ].includes(address),
        ) ?? [],
    };
  } catch {
    return {
      configured: true,
      invalid: true,
      subject: null,
      issuer: null,
      validFrom: null,
      validTo: null,
      fingerprint256: null,
      ipAddresses: [],
    };
  }
}

export async function issueLoreIpCertificate(
  config: AppConfig,
  requestedIpAddresses: string[],
  lorePublicUrl = config.lorePublicUrl,
): Promise<{
  certificateChain: string;
  privateKey: string;
  ipAddresses: string[];
}> {
  if (!config.loreCaFile || !config.loreCaKeyFile) {
    throw badRequest("The local root CA is not configured");
  }
  const currentHost = new URL(lorePublicUrl).hostname.replace(
    /^\[|\]$/g,
    "",
  );
  if (isIP(currentHost) === 0) {
    throw badRequest(
      "IP certificate issuance requires an IP-based Lore site address",
    );
  }
  const ipAddresses = [
    ...new Set(
      [currentHost, "127.0.0.1", "::1", ...requestedIpAddresses].map(
        normalizeCertificateIp,
      ),
    ),
  ];
  const visibleIpAddresses = ipAddresses.filter(
    (address) =>
      !["127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(address),
  );
  const directory = await mkdtemp(path.join(tmpdir(), "lore-ip-certificate-"));
  const keyPath = path.join(directory, "lore.key");
  const csrPath = path.join(directory, "lore.csr");
  const certificatePath = path.join(directory, "lore.crt");
  const extensionPath = path.join(directory, "lore.ext");
  try {
    await writeFile(
      extensionPath,
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=DNS:localhost,${ipAddresses
          .map((address) => `IP:${address}`)
          .join(",")}`,
        "authorityKeyIdentifier=keyid,issuer",
        "subjectKeyIdentifier=hash",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await execFileAsync("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=${currentHost}`,
    ]);
    await execFileAsync("openssl", [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "3650",
      "-in",
      csrPath,
      "-CA",
      config.loreCaFile,
      "-CAkey",
      config.loreCaKeyFile,
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-out",
      certificatePath,
      "-extfile",
      extensionPath,
    ]);
    const [certificateChain, privateKey] = await Promise.all([
      readFile(certificatePath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    await validateLoreCertificate({
      lorePublicUrl,
      certificateChain,
      privateKey,
    });
    return { certificateChain, privateKey, ipAddresses: visibleIpAddresses };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function normalizeCertificateIp(value: string): string {
  const address = value.trim().replace(/^\[|\]$/g, "");
  if (isIP(address) === 0) {
    throw badRequest(`Invalid IP address: ${value}`);
  }
  return address;
}

export async function readLoreStoreGcConfig(
  configPath: string,
): Promise<LoreStoreGcConfig> {
  const content = await readFile(configPath, "utf8").catch(() => "");
  const section = readTomlTable(content, "immutable_store.local");
  return {
    maxSize:
      readTomlInteger(section, "max_size") ?? LORE_STORE_MAX_SIZE_BYTES,
    compactionDelay:
      readTomlInteger(section, "compaction_delay") ??
      LORE_STORE_COMPACTION_DELAY_MS,
  };
}

export async function writeLoreRuntimeConfig(
  config: AppConfig,
  settings: SiteSettings,
): Promise<void> {
  const storeGc = await readLoreStoreGcConfig(config.loreRuntimeConfigPath);
  const content = `[environment.endpoint]
user_url = ${tomlString(`https://localhost:${config.grpcPort}`)}
auth_url = ${tomlString(`https://localhost:${config.grpcPort}`)}

[server.auth]
jwt_issuer = ${tomlString(settings.webPublicUrl)}
jwt_audience = [${tomlString(config.loreAudience)}]
jwt_typ = "at+jwt"

[server.auth.jwk]
endpoint = ${tomlString(`http://localhost:${config.port}/.well-known/jwks.json`)}

[server.auth.oidc]
client_id = ${tomlString(config.oidcClientId)}
scopes = ["openid", "offline_access"]
preferred = true
token_exchange_issuer = ${tomlString(settings.webPublicUrl)}
resource_template = ${tomlString(`${settings.webPublicUrl}/lore/repositories/{id}`)}

[server.http]
host = "0.0.0.0"
port = 41339

[server.quic.certificate]
cert_file = ${tomlString(config.loreQuicTlsCertFile)}
pkey_file = ${tomlString(config.loreQuicTlsKeyFile)}

[immutable_store.local]
path = ${tomlString(config.loreStoragePath)}
flush_delay_seconds = 2
max_size = ${storeGc.maxSize}
compaction_delay = ${storeGc.compactionDelay}

[mutable_store.local]
path = ${tomlString(config.loreStoragePath)}
flush_delay_seconds = 2
`;
  await mkdir(path.dirname(config.loreRuntimeConfigPath), { recursive: true });
  await writeFile(config.loreRuntimeConfigPath, content, { mode: 0o600 });
}

function readTomlTable(content: string, table: string): string {
  const lines = content.split(/\r?\n/);
  let active = false;
  const selected: string[] = [];
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      active = header[1] === table;
      continue;
    }
    if (active) selected.push(line);
  }
  return selected.join("\n");
}

function readTomlInteger(content: string, key: string): number | null {
  const match = new RegExp(
    `^\\s*${key}\\s*=\\s*(\\d[\\d_]*)\\s*(?:#.*)?$`,
    "m",
  ).exec(content);
  if (!match) return null;
  const value = Number(match[1]!.replaceAll("_", ""));
  return Number.isSafeInteger(value) ? value : null;
}

async function writeFileAtomic(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { mode });
  await rename(temporaryPath, filePath);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
