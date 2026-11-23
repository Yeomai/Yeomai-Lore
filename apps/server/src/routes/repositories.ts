import { Readable } from "node:stream";
import path from "node:path";
import {
  TarArchive,
  ZipArchive,
  type Archiver,
} from "archiver";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  type RepositoryRecord,
} from "@lore-portal/shared";
import { requireSessionUser } from "../auth/session.ts";
import { issueRepositoryToken } from "../auth/repository-auth.ts";
import type { Database } from "../db/index.ts";
import {
  canCreateRepository,
  canDeleteRepository,
  createPendingRepository,
  findRepositoryById,
  listAccessibleRepositoriesWithPermission,
  listRepositoryGrants,
  markRepositoryStatus,
  repositoryPermission,
  requireRepositoryAccess,
  upsertTeamRepositoryGrant,
  upsertUserRepositoryGrant,
} from "../repositories.ts";
import { parseInput } from "./helpers.ts";
import { audit } from "../auth/audit.ts";
import { IGNORE_TEMPLATE_IDS } from "../templates/loreignore.ts";
import {
  initializeEmptyRepository,
  initializeIgnoreTemplate,
} from "../lore/template-initializer.ts";
import type { LoreClient } from "../lore/types.ts";
import {
  buildRepositoryFileIndex,
  RepositoryFileIndexCache,
} from "../repository-file-index.ts";

const createRepositorySchema = z.object({
  organizationId: z.string().uuid().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
  description: z.string().max(2000).default(""),
  ignoreTemplate: z.enum(["none", ...IGNORE_TEMPLATE_IDS]).default("none"),
});

const deleteRepositorySchema = z.object({
  confirmation: z.string().min(1).max(160),
});

const repoParamsSchema = z.object({
  organizationSlug: z.string().min(1),
  repositorySlug: z.string().min(1),
});

const branchQuerySchema = z.object({
  branch: z.string().max(200).optional(),
  revision: z.coerce.number().int().nonnegative().optional(),
});

const treeQuerySchema = branchQuerySchema.extend({
  path: z.string().max(4096).default(""),
  depth: z.coerce.number().int().nonnegative().max(32).optional(),
  lastRevision: z.enum(["true", "false"]).optional(),
});

const fileIndexQuerySchema = z.object({
  branch: z.string().max(200).optional(),
});

const blobQuerySchema = treeQuerySchema.extend({
  inline: z.enum(["true", "false"]).optional(),
});

const archiveQuerySchema = z.object({
  branch: z.string().max(200).optional(),
  path: z.string().max(4096).default(""),
  format: z.enum(["zip", "tar.gz"]),
});

const diffQuerySchema = z.object({
  from: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  to: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});

const textDiffQuerySchema = diffQuerySchema.extend({
  branch: z.string().max(200).optional(),
  path: z.string().min(1).max(4096),
});

const grantSchema = z.discriminatedUnion("subjectType", [
  z.object({
    subjectType: z.literal("user"),
    subjectId: z.string().uuid(),
    permission: z.enum(["read", "write", "admin"]),
  }),
  z.object({
    subjectType: z.literal("team"),
    subjectId: z.string().uuid(),
    permission: z.enum(["read", "write", "admin"]),
  }),
]);
const revokeGrantSchema = z.object({
  subjectType: z.enum(["user", "team"]),
  subjectId: z.string().uuid(),
});

export const registerRepositoryRoutes: FastifyPluginAsync = async (app) => {
  const { config, db, lore, tokens } = app.services;
  const fileIndexCache = new RepositoryFileIndexCache();
  const initializeTemplate =
    app.services.templateInitializer ?? initializeIgnoreTemplate;
  const initializeEmpty =
    app.services.emptyRepositoryInitializer ?? initializeEmptyRepository;

  app.get("/", async (request) => {
    const user = await requireSessionUser(request);
    const repositories = await listAccessibleRepositoriesWithPermission(
      db,
      user,
    );
    const summaries = await Promise.all(
      repositories.map(async (repository) => {
        if (repository.status !== "active") {
          return { ...repository, sizeBytes: null, lastCommitAt: null };
        }
        try {
          const token = await issueRepositoryToken(
            db,
            tokens,
            user,
            repository,
          );
          const snapshot = await lore.getRepositorySnapshot(
            repository.id,
            repository.defaultBranchId,
            token,
          );
          if (!snapshot) {
            return { ...repository, sizeBytes: 0, lastCommitAt: null };
          }
          const [latest] = await applyImportRevisionTimes(db, repository.id, [
            {
              signature: snapshot.latestRevision,
              timestamp: snapshot.lastCommitAt,
            },
          ]);
          return {
            ...repository,
            sizeBytes: snapshot.sizeBytes,
            lastCommitAt: latest!.timestamp,
          };
        } catch (error) {
          request.log.warn(
            { err: error, repositoryId: repository.id },
            "Could not load repository summary",
          );
          return { ...repository, sizeBytes: null, lastCommitAt: null };
        }
      }),
    );
    summaries.sort(
      (left, right) => (right.lastCommitAt ?? -Infinity) - (left.lastCommitAt ?? -Infinity),
    );
    return { repositories: summaries };
  });

  app.post("/", async (request) => {
    const user = await requireSessionUser(request);
    if (
      app.services.serviceReadiness &&
      !(await app.services.serviceReadiness())
    ) {
      throw new AppError(
        "lore_unavailable",
        503,
        "Lore is temporarily unavailable",
      );
    }
    const input = parseInput(createRepositorySchema, request.body);
    let organizationId: string | null = null;
    let ownerUserId: string | null = user.id;
    let organizationSlug = user.username;
    if (input.organizationId) {
      if (!(await canCreateRepository(db, user, input.organizationId))) {
        throw new AppError(
          "forbidden",
          403,
          "You are not a member of this organization",
        );
      }
      const organization = await db.query<{ slug: string }>(
        `SELECT slug FROM organizations WHERE id = $1`,
        [input.organizationId],
      );
      const slug = organization.rows[0]?.slug;
      if (!slug) {
        throw notFound("Organization not found");
      }
      organizationId = input.organizationId;
      ownerUserId = null;
      organizationSlug = slug;
    }
    const pending = await createPendingRepository(db, {
      organizationId,
      ownerUserId,
      organizationSlug,
      slug: input.slug,
      description: input.description,
      userId: user.id,
    });
    const loginToken = await tokens.signLoginToken(user);
    let loreCreated = false;
    try {
      const created = await lore.createRepository({
        id: pending.id,
        defaultBranchId: pending.defaultBranchId,
        name: pending.name,
        description: pending.description,
        defaultBranchName: pending.defaultBranchName,
        token: loginToken,
      });
      if (created.id !== pending.id) {
        throw new Error("Lore returned a different repository id");
      }
      loreCreated = true;
      await markRepositoryStatus(db, pending.id, "active");
      if (input.ignoreTemplate !== "none") {
        const templateAccessToken = await issueRepositoryToken(
          db,
          tokens,
          user,
          pending,
        );
        await initializeTemplate({
          loreCliPath: config.loreCliPath,
          lorePublicUrl: config.loreInternalUrl,
          repositoryName: pending.name,
          template: input.ignoreTemplate,
          identityToken: loginToken,
          accessToken: templateAccessToken,
        });
      } else {
        const emptyAccessToken = await issueRepositoryToken(
          db,
          tokens,
          user,
          pending,
        );
        await initializeEmpty({
          loreCliPath: config.loreCliPath,
          lorePublicUrl: config.loreInternalUrl,
          repositoryName: pending.name,
          identityToken: loginToken,
          accessToken: emptyAccessToken,
        });
      }
    } catch (error) {
      if (loreCreated) {
        try {
          const cleanupToken = await issueRepositoryToken(
            db,
            tokens,
            user,
            pending,
          );
          await lore.deleteRepository(pending.id, cleanupToken);
        } catch {
          // Preserve the creation error; the reconciler handles any leftover.
        }
      }
      await markRepositoryStatus(db, pending.id, "failed");
      await audit(db, {
        actorUserId: user.id,
        action: "repository.create_failed",
        targetType: "repository",
        targetId: pending.id,
        metadata: {
          name: pending.name,
          reason: error instanceof Error ? error.message : String(error),
        },
        ip: request.ip,
      });
      throw error;
    }
    const repository = await findRepositoryById(db, pending.id);
    if (!repository) {
      throw new Error("Created repository could not be loaded");
    }
    await audit(db, {
      actorUserId: user.id,
      action: "repository.created",
      targetType: "repository",
      targetId: repository.id,
      metadata: {
        name: repository.name,
        ignoreTemplate: input.ignoreTemplate,
      },
      ip: request.ip,
    });
    return repository;
  });

  app.delete("/:organizationSlug/:repositorySlug", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const input = parseInput(deleteRepositorySchema, request.body);
    const { repository } = await requireRepositoryAccess(
      db,
      actor,
      params.organizationSlug,
      params.repositorySlug,
      "admin",
    );
    if (!(await canDeleteRepository(db, actor, repository))) {
      throw new AppError(
        "forbidden",
        403,
        "Only the repository owner or an organization administrator can delete this repository",
      );
    }
    const repositoryPath = `${repository.organizationSlug}/${repository.slug}`;
    if (input.confirmation !== repositoryPath) {
      throw badRequest("Repository confirmation does not match");
    }

    const token = await issueRepositoryToken(db, tokens, actor, repository);
    try {
      await lore.deleteRepository(repository.id, token);
    } catch (error) {
      if (!(error instanceof AppError && error.code === "not_found")) {
        throw error;
      }
    }
    await db.query(`DELETE FROM repositories WHERE id = $1`, [repository.id]);
    await audit(db, {
      actorUserId: actor.id,
      action: "repository.deleted",
      targetType: "repository",
      targetId: repository.id,
      metadata: { name: repository.name },
      ip: request.ip,
    });
    return { ok: true, id: repository.id };
  });

  app.get("/:organizationSlug/:repositorySlug", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const { repository, permission } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    return { repository, permission };
  });

  app.get("/:organizationSlug/:repositorySlug/branches", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    if (repository.status !== "active") {
      return { branches: [] };
    }
    const token = await issueRepositoryToken(db, tokens, user, repository);
    const branches = await lore.listBranches(repository.id, token);
    return { branches };
  });

  app.get("/:organizationSlug/:repositorySlug/tags", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    return {
      tags: app.services.imports
        ? await app.services.imports.tags(repository.id)
        : [],
    };
  });

  app.get(
    "/:organizationSlug/:repositorySlug/file-index",
    async (request) => {
      const user = await requireSessionUser(request);
      const params = parseInput(repoParamsSchema, request.params);
      const query = parseInput(fileIndexQuerySchema, request.query);
      const { repository } = await requireRepositoryAccess(
        db,
        user,
        params.organizationSlug,
        params.repositorySlug,
        "read",
      );
      if (repository.status !== "active") {
        return { revision: null, entries: [], truncated: false };
      }

      const token = await issueRepositoryToken(db, tokens, user, repository);
      const branches = await lore.listBranches(repository.id, token);
      const branch = branches.find(
        (candidate) =>
          candidate.id === (query.branch ?? repository.defaultBranchName) ||
          candidate.name === (query.branch ?? repository.defaultBranchName),
      );
      if (!branch) {
        return { revision: null, entries: [], truncated: false };
      }

      const cacheKey = `${repository.id}:${branch.id}:${branch.latest}`;
      const cached = fileIndexCache.get(cacheKey);
      if (cached) return cached;

      const index = await buildRepositoryFileIndex(lore, {
        repositoryId: repository.id,
        branchId: branch.id,
        revision: branch.latest,
        token,
      });
      fileIndexCache.set(cacheKey, index);
      return index;
    },
  );

  app.get("/:organizationSlug/:repositorySlug/revisions", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const query = parseInput(branchQuerySchema, request.query);
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    if (repository.status !== "active") {
      return { revisions: [], branchId: repository.defaultBranchId };
    }
    const token = await issueRepositoryToken(db, tokens, user, repository);
    const branchId = await resolveBranchId(lore, repository, token, query.branch);
    try {
      const revisions = await applyImportRevisionTimes(
        db,
        repository.id,
        await lore.listRevisions(repository.id, branchId, token),
      );
      return { revisions, branchId };
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        return { revisions: [], branchId };
      }
      throw error;
    }
  });

  app.get("/:organizationSlug/:repositorySlug/revision-graph", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const query = parseInput(branchQuerySchema, request.query);
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    if (repository.status !== "active") {
      return { revisions: [], branchId: repository.defaultBranchId };
    }
    const token = await issueRepositoryToken(db, tokens, user, repository);
    const branchId = await resolveBranchId(lore, repository, token, query.branch);
    try {
      const revisions = await applyImportRevisionTimes(
        db,
        repository.id,
        await lore.listRevisionGraph(
          repository.id,
          branchId,
          token,
        ),
      );
      return { revisions, branchId };
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        return { revisions: [], branchId };
      }
      throw error;
    }
  });

  app.get("/:organizationSlug/:repositorySlug/tree", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const query = parseInput(treeQuerySchema, request.query);
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    if (repository.status !== "active") {
      return { nodes: [], path: query.path };
    }
    const token = await issueRepositoryToken(db, tokens, user, repository);
    const branchId = await resolveBranchId(lore, repository, token, query.branch);
    try {
      const nodes = await lore.getRevisionTree({
        repositoryId: repository.id,
        branchId,
        path: query.path,
        token,
        ...(query.depth !== undefined ? { maxDepth: query.depth } : {}),
        includeLastRevision: query.lastRevision !== "false",
        ...(query.revision !== undefined
          ? { revisionNumber: query.revision }
          : {}),
      });
      return { nodes, path: query.path, branchId };
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        return { nodes: [], path: query.path, branchId };
      }
      throw error;
    }
  });

  app.get("/:organizationSlug/:repositorySlug/blob", async (request, reply) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const query = parseInput(blobQuerySchema, request.query);
    if (!query.path) {
      throw badRequest("A file path is required");
    }
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    const token = await issueRepositoryToken(db, tokens, user, repository);
    const branchId = await resolveBranchId(lore, repository, token, query.branch);
    const parent = path.posix.dirname(query.path);
    const nodes = await lore.getRevisionTree({
      repositoryId: repository.id,
      branchId,
      path: parent === "." ? "" : parent,
      token,
      ...(query.revision !== undefined
        ? { revisionNumber: query.revision }
        : {}),
    });
    const node = nodes.find((entry) => entry.path === query.path);
    if (!node?.address || node.type === "directory") {
      throw notFound("File not found");
    }
    const blob = await lore.getBlob({
      repository,
      address: node.address,
      token,
    });
    const contentType = inlineContentType(query.path, blob.contentType);
    reply.header("content-type", contentType);
    reply.header(
      "content-disposition",
      `${query.inline === "true" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.posix.basename(query.path))}`,
    );
    reply.header("cache-control", "private, max-age=60");
    if (blob.contentLength) {
      reply.header("content-length", String(blob.contentLength));
    }
    return reply.send(Readable.fromWeb(blob.body as any));
  });

  app.get(
    "/:organizationSlug/:repositorySlug/archive",
    async (request, reply) => {
      const user = await requireSessionUser(request);
      const params = parseInput(repoParamsSchema, request.params);
      const query = parseInput(archiveQuerySchema, request.query);
      const { repository } = await requireRepositoryAccess(
        db,
        user,
        params.organizationSlug,
        params.repositorySlug,
        "read",
      );
      const token = await issueRepositoryToken(db, tokens, user, repository);
      const branchId = await resolveBranchId(
        lore,
        repository,
        token,
        query.branch,
      );
      const nodes = await collectArchiveNodes(
        lore,
        repository.id,
        branchId,
        token,
        query.path,
      );
      const rootName = query.path
        ? path.posix.basename(query.path)
        : repository.slug;
      const extension = query.format;
      const archive =
        query.format === "zip"
          ? new ZipArchive({ zlib: { level: 9 } })
          : new TarArchive({ gzip: true, gzipOptions: { level: 9 } });

      reply.header(
        "content-type",
        query.format === "zip" ? "application/zip" : "application/gzip",
      );
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(`${rootName}.${extension}`)}`,
      );
      void appendArchiveNodes(
        archive,
        nodes,
        query.path,
        rootName,
        repository,
        token,
        lore,
      ).catch((error: unknown) => {
        archive.destroy(
          error instanceof Error ? error : new Error("Archive failed"),
        );
      });
      return reply.send(archive);
    },
  );

  app.get("/:organizationSlug/:repositorySlug/diff", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const query = parseInput(diffQuerySchema, request.query);
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    const token = await issueRepositoryToken(db, tokens, user, repository);
    const signatures = await resolveDiffPair(
      lore,
      repository,
      token,
      query.from,
      query.to,
    );
    if (!signatures) {
      return { files: [], from: null, to: null };
    }
    const diff = await lore.getRevisionDiff({
      repositoryId: repository.id,
      from: signatures.from,
      to: signatures.to,
      token,
    });
    return {
      files: diff.files.map(({ addressFrom: _from, addressTo: _to, ...file }) => file),
      ...signatures,
    };
  });

  app.get("/:organizationSlug/:repositorySlug/text-diff", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const query = parseInput(textDiffQuerySchema, request.query);
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "read",
    );
    const token = await issueRepositoryToken(db, tokens, user, repository);
    const branchId = await resolveBranchId(
      lore,
      repository,
      token,
      query.branch,
    );
    const signatures = await resolveFileDiffPair(
      lore,
      repository,
      token,
      branchId,
      query.path,
      query.from,
      query.to,
    );
    if (!signatures) {
      return {
        binary: false,
        truncated: false,
        hasConflicts: false,
        linesAdded: 0,
        linesDeleted: 0,
        text: "",
        from: null,
        to: null,
      };
    }
    return {
      ...(await lore.getTextDiff({
        repositoryId: repository.id,
        ...(signatures.from ? { from: signatures.from } : {}),
        to: signatures.to,
        ...(signatures.toAddress ? { toAddress: signatures.toAddress } : {}),
        path: query.path,
        token,
      })),
      ...signatures,
    };
  });

  app.get("/:organizationSlug/:repositorySlug/grants", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const { repository } = await requireRepositoryAccess(
      db,
      user,
      params.organizationSlug,
      params.repositorySlug,
      "admin",
    );
    return { grants: await listRepositoryGrants(db, repository.id) };
  });

  app.post("/:organizationSlug/:repositorySlug/grants", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const input = parseInput(grantSchema, request.body);
    const { repository } = await requireRepositoryAccess(
      db,
      actor,
      params.organizationSlug,
      params.repositorySlug,
      "admin",
    );
    if (input.subjectType === "user" && input.subjectId === actor.id) {
      throw conflict("You cannot grant repository access to yourself");
    }
    if (input.subjectType === "user") {
      await upsertUserRepositoryGrant(db, {
        repositoryId: repository.id,
        userId: input.subjectId,
        permission: input.permission,
      });
    } else {
      await upsertTeamRepositoryGrant(db, {
        repositoryId: repository.id,
        teamId: input.subjectId,
        permission: input.permission,
      });
    }
    await audit(db, {
      actorUserId: actor.id,
      action: "repository.grant_set",
      targetType: "repository",
      targetId: repository.id,
      metadata: input,
      ip: request.ip,
    });
    return { ok: true };
  });

  app.delete("/:organizationSlug/:repositorySlug/grants", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(repoParamsSchema, request.params);
    const input = parseInput(revokeGrantSchema, request.body);
    const { repository } = await requireRepositoryAccess(
      db,
      actor,
      params.organizationSlug,
      params.repositorySlug,
      "admin",
    );
    if (input.subjectType === "user" && input.subjectId === actor.id) {
      throw conflict("You cannot revoke your own repository grant");
    }
    if (
      input.subjectType === "user" &&
      input.subjectId === repository.ownerUserId
    ) {
      throw conflict("You cannot revoke the repository owner's grant");
    }
    const removed = await db.query(
      `DELETE FROM repository_grants
        WHERE repository_id = $1
          AND subject_type = $2
          AND subject_id = $3`,
      [repository.id, input.subjectType, input.subjectId],
    );
    if (removed.rowCount !== 1) {
      throw notFound("Repository grant not found");
    }
    await audit(db, {
      actorUserId: actor.id,
      action: "repository.grant_revoked",
      targetType: "repository",
      targetId: repository.id,
      metadata: input,
      ip: request.ip,
    });
    return { ok: true };
  });
};

async function collectArchiveNodes(
  lore: LoreClient,
  repositoryId: string,
  branchId: string,
  token: string,
  rootPath: string,
) {
  if (rootPath) {
    const parent = path.posix.dirname(rootPath);
    const siblings = await lore.getRevisionTree({
      repositoryId,
      branchId,
      path: parent === "." ? "" : parent,
      maxDepth: 1,
      token,
    });
    const root = siblings.find((node) => node.path === rootPath);
    if (root?.type !== "directory") {
      throw notFound("Directory not found");
    }
  }
  const nodes = await lore.getRevisionTree({
    repositoryId,
    branchId,
    path: rootPath,
    maxDepth: 32,
    token,
  });
  if (nodes.length > 10_000) {
    throw badRequest("Directory contains too many files to archive");
  }
  return nodes;
}

async function applyImportRevisionTimes<
  T extends { signature: string; timestamp: number },
>(
  db: Database,
  repositoryId: string,
  revisions: T[],
): Promise<T[]> {
  const imported = await db.query<{
    lore_revision: string;
    git_committer_time: number;
  }>(
    `SELECT lore_revision, git_committer_time
       FROM repository_revision_git_times
      WHERE repository_id = $1
        AND git_committer_time > 0`,
    [repositoryId],
  );
  if (imported.rows.length === 0) return revisions;
  const times = new Map(
    imported.rows.map((row) => [
      row.lore_revision,
      Number(row.git_committer_time),
    ]),
  );
  return revisions.map((revision) => ({
    ...revision,
    timestamp: times.get(revision.signature) ?? revision.timestamp,
  }));
}

async function appendArchiveNodes(
  archive: Archiver,
  nodes: Awaited<ReturnType<typeof collectArchiveNodes>>,
  rootPath: string,
  rootName: string,
  repository: RepositoryRecord,
  token: string,
  lore: LoreClient,
): Promise<void> {
  archive.append("", { name: `${rootName}/`, type: "directory" });
  for (const node of nodes) {
    const relative = path.posix.relative(rootPath, node.path);
    if (
      !relative ||
      relative.startsWith("../") ||
      path.posix.isAbsolute(relative)
    ) {
      throw new Error("Archive path escaped the selected directory");
    }
    const archivePath = `${rootName}/${relative}`;
    if (node.type === "directory") {
      archive.append("", { name: `${archivePath}/`, type: "directory" });
      continue;
    }
    if (!node.address) {
      continue;
    }
    const blob = await lore.getBlob({
      repository,
      address: node.address,
      token,
    });
    archive.append(Readable.fromWeb(blob.body as any), {
      name: archivePath,
      mode: node.executable ? 0o755 : 0o644,
    });
  }
  await archive.finalize();
}

function inlineContentType(filePath: string, fallback: string): string {
  if (fallback !== "application/octet-stream") {
    return fallback;
  }
  switch (path.posix.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".ico":
      return "image/x-icon";
    default:
      return fallback;
  }
}

async function resolveBranchId(
  lore: AppDependenciesLore,
  repository: RepositoryRecord,
  token: string,
  requested?: string,
): Promise<string> {
  if (!requested || requested === repository.defaultBranchName) {
    return repository.defaultBranchId;
  }
  const branches = await lore.listBranches(repository.id, token);
  const branch = branches.find(
    (candidate) =>
      candidate.id === requested || candidate.name === requested,
  );
  if (!branch) {
    throw notFound("Branch not found");
  }
  return branch.id;
}

type AppDependenciesLore = {
  listBranches(
    repositoryId: string,
    token: string,
  ): Promise<Array<{ id: string; name: string; latest: string }>>;
  listRevisions(
    repositoryId: string,
    branchId: string,
    token: string,
  ): Promise<Array<{ signature: string }>>;
  getRevisionTree(input: {
    repositoryId: string;
    branchId: string;
    path?: string;
    maxDepth?: number;
    includeLastRevision?: boolean;
    token: string;
  }): Promise<
    Array<{
      path: string;
      type: "directory" | "file" | "link";
      address?: string;
      updatedRevision?: string;
    }>
  >;
  getRevisionDiff(input: {
    repositoryId: string;
    from: string;
    to: string;
    token: string;
  }): Promise<{
    files: Array<{
      path: string;
      pathFrom: string;
      type: "directory" | "file" | "link";
    }>;
  }>;
};

async function resolveDiffPair(
  lore: AppDependenciesLore,
  repository: RepositoryRecord,
  token: string,
  from?: string,
  to?: string,
): Promise<{ from: string; to: string } | null> {
  if (from && to) {
    return { from, to };
  }
  const revisions = await lore.listRevisions(
    repository.id,
    repository.defaultBranchId,
    token,
  );
  if (revisions.length < 2) {
    return null;
  }
  return {
    from: from ?? revisions[1]!.signature,
    to: to ?? revisions[0]!.signature,
  };
}

async function resolveFileDiffPair(
  lore: AppDependenciesLore,
  repository: RepositoryRecord,
  token: string,
  branchId: string,
  filePath: string,
  from?: string,
  to?: string,
): Promise<{
  from: string | null;
  to: string;
  toAddress?: string;
} | null> {
  if (from && to) {
    const diff = await lore.getRevisionDiff({
      repositoryId: repository.id,
      from,
      to,
      token,
    });
    const changed = diff.files.find((file) => file.path === filePath);
    if (!changed || changed.type === "directory") {
      return null;
    }
    return { from, to };
  }
  const tree = await lore.getRevisionTree({
    repositoryId: repository.id,
    branchId,
    maxDepth: 0,
    token,
  });
  const file = tree.find(
    (node) => node.path === filePath && node.type !== "directory",
  );
  if (!file?.updatedRevision) {
    return null;
  }
  const revisions = await lore.listRevisions(
    repository.id,
    branchId,
    token,
  );
  const index = revisions.findIndex(
    (revision) => revision.signature === file.updatedRevision,
  );
  if (index < 0) {
    return null;
  }
  return {
    from: revisions[index + 1]?.signature ?? null,
    to: file.updatedRevision,
    ...(!revisions[index + 1] && file.address
      ? { toAddress: file.address }
      : {}),
  };
}
