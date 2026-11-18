import type { AppConfig } from "../config.ts";
import { decryptSecret, encryptSecret } from "./encrypted-secret.ts";

const PURPOSE = "lore-invite-link";

export async function encryptInviteToken(
  config: AppConfig,
  token: string,
): Promise<string> {
  return encryptSecret(config, token, PURPOSE);
}

export async function decryptInviteToken(
  config: AppConfig,
  value: string | null,
): Promise<string | null> {
  return decryptSecret(config, value, PURPOSE);
}
