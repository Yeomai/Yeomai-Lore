import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function ensureInternalGatewaySecret(filePath: string): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const secret = randomBytes(32).toString("hex");
  writeFileSync(filePath, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function internalSecretMatches(
  expected: string,
  candidate: string | undefined,
): boolean {
  if (!candidate) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length &&
    timingSafeEqual(expectedBytes, candidateBytes)
  );
}
