import * as grpc from "@grpc/grpc-js";
import { readFileSync } from "node:fs";
import {
  AppError,
  bytesToUuid,
  permissionSatisfies,
  uuidToBytes,
  type SessionUser,
} from "@lore-portal/shared";
import type { AppConfig } from "../config.ts";
import type { Database } from "../db/index.ts";
import type { OAuthService } from "../auth/oauth-service.ts";
import { OAuthProtocolError } from "../auth/oauth-service.ts";
import type { TokenService } from "../auth/token-service.ts";
import { issueRepositoryToken } from "../auth/repository-auth.ts";
import {
  findRepositoryById,
  listAccessibleRepositories,
  markRepositoryStatus,
  registerRepositoryFromLore,
  repositoryPermission,
  updateRepositoryDefaultBranch,
} from "../repositories.ts";
import { findUserByUsername, listUsersByIds } from "../auth/users.ts";
import { loreProto } from "../lore/grpc-client.ts";
import type { LoreClient } from "../lore/types.ts";
import { registerUrcAuthGrpcService } from "./auth-service.ts";

function authorizationHeader(metadata: grpc.Metadata): string | undefined {
  const value = metadata.get("authorization")[0];
  return typeof value === "string" ? value : value?.toString();
}

function grpcStatus(error: unknown): grpc.ServiceError {
  if (error instanceof OAuthProtocolError) {
    return Object.assign(new Error(error.message), {
      code: grpc.status.UNAUTHENTICATED,
      details: error.message,
      metadata: new grpc.Metadata(),
    });
  }
  if (error instanceof AppError) {
    let code: grpc.status = grpc.status.INTERNAL;
    switch (error.code) {
      case "bad_request":
        code = grpc.status.INVALID_ARGUMENT;
        break;
      case "forbidden":
        code = grpc.status.PERMISSION_DENIED;
        break;
      case "not_found":
        code = grpc.status.NOT_FOUND;
        break;
      case "unauthorized":
        code = grpc.status.UNAUTHENTICATED;
        break;
      case "conflict":
        code = grpc.status.ALREADY_EXISTS;
        break;
    }
    return Object.assign(new Error(error.message), {
      code,
      details: error.message,
      metadata: new grpc.Metadata(),
    });
  }
  const message = error instanceof Error ? error.message : "Internal error";
  return Object.assign(new Error(message), {
    code: grpc.status.INTERNAL,
    details: message,
    metadata: new grpc.Metadata(),
  });
}

export async function startRegistryGrpcServer(input: {
  config: AppConfig;
  db: Database;
  oauth: OAuthService;
  tokens: TokenService;
  lore: LoreClient;
}): Promise<grpc.Server> {
  const { config, db, oauth, tokens, lore } = input;
  const server = new grpc.Server();
  const pendingActivations = new Set<string>();
  registerUrcAuthGrpcService(server, { db, oauth });

  const resolveCaller = async (metadata: grpc.Metadata): Promise<SessionUser> =>
    oauth.verifyBearerUser(authorizationHeader(metadata));

  const activateRegisteredRepository = async (
    repositoryId: string,
    user: SessionUser,
  ) => {
    if (pendingActivations.has(repositoryId)) {
      return;
    }
    pendingActivations.add(repositoryId);
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const repository = await findRepositoryById(db, repositoryId);
        if (!repository || repository.status !== "pending") {
          return;
        }
        try {
          const token = await issueRepositoryToken(
            db,
            tokens,
            user,
            repository,
          );
          const branches = await lore.listBranches(repository.id, token);
          const defaultBranch =
            branches.find((branch) => branch.name === repository.defaultBranchName) ??
            branches.find((branch) => branch.name === "main");
          if (!defaultBranch) {
            continue;
          }
          await updateRepositoryDefaultBranch(
            db,
            repository.id,
            defaultBranch.id,
            defaultBranch.name,
          );
          await markRepositoryStatus(db, repository.id, "active");
          return;
        } catch {
          // Lore may still be writing the repository. Retry briefly.
        }
      }
    } finally {
      pendingActivations.delete(repositoryId);
    }
  };

  server.addService(loreProto.lore.user.v1.UserService.service, {
    userGet: async (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
      try {
        await resolveCaller(call.metadata);
        const users = await listUsersByIds(
          db,
          (call.request.id ?? []).map((id: Uint8Array) => Buffer.from(id).toString()),
        );
        callback(null, {
          user: users.map((user) => ({
            id: user.id,
            displayName: user.displayName,
            username: user.username,
          })),
        });
      } catch (error) {
        callback(grpcStatus(error));
      }
    },

    userFind: async (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
      try {
        await resolveCaller(call.metadata);
        let users: Awaited<ReturnType<typeof listUsersByIds>> = [];
        if (call.request.username) {
          const user = await findUserByUsername(db, call.request.username);
          users = user ? [user] : [];
        } else if (call.request.displayName) {
          const result = await db.query<{
            id: string;
            display_name: string;
            username: string;
          }>(
            `SELECT id, display_name, username
               FROM users
              WHERE lower(display_name) = lower($1) AND status = 'active'`,
            [call.request.displayName],
          );
          users = result.rows.map((row) => ({
            id: row.id,
            displayName: row.display_name,
            username: row.username,
            email: "",
            globalRole: "user",
          }));
        }
        callback(null, {
          user: users.map((user) => ({
            id: user.id,
            displayName: user.displayName,
            username: user.username,
          })),
        });
      } catch (error) {
        callback(grpcStatus(error));
      }
    },
  });

  server.addService(
    loreProto.lore.user.v1.RepositoryRegistryService.service,
    {
      repositoryList: async (
        call: grpc.ServerWritableStream<any, any>,
      ) => {
        try {
          const user = await resolveCaller(call.metadata);
          const repositories = await listAccessibleRepositories(db, user);
          for (const repository of repositories) {
            if (repository.status !== "active") {
              continue;
            }
            const permission = await repositoryPermission(db, user, repository);
            if (!permission) {
              continue;
            }
            call.write({
              id: uuidToBytes(repository.id),
              permission: [permission],
            });
          }
          call.end();
        } catch (error) {
          call.emit("error", grpcStatus(error));
        }
      },

      repositoryRegister: async (
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) => {
        try {
          const user = await resolveCaller(call.metadata);
          const repositoryId = bytesToUuid(call.request.id);
          const repository = await registerRepositoryFromLore(db, {
            repositoryId,
            name: call.request.name,
            user,
          });
          callback(null, {});
          if (repository.status === "pending") {
            void activateRegisteredRepository(repository.id, user);
          }
        } catch (error) {
          callback(grpcStatus(error));
        }
      },

      repositoryUnregister: async (
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) => {
        try {
          const user = await resolveCaller(call.metadata);
          const repositoryId = bytesToUuid(call.request.id);
          const repository = await findRepositoryById(db, repositoryId);
          if (!repository) {
            callback(null, {});
            return;
          }
          const permission = await repositoryPermission(db, user, repository);
          if (!permissionSatisfies(permission, "admin")) {
            callback(
              grpcStatus(
                new AppError("forbidden", 403, "Repository delete permission denied"),
              ),
            );
            return;
          }
          await markRepositoryStatus(db, repositoryId, "deleted");
          callback(null, {});
        } catch (error) {
          callback(grpcStatus(error));
        }
      },
    },
  );

  await new Promise<void>((resolve, reject) => {
    const credentials =
      config.grpcTlsCertFile && config.grpcTlsKeyFile
        ? grpc.ServerCredentials.createSsl(
            null,
            [
              {
                cert_chain: readFileSync(config.grpcTlsCertFile),
                private_key: readFileSync(config.grpcTlsKeyFile),
              },
            ],
            false,
          )
        : grpc.ServerCredentials.createInsecure();
    server.bindAsync(
      `${config.grpcHost}:${config.grpcPort}`,
      credentials,
      (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });
  return server;
}
