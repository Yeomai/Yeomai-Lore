import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomUserCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => userCodeAlphabet[byte % 32]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatUserCode(value: string): string {
  const normalized = normalizeUserCode(value);
  return normalized.length === 8
    ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
    : normalized;
}
