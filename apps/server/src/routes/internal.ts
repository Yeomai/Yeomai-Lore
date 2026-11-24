import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  AppError,
  bytesToUuid,
  permissionSatisfies,
  repositoryIdFromResource,
} from "@lore-portal/shared";
import {
  internalSecretMatches,
  isLoopbackAddress,
} from "../internal-gateway-auth.ts";
import {
  findRepositoryById,
  repositoryPermission,
} from "../repositories.ts";
import { assertPersonalRepositoryPushQuota } from "../user-quota.ts";
import { parseInput } from "./helpers.ts";

const branchPushCheckSchema = z.object({
  authorization: z.string().min(1),
  repositoryId: z.string().optional(),
  branchId: z.string().min(1),
  revisionSignature: z.string().regex(/^[0-9a-f]{64}$/i),
  force: z.boolean(),
  fastForwardMerge: z.boolean(),
});

export const registerInternalRoutes: FastifyPluginAsync = async (app) => {
  const { db, lore, oauth, tokens } = app.services;

  app.post("/branch-push/check", async (request) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new AppError("not_found", 404, "Route not found");
    }
    if (
      !internalSecretMatches(
        app.services.internalGatewaySecret ?? "",
        request.headers["x-yeomai-internal-secret"] as string | undefined,
      )
    ) {
      throw new AppError("forbidden", 403, "Internal request denied");
    }

    const input = parseInput(branchPushCheckSchema, request.body);
    const { user, payload } = await oauth.verifyBearerContext(
      input.authorization,
    );
    const repositoryId =
      (input.repositoryId
        ? bytesToUuid(Buffer.from(input.repositoryId, "base64"))
        : undefined) ?? repositoryIdFromToken(payload);
    if (!repositoryId) {
      throw new AppError(
        "forbidden",
        403,
        "Repository-scoped authorization is required",
      );
    }
    const repository = await findRepositoryById(db, repositoryId);
    if (!repository || repository.status !== "active") {
      throw new AppError("not_found", 404, "Repository not found");
    }
    const permission = await repositoryPermission(db, user, repository);
    if (!permissionSatisfies(permission, "write")) {
      throw new AppError(
        "forbidden",
        403,
        "You do not have write access to this repository",
      );
    }
    if (!tokenAllowsRepositoryWrite(payload, repositoryId)) {
      throw new AppError(
        "forbidden",
        403,
        "Repository authorization does not permit writes",
      );
    }

    const branchId = Buffer.from(input.branchId, "base64").toString("hex");
    if (!/^[0-9a-f]{32}$/i.test(branchId)) {
      throw new AppError("bad_request", 400, "Invalid branch identifier");
    }
    await assertPersonalRepositoryPushQuota({
      db,
      lore,
      tokens,
      user,
      repository,
      revisionSignature: input.revisionSignature,
      branchId: `${branchId.slice(0, 8)}-${branchId.slice(8, 12)}-${branchId.slice(12, 16)}-${branchId.slice(16, 20)}-${branchId.slice(20)}`,
      fastForwardMerge: input.fastForwardMerge,
      token: input.authorization.replace(/^Bearer\s+/i, ""),
    });
    return { allowed: true };
  });
};

function repositoryIdFromToken(
  payload: Record<string, unknown>,
): string | null {
  const resources = Array.isArray(payload.resources)
    ? payload.resources
    : [];
  for (const resource of resources) {
    if (
      resource &&
      typeof resource === "object" &&
      typeof (resource as { resource_id?: unknown }).resource_id === "string"
    ) {
      const repositoryId = repositoryIdFromResource(
        (resource as { resource_id: string }).resource_id,
      );
      if (repositoryId) return repositoryId;
    }
  }
  return null;
}

function tokenAllowsRepositoryWrite(
  payload: Record<string, unknown>,
  repositoryId: string,
): boolean {
  const resources = Array.isArray(payload.resources)
    ? payload.resources
    : [];
  return resources.some((resource) => {
    if (!resource || typeof resource !== "object") return false;
    const value = resource as {
      resource_id?: unknown;
      permission?: unknown;
    };
    return (
      typeof value.resource_id === "string" &&
      repositoryIdFromResource(value.resource_id) === repositoryId &&
      Array.isArray(value.permission) &&
      value.permission.includes("write")
    );
  });
}
