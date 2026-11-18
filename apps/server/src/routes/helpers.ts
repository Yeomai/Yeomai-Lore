import type { z } from "zod";
import { badRequest } from "@lore-portal/shared";

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest("Invalid request", result.error.flatten());
  }
  return result.data;
}
