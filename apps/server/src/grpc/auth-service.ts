import * as grpc from "@grpc/grpc-js";
import {
  AppError,
  loreActionsForPermission,
  repositoryIdFromResource,
  type SessionUser,
} from "@lore-portal/shared";
import type { Database } from "../db/index.ts";
import {
  OAuthProtocolError,
  type OAuthService,
} from "../auth/oauth-service.ts";
import {
  findRepositoryById,
  listAccessibleRepositories,
  repositoryPermission,
} from "../repositories.ts";
import { findUserByUsername, listUsersByIds } from "../auth/users.ts";
import { loreProto } from "../lore/grpc-client.ts";

interface AuthServiceInput {
  db: Database;
  oauth: OAuthService;
}

export function registerUrcAuthGrpcService(
  server: grpc.Server,
  input: AuthServiceInput,
): void {
  const { db, oauth } = input;

  const resolveCaller = (metadata: grpc.Metadata) =>
    oauth.verifyBearerContext(authorizationHeader(metadata));

  server.addService(loreProto.epic_urc.UrcAuthApi.service, {
    healthCheck: (
      _call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) => {
      callback(null, { status: "ok" });
    },

    checkUserPermission: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) => {
      try {
        const { user } = await resolveCaller(call.metadata);
        const { allowed, denied } = await checkResourcePermissions({
          db,
          user,
          resourceIds: call.request.resourceId ?? [],
        });
        callback(null, {
          allowedResourcePermission: allowed,
          deniedResourcePermission: denied,
        });
      } catch (error) {
        callback(grpcStatus(error));
      }
    },

    lookupUserPermissions: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) => {
      try {
        const { user } = await resolveCaller(call.metadata);
        const repositories = await listAccessibleRepositories(db, user);
        const resources = [];
        for (const repository of repositories) {
          if (repository.status !== "active") continue;
          const permission = await repositoryPermission(db, user, repository);
          if (!permission) continue;
          resources.push({
            resourceId: `urc-${repository.id.replaceAll("-", "")}`,
            permission: loreActionsForPermission(permission),
          });
        }
        callback(null, {
          resourcePermission: resources,
        });
      } catch (error) {
        callback(grpcStatus(error));
      }
    },

    getUserInfo: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) => {
      try {
        await resolveCaller(call.metadata);
        const users = await listUsersByIds(db, call.request.userId ?? []);
        callback(null, {
          userInfo: users.map((user) => ({
            userId: user.id,
            displayName: user.displayName,
          })),
        });
      } catch (error) {
        callback(grpcStatus(error));
      }
    },

    getUserId: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) => {
      try {
        await resolveCaller(call.metadata);
        const user = await findUserByUsername(
          db,
          call.request.userDisplayName ?? "",
        );
        callback(null, {
          userInfo: user
            ? { userId: user.id, displayName: user.displayName }
            : { userId: "", displayName: "" },
        });
      } catch (error) {
        callback(grpcStatus(error));
      }
    },

    getProviderUserId: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) => {
      try {
        await resolveCaller(call.metadata);
        const userId = String(call.request.userId ?? "");
        callback(null, {
          userId,
          providerUserId: userId,
        });
      } catch (error) {
        callback(grpcStatus(error));
      }
    },
  });
}

export async function checkResourcePermissions(input: {
  db: Database;
  user: SessionUser;
  resourceIds: string[];
}): Promise<{
  allowed: Array<{ resourceId: string; permission: string[] }>;
  denied: Array<{ resourceId: string; permission: string[] }>;
}> {
  const allowed: Array<{ resourceId: string; permission: string[] }> = [];
  const denied: Array<{ resourceId: string; permission: string[] }> = [];
  for (const resourceId of input.resourceIds) {
    const repositoryId = repositoryIdFromResource(resourceId);
    const repository = repositoryId
      ? await findRepositoryById(input.db, repositoryId)
      : null;
    const permission =
      repository && repository.status === "active"
        ? await repositoryPermission(input.db, input.user, repository)
        : null;
    if (permission) {
      allowed.push({
        resourceId,
        permission: loreActionsForPermission(permission),
      });
    } else {
      denied.push({ resourceId, permission: [] });
    }
  }
  return { allowed, denied };
}

function authorizationHeader(metadata: grpc.Metadata): string | undefined {
  const value = metadata.get("authorization")[0];
  return typeof value === "string" ? value : value?.toString();
}

function grpcStatus(error: unknown): grpc.ServiceError {
  let code = grpc.status.INTERNAL;
  if (error instanceof OAuthProtocolError || (error instanceof AppError && error.code === "unauthorized")) {
    code = grpc.status.UNAUTHENTICATED;
  } else if (error instanceof AppError) {
    if (error.code === "forbidden") code = grpc.status.PERMISSION_DENIED;
    if (error.code === "not_found") code = grpc.status.NOT_FOUND;
    if (error.code === "bad_request") code = grpc.status.INVALID_ARGUMENT;
  }
  const message = error instanceof Error ? error.message : "Internal error";
  return Object.assign(new Error(message), {
    code,
    details: message,
    metadata: new grpc.Metadata(),
  });
}
