import { parse as parseUuid, v7 as uuidv7 } from "uuid";
import { z } from "zod";

export const uuidSchema = z.string().uuid();

export function newId(): string {
  return uuidv7();
}

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

export function uuidToBytes(value: string): Buffer {
  uuidSchema.parse(value);
  return Buffer.from(parseUuid(value));
}

export function bytesToUuid(value: Uint8Array | Buffer): string {
  if (value.length !== 16) {
    throw new Error(`Expected a 16-byte UUID, received ${value.length} bytes`);
  }
  return contextBytesToString(value);
}

export function contextToBytes(value: string): Buffer {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`Expected a 16-byte context, received '${value}'`);
  }
  return Buffer.from(hex, "hex");
}

export function contextBytesToString(value: Uint8Array | Buffer): string {
  if (value.length !== 16) {
    throw new Error(`Expected a 16-byte context, received ${value.length} bytes`);
  }
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function resourceForRepository(id: string): string {
  uuidSchema.parse(id);
  return `urc-${id.replaceAll("-", "")}`;
}

export function repositoryIdFromResource(resource: string): string | null {
  const prefix = "urc-";
  if (!resource.startsWith(prefix)) {
    return null;
  }
  const hex = resource.slice(prefix.length);
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    return null;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
