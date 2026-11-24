import {
  AppError,
  type RepositoryRecord,
  type SessionUser,
} from "@lore-portal/shared";
import type { TokenService } from "./auth/token-service.ts";
import { issueRepositoryToken } from "./auth/repository-auth.ts";
import { findUserById } from "./auth/users.ts";
import type { Database } from "./db/index.ts";
import type { LoreClient } from "./lore/types.ts";
import {
  assertPersonalRepositoryCountQuota,
  readQuotaSettings,
} from "./quota-settings.ts";
import { findRepositoryById } from "./repositories.ts";

const quotaLocks = new Map<string, Promise<void>>();

export async function assertPersonalRepositoryQuota(input: {
  db: Database;
  lore: LoreClient;
  tokens: TokenService;
  user: SessionUser;
}): Promise<void> {
  if (input.user.globalRole === "admin") return;
  await assertPersonalRepositoryCountQuota(input.db, input.user.id);
  const settings = await readQuotaSettings(input.db);
  if (!settings.enabled || settings.maxSizeBytes === 0) return;
  const repositoryIds = await input.db.query<{ id: string }>(
    `SELECT id
       FROM repositories
      WHERE owner_user_id = $1 AND status = 'active'`,
    [input.user.id],
  );
  let usedBytes = 0;
  for (const { id } of repositoryIds.rows) {
    const repository = await findRepositoryById(input.db, id);
    if (!repository) continue;
    const token = await issueRepositoryToken(
      input.db,
      input.tokens,
      input.user,
      repository,
    );
    const snapshot = await input.lore.getRepositorySnapshot(
      repository.id,
      repository.defaultBranchId,
      token,
    );
    usedBytes += snapshot?.sizeBytes ?? 0;
  }
  if (usedBytes >= settings.maxSizeBytes) {
    throw new AppError(
      "conflict",
      409,
      `Regular users may store at most ${settings.maxSizeBytes} bytes in personal repositories`,
      {
        limit: settings.maxSizeBytes,
        used: usedBytes,
      },
    );
  }
}

export async function assertRegularUserImportQuota(
  db: Database,
  user: SessionUser,
  sourceBytes: number,
): Promise<void> {
  if (user.globalRole === "admin") return;
  const settings = await readQuotaSettings(db);
  if (!settings.enabled) return;
  if (
    settings.importMaxBytes > 0 &&
    sourceBytes > settings.importMaxBytes
  ) {
    throw new AppError(
      "bad_request",
      400,
      `Git source exceeds the regular-user import limit of ${settings.importMaxBytes} bytes`,
      {
        limit: settings.importMaxBytes,
        used: sourceBytes,
      },
    );
  }
}

export async function assertPersonalRepositoryPushQuota(input: {
  db: Database;
  lore: LoreClient;
  tokens: TokenService;
  user: SessionUser;
  repository: RepositoryRecord;
  revisionSignature: string;
  branchId: string;
  fastForwardMerge: boolean;
  token: string;
}): Promise<void> {
  if (
    input.user.globalRole === "admin" ||
    input.repository.organizationId ||
    !input.repository.ownerUserId
  ) {
    return;
  }
  const owner = await findUserById(
    input.db,
    input.repository.ownerUserId,
  );
  if (!owner || owner.globalRole === "admin") return;

  const settings = await readQuotaSettings(input.db);
  if (!settings.enabled || settings.maxSizeBytes === 0) return;

  await withUserQuotaLock(owner.id, async () => {
    const proposedBytes = await input.lore.getRevisionSize({
      repositoryId: input.repository.id,
      revisionSignature: input.revisionSignature,
      token: input.token,
    });
    const repositoryIds = await input.db.query<{ id: string }>(
      `SELECT id
         FROM repositories
        WHERE owner_user_id = $1
          AND organization_id IS NULL
          AND status = 'active'`,
      [owner.id],
    );
    let usedBytes = 0;
    for (const { id } of repositoryIds.rows) {
      const repository = await findRepositoryById(input.db, id);
      if (!repository) continue;
      const token = await issueRepositoryToken(
        input.db,
        input.tokens,
        owner,
        repository,
      );
      const branches = await input.lore.listBranches(repository.id, token);
      let foundTargetBranch = false;
      for (const branch of branches) {
        const isTargetBranch =
          repository.id === input.repository.id &&
          branch.id === input.branchId;
        if (isTargetBranch) {
          foundTargetBranch = true;
          usedBytes += proposedBytes;
          if (input.fastForwardMerge) {
            usedBytes += await branchLogicalSize(
              input.lore,
              repository.id,
              branch.id,
              token,
            );
          }
        } else {
          usedBytes += await branchLogicalSize(
            input.lore,
            repository.id,
            branch.id,
            token,
          );
        }
      }
      if (
        repository.id === input.repository.id &&
        !foundTargetBranch
      ) {
        usedBytes += proposedBytes;
      }
    }
    if (usedBytes > settings.maxSizeBytes) {
      throw new AppError(
        "conflict",
        409,
        `Pushing this revision would exceed the ${settings.maxSizeBytes} byte regular-user storage limit`,
        {
          limit: settings.maxSizeBytes,
          used: usedBytes,
          repositoryId: input.repository.id,
        },
      );
    }
  });
}

async function branchLogicalSize(
  lore: LoreClient,
  repositoryId: string,
  branchId: string,
  token: string,
): Promise<number> {
  const nodes = await lore.getRevisionTree({
    repositoryId,
    branchId,
    maxDepth: 1,
    includeLastRevision: false,
    token,
  });
  return nodes.reduce((total, node) => total + node.size, 0);
}

export async function withUserQuotaLock<T>(
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = quotaLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  quotaLocks.set(userId, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (quotaLocks.get(userId) === tail) {
      quotaLocks.delete(userId);
    }
  }
}
