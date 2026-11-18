import type { AppConfig } from "./config.ts";
import type { QueryExecutor } from "./db/index.ts";
import nodemailer from "nodemailer";
import { z } from "zod";
import {
  decryptSecret,
  encryptSecret,
} from "./auth/encrypted-secret.ts";
import { setSystemSetting } from "./settings.ts";

const SMTP_ENABLED = "smtp_enabled";
const SMTP_HOST = "smtp_host";
const SMTP_PORT = "smtp_port";
const SMTP_SECURITY = "smtp_security";
const SMTP_USERNAME = "smtp_username";
const SMTP_PASSWORD = "smtp_password_ciphertext";
const SMTP_FROM_NAME = "smtp_from_name";
const SMTP_FROM_EMAIL = "smtp_from_email";
const PASSWORD_PURPOSE = "lore-smtp-password";

export type SmtpSecurity = "starttls" | "ssl" | "none";

export const smtpSettingsSchema = z
  .object({
    enabled: z.boolean(),
    host: z
      .string()
      .trim()
      .max(255)
      .refine(
        (value) =>
          value === "" ||
          /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])$/.test(value),
        "SMTP host is invalid",
      ),
    port: z.number().int().min(1).max(65_535),
    security: z.enum(["starttls", "ssl", "none"]),
    username: z.string().trim().max(255),
    password: z.string().max(1_024),
    fromName: z
      .string()
      .trim()
      .max(80)
      .refine((value) => !/[\r\n<>]/.test(value), "SMTP sender name is invalid"),
    fromEmail: z.union([z.string().trim().email().max(254), z.literal("")]),
  })
  .superRefine((value, context) => {
    if (!value.enabled) return;
    if (!value.host) {
      context.addIssue({
        code: "custom",
        path: ["host"],
        message: "SMTP host is required",
      });
    }
    if (!value.fromEmail) {
      context.addIssue({
        code: "custom",
        path: ["fromEmail"],
        message: "SMTP sender email is required",
      });
    }
  });

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
}

export async function readSmtpSettings(
  db: QueryExecutor,
): Promise<SmtpSettings> {
  const result = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM system_settings
      WHERE key IN ($1, $2, $3, $4, $5, $6, $7)`,
    [
      SMTP_ENABLED,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_SECURITY,
      SMTP_USERNAME,
      SMTP_FROM_NAME,
      SMTP_FROM_EMAIL,
    ],
  );
  const values = new Map(result.rows.map((row) => [row.key, row.value]));
  const security = values.get(SMTP_SECURITY);
  return {
    enabled: values.get(SMTP_ENABLED) === "true",
    host: values.get(SMTP_HOST) ?? "",
    port: Number(values.get(SMTP_PORT) ?? 587),
    security:
      security === "starttls" || security === "none" ? security : "ssl",
    username: values.get(SMTP_USERNAME) ?? "",
    password: "",
    fromName: values.get(SMTP_FROM_NAME) ?? "",
    fromEmail: values.get(SMTP_FROM_EMAIL) ?? "",
  };
}

export async function applySmtpSettings(
  db: QueryExecutor,
  config: AppConfig,
): Promise<void> {
  const stored = await db.query<{ value: string }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [SMTP_ENABLED],
  );
  if (!stored.rows[0]) {
    return;
  }
  const settings = await readSmtpSettings(db);
  if (!settings.enabled) {
    config.smtpUrl = undefined;
    config.smtpFrom = "";
    return;
  }
  const password = await readSmtpPassword(db, config);
  config.smtpUrl = buildSmtpUrl(settings, password);
  config.smtpFrom = formatFrom(settings.fromName, settings.fromEmail);
}

export async function saveSmtpSettings(
  db: QueryExecutor,
  config: AppConfig,
  settings: SmtpSettings,
  preservePassword = false,
): Promise<void> {
  let passwordCiphertext = "";
  if (settings.enabled && settings.password) {
    passwordCiphertext = await encryptSecret(
      config,
      settings.password,
      PASSWORD_PURPOSE,
    );
  } else if (settings.enabled && preservePassword) {
    const existing = await db.query<{ value: string }>(
      "SELECT value FROM system_settings WHERE key = $1",
      [SMTP_PASSWORD],
    );
    passwordCiphertext = existing.rows[0]?.value ?? "";
  }
  await setSystemSetting(db, SMTP_ENABLED, String(settings.enabled));
  await setSystemSetting(db, SMTP_HOST, settings.enabled ? settings.host : "");
  await setSystemSetting(
    db,
    SMTP_PORT,
    settings.enabled ? String(settings.port) : "587",
  );
  await setSystemSetting(
    db,
    SMTP_SECURITY,
    settings.enabled ? settings.security : "ssl",
  );
  await setSystemSetting(
    db,
    SMTP_USERNAME,
    settings.enabled ? settings.username : "",
  );
  await setSystemSetting(db, SMTP_PASSWORD, passwordCiphertext);
  await setSystemSetting(
    db,
    SMTP_FROM_NAME,
    settings.enabled ? settings.fromName : "",
  );
  await setSystemSetting(
    db,
    SMTP_FROM_EMAIL,
    settings.enabled ? settings.fromEmail : "",
  );
}

export async function hasSmtpPassword(db: QueryExecutor): Promise<boolean> {
  const result = await db.query<{ value: string }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [SMTP_PASSWORD],
  );
  return Boolean(result.rows[0]?.value);
}

export async function readSmtpPassword(
  db: QueryExecutor,
  config: AppConfig,
): Promise<string> {
  const result = await db.query<{ value: string }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [SMTP_PASSWORD],
  );
  return (
    (await decryptSecret(
      config,
      result.rows[0]?.value ?? null,
      PASSWORD_PURPOSE,
    )) ?? ""
  );
}

export function buildSmtpUrl(
  settings: SmtpSettings,
  password = settings.password,
): string {
  const scheme = settings.security === "ssl" ? "smtps" : "smtp";
  const credentials = settings.username
    ? `${encodeURIComponent(settings.username)}:${encodeURIComponent(password)}@`
    : "";
  return `${scheme}://${credentials}${settings.host}:${settings.port}`;
}

export function formatFrom(name: string, email: string): string {
  return name.trim() ? `${name.trim()} <${email}>` : email;
}

export async function sendSmtpTestEmail(
  settings: SmtpSettings,
  recipientEmail: string,
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === "ssl",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    auth: settings.username
      ? { user: settings.username, pass: settings.password }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({
      from: formatFrom(settings.fromName, settings.fromEmail),
      to: recipientEmail,
      subject: "Lore测试",
      text: "这是一封测试邮件",
    });
  } finally {
    transport.close();
  }
}
