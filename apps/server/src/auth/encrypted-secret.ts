import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.ts";

const VERSION = "v1";
const keyCache = new Map<string, Buffer>();

async function encryptionKey(config: AppConfig): Promise<Buffer> {
  const cached = keyCache.get(config.oidcKeyDir);
  if (cached) return cached;
  const privateKey = await readFile(
    path.join(config.oidcKeyDir, "oidc-private.pem"),
    "utf8",
  );
  const key = createHash("sha256").update(privateKey).digest();
  keyCache.set(config.oidcKeyDir, key);
  return key;
}

export async function encryptSecret(
  config: AppConfig,
  value: string,
  purpose: string,
): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    await encryptionKey(config),
    iv,
  );
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export async function decryptSecret(
  config: AppConfig,
  value: string | null,
  purpose: string,
): Promise<string | null> {
  if (!value) return null;
  try {
    const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
    if (
      version !== VERSION ||
      !ivValue ||
      !tagValue ||
      !ciphertextValue
    ) {
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      await encryptionKey(config),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
