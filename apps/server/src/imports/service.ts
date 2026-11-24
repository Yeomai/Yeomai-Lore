import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  newId,
  notFound,
  type RepositoryImportPhase,
  type RepositoryImportStatus,
  type RepositoryImportWarning,
  type RepositoryTag,
  type SessionUser,
} from "@lore-portal/shared";
import type { AppConfig } from "../config.ts";
import type { Database } from "../db/index.ts";
import { isUniqueConstraint, nowIso, toIsoString } from "../db/index.ts";
import {
  createPendingRepository,
  findRepositoryById,
  markRepositoryStatus,
} from "../repositories.ts";
import type { LoreClient } from "../lore/types.ts";
import type { TokenService } from "../auth/token-service.ts";
import { issueRepositoryToken } from "../auth/repository-auth.ts";
import { findUserById } from "../auth/users.ts";
import { audit } from "../auth/audit.ts";
import {
  assertPersonalRepositoryQuota,
  assertRegularUserImportQuota,
  withUserQuotaLock,
} from "../user-quota.ts";

const run = promisify(execFile);
const ZERO_REVISION = "0".repeat(64);
const EMPTY_GIT_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function shouldRefreshImportCredential(
  issuedAt: number,
  ttlSeconds: number,
  now = Date.now(),
): boolean {
  const refreshAfterMs = Math.max(
    30_000,
    Math.min(30 * 60_000, Math.floor((ttlSeconds * 1000) / 2)),
  );
  return now - issuedAt >= refreshAfterMs;
}

export function tarExtractionInvocation(
  jobDir: string,
  archive: string,
): { cwd: string; args: string[] } {
  return {
    cwd: jobDir,
    args: ["-xf", path.basename(archive), "-C", "workspace"],
  };
}

interface ImportRow {
  id: string;
  actor_user_id: string;
  actor_username?: string;
  actor_global_role?: "admin" | "user";
  target_repository_id: string | null;
  source_kind: "path" | "https";
  remote_protocol: "http" | "https" | "git";
  provider: "github" | "gitea";
  include_tags: number;
  credential_kind: "none" | "https-token";
  requires_credentials: number;
  source_value: string;
  target_organization_id: string | null;
  target_owner_user_id: string | null;
  target_organization_slug: string;
  target_slug: string;
  target_description: string;
  source_default_branch: string | null;
  status: RepositoryImportStatus;
  phase: RepositoryImportPhase;
  total_commits: number;
  imported_commits: number;
  total_bytes: number;
  imported_bytes: number;
  error_message: string;
  queue_slot: string | null;
  requested_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RepositoryImportRecord {
  id: string;
  actorUserId: string;
  actorUsername: string;
  targetRepositoryId: string | null;
  sourceKind: "url";
  sourceValue: string;
  provider: "github" | "gitea";
  includeTags: boolean;
  targetOrganizationSlug: string;
  targetSlug: string;
  targetDescription: string;
  sourceDefaultBranch: string | null;
  status: RepositoryImportStatus;
  phase: RepositoryImportPhase;
  totalCommits: number;
  importedCommits: number;
  totalBytes: number;
  importedBytes: number;
  errorMessage: string;
  queuePosition: number | null;
  requestedAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface CreateImportInput {
  sourceValue: string;
  credentials?: GitCredentials;
  includeTags: boolean;
  organizationId?: string;
  slug: string;
  description: string;
}

type GitCredentials =
  {
    type: "https-token";
    token: string;
    username?: string;
  };

interface GitCommit {
  sha: string;
  parents: string[];
  author: GitIdentity;
  committer: GitIdentity;
  message: string;
}

interface GitChange {
  status: string;
  path: string;
  oldPath?: string;
}

export function isMetadataOnlyGitCommit(input: {
  parents: string[];
  tree: string;
  firstParentTree: string | null;
}): boolean {
  if (input.parents.length === 0) {
    return input.tree === EMPTY_GIT_TREE;
  }
  return input.firstParentTree === input.tree;
}

export function parseGitNameStatus(output: string): GitChange[] {
  const tokens = output.split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const status = tokens[index];
    if (!status) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = tokens[++index];
      const changedPath = tokens[++index];
      if (oldPath && changedPath) {
        changes.push({ status, oldPath, path: changedPath });
      }
    } else {
      const changedPath = tokens[++index];
      if (changedPath) changes.push({ status, path: changedPath });
    }
  }
  return changes;
}

interface GitIdentity {
  name: string;
  email: string;
  timestamp: string;
}

interface ImportedRevision {
  signature: string;
  branch: string;
}

interface GitTagRef {
  name: string;
  objectId: string;
  type: string;
  tagger: string;
  taggerEmail: string;
  message: string;
}

interface ProviderIdentity {
  name: "github" | "gitea";
  username?: string;
}

class ImportCancelledError extends Error {}

const importSelect = `
  SELECT ri.*, actor.username AS actor_username,
         actor.global_role AS actor_global_role
    FROM repository_imports ri
    JOIN users actor ON actor.id = ri.actor_user_id
`;

export class RepositoryImportService {
  private readonly active = new Map<string, AbortController>();
  private readonly cancelRequested = new Set<string>();
  private readonly credentials = new Map<string, GitCredentials>();
  private readonly loreCredentialRefreshers = new Map<
    string,
    () => Promise<{ identityToken: string; repositoryToken: string }>
  >();
  private pumping = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly lore: LoreClient,
    private readonly tokens: TokenService,
  ) {}

  async start(): Promise<void> {
    await this.waitForLore();
    const running = await this.db.query<ImportRow>(
      `SELECT * FROM repository_imports WHERE status = 'running'`,
    );
    for (const job of running.rows) {
      await this.finish(
        job.id,
        "failed",
        "Import stopped because the portal restarted",
      );
      await this.cleanupTarget(job);
    }
    const incomplete = await this.db.query<ImportRow>(
      `SELECT * FROM repository_imports
        WHERE status IN ('failed', 'cancelled')
          AND target_repository_id IS NOT NULL`,
    );
    for (const job of incomplete.rows) {
      await this.cleanupTarget(job);
    }
    const privateQueued = await this.db.query<ImportRow>(
      `SELECT * FROM repository_imports
        WHERE status = 'queued' AND requires_credentials = 1`,
    );
    for (const job of privateQueued.rows) {
      if (!this.credentials.has(job.id)) {
        await this.finish(
          job.id,
          "failed",
          "Private Git credentials expired when the portal restarted. Submit a new import.",
        );
      }
    }
    void this.pump();
  }

  private async waitForLore(): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await fetch(
        `${this.config.loreHttpUrl}/health_check`,
      ).catch(() => null);
      if (response?.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Lore Server did not become ready for import recovery");
  }

  async stop(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    await this.running;
  }

  async create(
    actor: SessionUser,
    input: CreateImportInput,
  ): Promise<RepositoryImportRecord> {
    const id = newId();
    const requestedAt = nowIso();
    await this.checkQuota(actor);
    await this.assertQueueCapacity(actor);
    const queueSlot = actor.globalRole === "admin" ? null : actor.id;
    let organizationId: string | null = null;
    let ownerUserId: string | null = actor.id;
    let organizationSlug = actor.username;
    if (input.organizationId) {
      if (actor.globalRole !== "admin") {
        throw forbidden(
          "Regular users can only import into their personal namespace",
        );
      }
      const organization = await this.db.query<{ slug: string }>(
        `SELECT slug FROM organizations WHERE id = $1`,
        [input.organizationId],
      );
      if (!organization.rows[0]) throw notFound("Organization not found");
      organizationId = input.organizationId;
      ownerUserId = null;
      organizationSlug = organization.rows[0].slug;
    }
    const sourceUrl = await this.validateUrlSource(
      input.sourceValue,
      input.credentials !== undefined,
    );
    if (sourceUrl.protocol === "git:" && input.credentials) {
      throw badRequest("git:// URLs cannot use access tokens");
    }
    const provider = await this.detectProvider(sourceUrl, input.credentials);
    const credentials = input.credentials
      ? {
          ...input.credentials,
          ...(provider.username ? { username: provider.username } : {}),
        }
      : undefined;
    if (input.credentials && !credentials?.username) {
      throw badRequest(
        "The access token could not resolve a Git username from the provider",
      );
    }
    try {
      await this.db.query(
        `INSERT INTO repository_imports
           (id, actor_user_id, source_kind, remote_protocol, provider,
            source_value, include_tags,
            target_organization_id, target_owner_user_id,
            target_organization_slug, target_slug, target_description,
            credential_kind, requires_credentials, requested_at, queue_slot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          id,
          actor.id,
          "https",
          sourceUrl.protocol.replace(/:$/, ""),
          provider.name,
          input.sourceValue,
          input.includeTags ? 1 : 0,
          organizationId,
          ownerUserId,
          organizationSlug,
          input.slug,
          input.description,
          credentials?.type ?? "none",
          credentials ? 1 : 0,
          requestedAt,
          queueSlot,
        ],
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw conflict("You already have an active repository import");
      }
      throw error;
    }
    if (credentials) {
      this.credentials.set(id, credentials);
    }
    await audit(this.db, {
      actorUserId: actor.id,
      action: "repository.import_queued",
      targetType: "repository_import",
      targetId: id,
      metadata: {
        sourceKind: "url",
        target: `${organizationSlug}/${input.slug}`,
      },
    });
    void this.pump();
    return (await this.get(id))!;
  }

  async list(actor: SessionUser): Promise<RepositoryImportRecord[]> {
    const visibleToUser = actor.globalRole === "admin" ? "" : "WHERE ri.actor_user_id = $1";
    const result = await this.db.query<ImportRow>(
      `${importSelect}
        ${visibleToUser}
        ORDER BY
          CASE ri.status
            WHEN 'running' THEN 0
            WHEN 'queued' THEN 1
            ELSE 2
          END,
          CASE
            WHEN ri.status IN ('running', 'queued') THEN ri.requested_at
          END ASC,
          ri.requested_at DESC,
          ri.id ASC
        LIMIT 100`,
      actor.globalRole === "admin" ? [] : [actor.id],
    );
    const activeQueue = await this.db.query<{ id: string }>(
      `SELECT id
         FROM repository_imports
        WHERE status IN ('running', 'queued')
        ORDER BY
          CASE status WHEN 'running' THEN 0 ELSE 1 END,
          requested_at,
          id`,
    );
    const positions = new Map(
      activeQueue.rows.map((row, index) => [row.id, index + 1]),
    );
    return result.rows.map((row) =>
      mapImport(row, positions.get(row.id) ?? null),
    );
  }

  async get(id: string): Promise<RepositoryImportRecord | null> {
    const result = await this.db.query<ImportRow>(
      `${importSelect} WHERE ri.id = $1`,
      [id],
    );
    return result.rows[0] ? mapImport(result.rows[0]) : null;
  }

  async getVisible(
    id: string,
    actor: SessionUser,
  ): Promise<RepositoryImportRecord | null> {
    const row = await this.findManageableRow(id, actor);
    return row ? mapImport(row) : null;
  }

  async warnings(id: string): Promise<RepositoryImportWarning[]> {
    const result = await this.db.query<{
      id: number;
      kind: string;
      object_id: string;
      path: string;
      message: string;
    }>(
      `SELECT id, kind, object_id, path, message
         FROM repository_import_warnings
        WHERE import_id = $1
        ORDER BY id`,
      [id],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      objectId: row.object_id,
      path: row.path,
      message: row.message,
    }));
  }

  async cancel(id: string, actor: SessionUser): Promise<RepositoryImportRecord> {
    let row = await this.findManageableRow(id, actor);
    if (!row) throw notFound("Import job not found");
    if (row.status === "cancelled") return mapImport(row);
    if (row.status === "queued") {
      const cancelledAt = nowIso();
      const cancelled = await this.db.query<{ id: string }>(
        `UPDATE repository_imports
            SET status = 'cancelled', phase = 'cleaning_up',
                error_message = $2, finished_at = $3, queue_slot = NULL
          WHERE id = $1 AND status = 'queued'
          RETURNING id`,
        [id, "Cancelled before start", cancelledAt],
      );
      this.credentials.delete(id);
      if (cancelled.rows[0]) {
        await this.safeLog(id, "Cancelled before start\n");
        await audit(this.db, {
          actorUserId: actor.id,
          action: "repository.import_cancelled",
          targetType: "repository_import",
          targetId: id,
        });
        return (await this.get(id))!;
      }
      row = await this.findManageableRow(id, actor);
      if (!row) throw notFound("Import job not found");
      if (row.status === "cancelled") return mapImport(row);
    }
    if (row.status !== "running") {
      throw badRequest("Only queued or running imports can be cancelled");
    }
    const controller = this.active.get(id);
    if (controller) {
      controller.abort();
    } else {
      this.cancelRequested.add(id);
    }
    await audit(this.db, {
      actorUserId: actor.id,
      action: "repository.import_cancelled",
      targetType: "repository_import",
      targetId: id,
    });
    return (await this.get(id))!;
  }

  async remove(id: string, actor: SessionUser): Promise<void> {
    const row = await this.findManageableRow(id, actor);
    if (!row) throw notFound("Import job not found");
    if (row.status === "queued" || row.status === "running") {
      throw badRequest("Stop the import before cleaning its record");
    }
    const job = mapImport(row);
    if (row.status === "failed" || row.status === "cancelled") {
      await this.cleanupTarget(row);
      const remaining = await this.db.query<{ target_repository_id: string | null }>(
        `SELECT target_repository_id FROM repository_imports WHERE id = $1`,
        [id],
      );
      if (remaining.rows[0]?.target_repository_id) {
        throw badRequest("Incomplete repository cleanup failed; retry cleanup");
      }
    }
    this.credentials.delete(id);
    await removePathWithRetry(path.join(this.config.loreImportWorkDir, id));
    await removePathWithRetry(this.logPath(id));
    await this.db.query(`DELETE FROM repository_imports WHERE id = $1`, [id]);
    await audit(this.db, {
      actorUserId: actor.id,
      action: "repository.import_cleaned",
      targetType: "repository_import",
      targetId: id,
      metadata: { status: job.status, target: `${job.targetOrganizationSlug}/${job.targetSlug}` },
    });
  }

  async removeTerminal(
    actor: SessionUser,
  ): Promise<{ removedCount: number; failedCount: number }> {
    const scope =
      actor.globalRole === "admin" ? "" : "AND actor_user_id = $1";
    const terminal = await this.db.query<{ id: string }>(
      `SELECT id
         FROM repository_imports
        WHERE status IN ('succeeded', 'failed', 'cancelled')
          ${scope}
        ORDER BY requested_at DESC, id`,
      actor.globalRole === "admin" ? [] : [actor.id],
    );
    let removedCount = 0;
    let failedCount = 0;
    for (const row of terminal.rows) {
      try {
        await this.remove(row.id, actor);
        removedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    if (terminal.rows.length > 0) {
      await audit(this.db, {
        actorUserId: actor.id,
        action: "repository.import_terminal_cleaned",
        targetType: "repository_import",
        targetId: actor.id,
        metadata: { removedCount, failedCount },
      });
    }
    return { removedCount, failedCount };
  }

  logPath(id: string): string {
    return path.join(this.config.loreImportWorkDir, "logs", `${id}.log`);
  }

  async report(id: string, actor: SessionUser): Promise<{
    job: RepositoryImportRecord;
    warnings: RepositoryImportWarning[];
    log: string;
  }> {
    const row = await this.findManageableRow(id, actor);
    if (!row) throw notFound("Import job not found");
    const job = mapImport(row);
    return {
      job,
      warnings: await this.warnings(id),
      log: await readFile(this.logPath(id), "utf8").catch(() => ""),
    };
  }

  async tags(
    repositoryId: string,
  ): Promise<Array<RepositoryTag & { createdAt: string }>> {
    const result = await this.db.query<{
      name: string;
      lore_revision: string;
      branch_name: string;
      annotated: number;
      tagger: string;
      message: string;
      created_at: string;
    }>(
      `SELECT name, lore_revision, branch_name, annotated, tagger, message, created_at
         FROM repository_tags
        WHERE repository_id = $1
        ORDER BY name`,
      [repositoryId],
    );
    return result.rows.map((row) => ({
      name: row.name,
      revision: row.lore_revision,
      branchName: row.branch_name,
      annotated: Boolean(row.annotated),
      tagger: row.tagger,
      message: row.message,
      createdAt: toIsoString(row.created_at),
    }));
  }

  private async checkQuota(actor: SessionUser): Promise<void> {
    if (actor.globalRole === "admin") return;
    await assertPersonalRepositoryQuota({
      db: this.db,
      lore: this.lore,
      tokens: this.tokens,
      user: actor,
    });
  }

  private async assertQueueCapacity(actor: SessionUser): Promise<void> {
    if (actor.globalRole === "admin") return;
    const active = await this.db.query<{ id: string }>(
      `SELECT id
         FROM repository_imports
        WHERE actor_user_id = $1
          AND status IN ('queued', 'running')
        LIMIT 1`,
      [actor.id],
    );
    if (active.rows[0]) {
      throw conflict("You already have an active repository import");
    }
  }

  private async findManageableRow(
    id: string,
    actor: SessionUser,
  ): Promise<ImportRow | null> {
    const result = await this.db.query<ImportRow>(
      `${importSelect} WHERE ri.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (actor.globalRole !== "admin" && row.actor_user_id !== actor.id) {
      return null;
    }
    return row;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.active.size > 0) return;
    this.pumping = true;
    try {
      const result = await this.db.query<ImportRow>(
        `SELECT * FROM repository_imports
          WHERE status = 'queued'
          ORDER BY requested_at, id
          LIMIT 1`,
      );
      const job = result.rows[0];
      if (!job) return;
      const updated = await this.db.query(
        `UPDATE repository_imports
            SET status = 'running', phase = 'validating', started_at = $2
          WHERE id = $1 AND status = 'queued'`,
        [job.id, nowIso()],
      );
      if (updated.rowCount !== 1) return;
      const controller = new AbortController();
      this.active.set(job.id, controller);
      if (this.cancelRequested.delete(job.id)) controller.abort();
      const running = this.run(
        { ...job, status: "running", phase: "validating" },
        controller,
      )
        .catch((error: unknown) =>
          this.settleFailedJob(job, error).catch((settlementError: unknown) => {
            console.error("Failed to settle import job", {
              jobId: job.id,
              error:
                settlementError instanceof Error
                  ? settlementError.message
                  : String(settlementError),
            });
          }),
        )
        .finally(() => {
          this.credentials.delete(job.id);
          this.loreCredentialRefreshers.delete(job.id);
          this.active.delete(job.id);
          this.cancelRequested.delete(job.id);
          this.running = null;
          void this.pump();
        });
      this.running = running;
      void running;
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: ImportRow, controller: AbortController): Promise<void> {
    await mkdir(path.join(this.config.loreImportWorkDir, "logs"), {
      recursive: true,
    });
    await mkdir(this.config.loreImportWorkDir, { recursive: true });
    await this.log(job.id, `Starting import ${job.id}\n`);
    const jobDir = path.join(this.config.loreImportWorkDir, job.id);
    const mirror = path.join(jobDir, "mirror.git");
    const workspace = path.join(jobDir, "workspace");
    await removePathWithRetry(jobDir);
    await mkdir(jobDir, { recursive: true });

    await this.phase(job.id, "mirroring");
    const credentials = this.credentials.get(job.id);
    if (job.requires_credentials === 1 && !credentials) {
      throw new Error(
        "Private Git credentials are no longer available; submit a new import",
      );
    }
    const sourceUrl = await this.validateUrlSource(
      job.source_value,
      credentials !== undefined,
    );
    if (sourceUrl.protocol === "git:" && credentials) {
      throw badRequest("git:// URLs cannot use access tokens");
    }
    const source = sourceUrl.toString();
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: jobDir,
      GIT_CONFIG_GLOBAL: path.join(jobDir, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
    };
    await writeFile(path.join(jobDir, "gitconfig"), "");
    if (credentials?.type === "https-token" && sourceUrl.protocol !== "git:") {
      const askpass = path.join(jobDir, "git-askpass.sh");
      await writeFile(
        askpass,
        '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' "$LORE_IMPORT_GIT_USERNAME" ;;\n  *) printf \'%s\\n\' "$LORE_IMPORT_GIT_TOKEN" ;;\nesac\n',
      );
      await chmod(askpass, 0o700);
      gitEnv.GIT_ASKPASS = askpass;
      gitEnv.LORE_IMPORT_GIT_USERNAME =
        credentials.username ?? this.config.loreImportGitUsername;
      gitEnv.LORE_IMPORT_GIT_TOKEN = credentials.token;
    }
    let measuring = false;
    const progressTimer = setInterval(() => {
      if (measuring) return;
      measuring = true;
      void this.directorySize(mirror)
        .then((bytes) =>
          this.db.query(
            `UPDATE repository_imports SET imported_bytes = $2 WHERE id = $1`,
            [job.id, bytes],
          ),
        )
        .catch(() => {})
        .finally(() => {
          measuring = false;
        });
    }, 1000);
    try {
      await this.command(
        job.id,
        this.config.gitPath,
        ["-c", "http.followRedirects=false", "clone", "--mirror", source, mirror],
        { signal: controller.signal, env: gitEnv },
      );
    } finally {
      clearInterval(progressTimer);
    }
    const branches = await this.gitBranches(job.id, mirror, controller.signal);
    if (branches.length === 0) throw new Error("Git repository has no branches");
    const defaultBranch =
      (await this.git(
        job.id,
        ["--git-dir", mirror, "symbolic-ref", "--short", "HEAD"],
        controller.signal,
      )
        .then((value) => value.trim().replace(/^refs\/heads\//, ""))
        .catch(() => "")) || branches[0]!.name;
    if (!branches.some((branch) => branch.name === defaultBranch)) {
      throw new Error("The Git default branch is unavailable");
    }
    const totalCommits = Number(
      (
        await this.git(
          job.id,
          ["--git-dir", mirror, "rev-list", "--branches", "--count"],
          controller.signal,
        )
      ).trim(),
    );
    await this.db.query(
      `UPDATE repository_imports
          SET source_default_branch = $2, total_commits = $3
        WHERE id = $1`,
      [job.id, defaultBranch, totalCommits],
    );
    const objectStats = await this.git(
      job.id,
      ["--git-dir", mirror, "count-objects", "-v"],
      controller.signal,
    ).catch(() => "");
    const sizeKib =
      Number(objectStats.match(/^size:\s*(\d+)/m)?.[1] ?? 0) +
      Number(objectStats.match(/^size-pack:\s*(\d+)/m)?.[1] ?? 0);
    const sizeBytes = sizeKib * 1024;
    if (
      this.config.loreImportMaxSourceBytes > 0 &&
      sizeBytes > this.config.loreImportMaxSourceBytes
    ) {
      throw badRequest(
        `Git source exceeds the configured ${this.config.loreImportMaxSourceBytes} byte limit`,
      );
    }
    if (sizeKib > 0) {
      await this.db.query(
        `UPDATE repository_imports SET total_bytes = $2 WHERE id = $1`,
        [job.id, sizeBytes],
      );
    }

    const user = await findUserById(this.db, job.actor_user_id);
    if (!user) throw new Error("Import owner no longer exists");
    await assertRegularUserImportQuota(this.db, user, sizeBytes);
    const createPending = () =>
      createPendingRepository(this.db, {
        organizationId: job.target_organization_id,
        ownerUserId: job.target_owner_user_id,
        organizationSlug: job.target_organization_slug,
        slug: job.target_slug,
        description: job.target_description,
        defaultBranchName: defaultBranch,
        userId: job.actor_user_id,
      });
    const pending = await withUserQuotaLock(user.id, async () => {
      if (
        !job.target_organization_id &&
        job.target_owner_user_id === user.id
      ) {
        await assertPersonalRepositoryQuota({
          db: this.db,
          lore: this.lore,
          tokens: this.tokens,
          user,
        });
      }
      return createPending();
    });
    await this.db.query(
      `UPDATE repository_imports SET target_repository_id = $2 WHERE id = $1`,
      [job.id, pending.id],
    );
    job.target_repository_id = pending.id;
    let loginToken = await this.tokens.signLoginToken(user);
    let loginTokenIssuedAt = Date.now();
    await this.lore.createRepository({
      id: pending.id,
      defaultBranchId: pending.defaultBranchId,
      name: pending.name,
      description: pending.description,
      defaultBranchName: defaultBranch,
      token: loginToken,
    });
    await markRepositoryStatus(this.db, pending.id, "active");
    let repositoryToken = await issueRepositoryToken(
      this.db,
      this.tokens,
      user,
      pending,
    );
    let repositoryTokenIssuedAt = Date.now();
    this.loreCredentialRefreshers.set(job.id, async () => {
      const now = Date.now();
      if (
        shouldRefreshImportCredential(
          loginTokenIssuedAt,
          this.config.accessTokenTtlSeconds,
          now,
        )
      ) {
        loginToken = await this.tokens.signLoginToken(user);
        loginTokenIssuedAt = Date.now();
      }
      if (
        shouldRefreshImportCredential(
          repositoryTokenIssuedAt,
          this.config.repositoryTokenTtlSeconds,
          now,
        )
      ) {
        repositoryToken = await issueRepositoryToken(
          this.db,
          this.tokens,
          user,
          pending,
        );
        repositoryTokenIssuedAt = Date.now();
      }
      return { identityToken: loginToken, repositoryToken };
    });
    await this.command(
      job.id,
      this.config.loreCliPath,
      [
        "clone",
        `${this.config.loreInternalUrl}/${pending.name}`,
        workspace,
      ],
      {
        signal: controller.signal,
        env: loreCommandEnvironment(loginToken, repositoryToken),
      },
    );

    await this.phase(job.id, "importing_commits");
    const revisions = new Map<string, ImportedRevision>();
    const branchTips = new Map<string, ImportedRevision>();
    const branchNames = new Set(branches.map((branch) => branch.name));
    const importedBranches = new Set<string>();
    const importingBranches = new Set<string>();
    const temporaryLoreBranches = new Set<string>();
    const warnings = new Set<string>();
    const branchByTip = new Map(branches.map((branch) => [branch.sha, branch.name]));

    const warn = async (
      kind: string,
      message: string,
      objectId = "",
      filePath = "",
    ) => {
      const key = `${kind}:${objectId}:${filePath}:${message}`;
      if (warnings.has(key)) return;
      warnings.add(key);
      await this.db.query(
        `INSERT INTO repository_import_warnings
           (import_id, kind, object_id, path, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [job.id, kind, objectId, filePath, message],
      );
      await this.log(job.id, `WARNING ${kind} ${objectId} ${filePath} ${message}\n`);
    };
    await warn(
      "timestamp-fidelity",
      "Original Git author and committer times are stored as metadata; the Lore revision display timestamp records import time.",
    );
    if (sourceUrl.protocol === "http:" && credentials) {
      await warn(
        "insecure-transport",
        "The access token was sent over plain HTTP.",
      );
    }

    const importBranch = async (
      branchName: string,
      gitTip?: string,
      temporary = false,
    ): Promise<void> => {
      throwIfAborted(controller.signal);
      if (importedBranches.has(branchName)) return;
      if (importingBranches.has(branchName)) {
        throw new Error(`Cyclic branch dependency at ${branchName}`);
      }
      importingBranches.add(branchName);
      const branch = branches.find((item) => item.name === branchName);
      const tipSha = gitTip ?? branch?.sha;
      if (!tipSha) throw new Error(`Git branch not found: ${branchName}`);
      const chain = (
        await this.git(
          job.id,
          [
            "--git-dir",
            mirror,
            "rev-list",
            "--first-parent",
            "--reverse",
            tipSha,
          ],
          controller.signal,
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      const firstUnmapped = chain.findIndex((sha) => !revisions.has(sha));
      if (firstUnmapped === -1) {
        await this.prepareLoreBranch(
          job.id,
          workspace,
          branchName,
          defaultBranch,
          revisions.get(chain.at(-1)!),
          revisions,
          loginToken,
          repositoryToken,
          controller.signal,
        );
        branchTips.set(branchName, revisions.get(chain.at(-1)!)!);
        importedBranches.add(branchName);
        importingBranches.delete(branchName);
        return;
      }
      const first = await this.readCommit(job.id, mirror, chain[firstUnmapped]!, controller.signal);
      const startParent = first.parents[0];
      if (
        !startParent &&
        revisions.size > 0 &&
        !temporary &&
        branchName !== defaultBranch
      ) {
        await warn(
          "orphan-root-branch",
          "A Git branch with no common ancestor was skipped because Lore cannot attach another root history to an existing repository.",
          first.sha,
          branchName,
        );
        importedBranches.add(branchName);
        importingBranches.delete(branchName);
        return;
      }
      if (startParent) {
        const mapped = revisions.get(startParent);
        if (!mapped) {
          const owner = await this.branchContaining(
            job.id,
            mirror,
            startParent,
            controller.signal,
          );
          if (owner && owner !== branchName && branchNames.has(owner)) {
            await importBranch(owner);
          } else {
            await warn(
              "detached-history",
              "A merged commit is not reachable from any branch tip.",
              startParent,
            );
            throw new Error(`Git parent ${startParent} has not been imported`);
          }
        }
      }
      const parentRevision = startParent ? revisions.get(startParent) : undefined;
      await this.prepareLoreBranch(
        job.id,
        workspace,
        branchName,
        defaultBranch,
        parentRevision,
        revisions,
        loginToken,
        repositoryToken,
        controller.signal,
      );

      for (const sha of chain.slice(firstUnmapped)) {
        throwIfAborted(controller.signal);
        if (revisions.has(sha)) continue;
        const commit = await this.readCommit(job.id, mirror, sha, controller.signal);
        const firstParent = commit.parents[0];
        if (firstParent && !revisions.has(firstParent)) {
          throw new Error(`First parent ${firstParent} has not been imported`);
        }
        const treeInputs = [
          `${sha}^{tree}`,
          ...(firstParent ? [`${firstParent}^{tree}`] : []),
        ];
        const trees = (
          await this.git(
            job.id,
            ["--git-dir", mirror, "rev-parse", ...treeInputs],
            controller.signal,
          )
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        const metadataOnly = isMetadataOnlyGitCommit({
          parents: commit.parents,
          tree: trees[0]!,
          firstParentTree: trees[1] ?? null,
        });
        if (metadataOnly) {
          const mergeWithoutTreeChanges = commit.parents.length > 1;
          await warn(
            mergeWithoutTreeChanges ? "merge-topology" : "empty-commit",
            mergeWithoutTreeChanges
              ? "A Git merge with no tree changes was imported as a single-parent metadata-only Lore revision."
              : "A Git commit with no tree changes was imported as a metadata-only Lore revision.",
            sha,
          );
        }
        const changes = parseGitNameStatus(
          await this.git(
            job.id,
            [
              "--git-dir",
              mirror,
              "diff-tree",
              "--no-commit-id",
              "--name-status",
              "-z",
              "-r",
              "-M",
              firstParent ?? EMPTY_GIT_TREE,
              sha,
            ],
            controller.signal,
          ),
        );
        if (firstParent) {
          await this.command(
            job.id,
            this.config.loreCliPath,
            loreBranchSwitchArgs(
              branchName,
              revisions.get(firstParent)!.signature,
            ),
            loreCommandOptions(
              workspace,
              loginToken,
              repositoryToken,
              controller.signal,
            ),
          );
        }

        const sourceParents: Array<ImportedRevision & { tempBranch: string }> = [];
        if (!metadataOnly) {
          for (const parent of commit.parents.slice(1)) {
            let mapped = revisions.get(parent);
            if (!mapped) {
              const detachedBranch = `git-import-${parent.slice(0, 12)}`;
              await importBranch(detachedBranch, parent, true);
              temporaryLoreBranches.add(detachedBranch);
              mapped = revisions.get(parent);
            }
            if (!mapped) {
              throw new Error(`Merge parent ${parent} mapping is missing`);
            }
            const tempBranch = `git-import-${parent.slice(0, 12)}`;
            await this.command(
              job.id,
              this.config.loreCliPath,
              loreBranchSwitchArgs(mapped.branch, mapped.signature),
              loreCommandOptions(
                workspace,
                loginToken,
                repositoryToken,
                controller.signal,
              ),
            );
            await this.command(
              job.id,
              this.config.loreCliPath,
              ["branch", "create", tempBranch],
              loreCommandOptions(
                workspace,
                loginToken,
                repositoryToken,
                controller.signal,
              ),
            ).catch(() => {});
            temporaryLoreBranches.add(tempBranch);
            sourceParents.push({ ...mapped, tempBranch });
          }
        }

        if (sourceParents.length > 0) {
          const firstMapped = revisions.get(firstParent!);
          if (!firstMapped) {
            throw new Error(
              `First parent ${firstParent} has no imported revision`,
            );
          }
          await this.command(
            job.id,
            this.config.loreCliPath,
            loreBranchSwitchArgs(branchName, firstMapped.signature),
            loreCommandOptions(
              workspace,
              loginToken,
              repositoryToken,
              controller.signal,
            ),
          );
          for (let index = 0; index < sourceParents.length; index++) {
            const source = sourceParents[index]!;
            await this.command(
              job.id,
              this.config.loreCliPath,
              [
                "branch",
                "merge",
                "start",
                source.tempBranch,
                "--no-commit",
                "--message",
                commit.message,
              ],
              loreCommandOptions(
                workspace,
                loginToken,
                repositoryToken,
                controller.signal,
              ),
            );
            if (index < sourceParents.length - 1) {
              await this.replaceWorkspace(workspace);
              const archiveName = `synthetic-${index}.tar`;
              const archive = path.join(jobDir, archiveName);
              const extraction = tarExtractionInvocation(jobDir, archive);
              await this.command(
                job.id,
                this.config.gitPath,
                [
                  "--git-dir",
                  mirror,
                  "archive",
                  "--format=tar",
                  `--output=${archive}`,
                  sha,
                ],
                { signal: controller.signal, env: gitEnv },
              );
              await this.command(
                job.id,
                "tar",
                extraction.args,
                { signal: controller.signal, cwd: extraction.cwd },
              );
              await this.normalizeWorkspace(
                job.id,
                workspace,
                mirror,
                sha,
                controller.signal,
                warn,
              );
              await this.command(
                job.id,
                this.config.loreCliPath,
                ["stage", "--scan", "--force", "."],
                loreCommandOptions(
                  workspace,
                  loginToken,
                  repositoryToken,
                  controller.signal,
                ),
              );
              await this.resolveMergeConflicts(
                job.id,
                workspace,
                ["."],
                loginToken,
                repositoryToken,
                controller.signal,
              );
              const syntheticMessage = `${commit.message || "Git merge"}\n\n[git-import synthetic merge ${index + 1}/${sourceParents.length - 1}]`;
              await this.command(
                job.id,
                this.config.loreCliPath,
                ["commit", syntheticMessage],
                loreCommandOptions(
                  workspace,
                  loginToken,
                  repositoryToken,
                  controller.signal,
                ),
              );
              await warn(
                "octopus-merge",
                "Octopus merge was represented as a chain of synthetic two-parent merges.",
                sha,
              );
            }
          }
        }

        const renames: Array<{ from: string; to: string }> = [];
        for (const change of changes) {
          if (change.status.startsWith("R") && change.oldPath) {
            renames.push({ from: change.oldPath, to: change.path });
          } else if (change.status.startsWith("C") && change.oldPath) {
            await warn(
              "rename-identity",
              "Git copy was imported as a new file.",
              sha,
              `${change.oldPath} -> ${change.path}`,
            );
          }
        }

        const exactSnapshot = !firstParent || sourceParents.length > 0;
        if (!exactSnapshot) {
          await this.applyGitChanges(
            job.id,
            workspace,
            mirror,
            sha,
            jobDir,
            changes,
            controller.signal,
            gitEnv,
          );
          await this.normalizeChangedPaths(
            job.id,
            workspace,
            mirror,
            sha,
            changes,
            controller.signal,
            warn,
          );
        } else {
          await this.materializeGitCommit(
            job.id,
            workspace,
            mirror,
            sha,
            jobDir,
            controller.signal,
            gitEnv,
            warn,
          );
        }
        if (!exactSnapshot) {
          for (const rename of renames) {
            await this.command(
              job.id,
              this.config.loreCliPath,
              ["stage", "move", rename.from, rename.to, "--force"],
              loreCommandOptions(
                workspace,
                loginToken,
                repositoryToken,
                controller.signal,
              ),
            ).catch(async (error: unknown) => {
              await warn(
                "rename-identity",
                "Lore could not preserve this Git rename; imported as delete plus add.",
                sha,
                `${rename.from} -> ${rename.to}`,
              );
              return { stdout: "", stderr: String(error) };
            });
          }
          await this.stageChangedPaths(
            job.id,
            workspace,
            jobDir,
            changes,
            loginToken,
            repositoryToken,
            controller.signal,
          );
        } else {
          await this.command(
            job.id,
            this.config.loreCliPath,
            ["stage", "--scan", "--force", "."],
            loreCommandOptions(
              workspace,
              loginToken,
              repositoryToken,
              controller.signal,
            ),
          );
          if (sourceParents.length > 0) {
            await this.resolveMergeConflicts(
              job.id,
              workspace,
              ["."],
              loginToken,
              repositoryToken,
              controller.signal,
            );
          }
        }
        const metadataArgs = [
          "revision",
          "metadata",
          "set",
          "message",
          commit.message,
          "created-by",
          identityLabel(commit.author),
          "git-author-name",
          commit.author.name,
          "git-author-email",
          commit.author.email,
          "git-author-time",
          commit.author.timestamp,
          "git-committer-name",
          commit.committer.name,
          "git-committer-email",
          commit.committer.email,
          "git-committer-time",
          commit.committer.timestamp,
          "git-sha",
          sha,
        ];
        await this.command(
          job.id,
          this.config.loreCliPath,
          metadataArgs,
          loreCommandOptions(
            workspace,
            loginToken,
            repositoryToken,
            controller.signal,
          ),
        );
        const commitArgs = [
          ...(metadataOnly ? ["revision", "commit", "--force"] : ["commit"]),
          commit.message || "(empty Git commit)",
        ];
        let commitOutput;
        try {
          commitOutput = await this.command(
            job.id,
            this.config.loreCliPath,
            commitArgs,
            loreCommandOptions(
              workspace,
              loginToken,
              repositoryToken,
              controller.signal,
            ),
          );
        } catch (error) {
          if (
            sourceParents.length === 0 ||
            !(error instanceof Error) ||
            !error.message.includes("still in conflict")
          ) {
            throw error;
          }
          await this.command(
            job.id,
            this.config.loreCliPath,
            ["branch", "merge", "abort", "--force"],
            loreCommandOptions(
              workspace,
              loginToken,
              repositoryToken,
              controller.signal,
            ),
          );
          await this.materializeGitCommit(
            job.id,
            workspace,
            mirror,
            sha,
            jobDir,
            controller.signal,
            gitEnv,
            warn,
          );
          await this.command(
            job.id,
            this.config.loreCliPath,
            ["stage", "--scan", "--force", "."],
            loreCommandOptions(
              workspace,
              loginToken,
              repositoryToken,
              controller.signal,
            ),
          );
          await this.command(
            job.id,
            this.config.loreCliPath,
            metadataArgs,
            loreCommandOptions(
              workspace,
              loginToken,
              repositoryToken,
              controller.signal,
            ),
          );
          commitOutput = await this.command(
            job.id,
            this.config.loreCliPath,
            commitArgs,
            loreCommandOptions(
              workspace,
              loginToken,
              repositoryToken,
              controller.signal,
            ),
          );
          await warn(
            "merge-topology",
            "Lore could not resolve this merge; the final Git tree was imported as a single-parent revision.",
            sha,
          );
        }
        const signature = commitOutput.stdout.match(
          /Signature\s*:\s*([0-9a-f]{64})/i,
        )?.[1];
        if (!signature) throw new Error(`Could not read Lore revision for ${sha}`);
        revisions.set(sha, { signature, branch: branchName });
        await this.db.query(
          `INSERT INTO repository_import_revisions
             (import_id, git_sha, lore_revision, branch_name,
              git_committer_time)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (import_id, git_sha)
           DO UPDATE SET lore_revision = EXCLUDED.lore_revision,
                         branch_name = EXCLUDED.branch_name,
                         git_committer_time = EXCLUDED.git_committer_time`,
          [
            job.id,
            sha,
            signature,
            branchName,
            Number(commit.committer.timestamp) * 1000,
          ],
        );
        await this.db.query(
          `INSERT INTO repository_revision_git_times
             (repository_id, lore_revision, git_committer_time)
           VALUES ($1, $2, $3)
           ON CONFLICT (repository_id, lore_revision)
           DO UPDATE SET git_committer_time = EXCLUDED.git_committer_time`,
          [
            pending.id,
            signature,
            Number(commit.committer.timestamp) * 1000,
          ],
        );
        await this.db.query(
          `UPDATE repository_imports
              SET imported_commits = (
                SELECT count(*) FROM repository_import_revisions
                 WHERE import_id = $1
              )
            WHERE id = $1`,
          [job.id],
        );
      }
      if (!temporary) {
        await this.command(
          job.id,
          this.config.loreCliPath,
          ["push", branchName],
          loreCommandOptions(
            workspace,
            loginToken,
            repositoryToken,
            controller.signal,
          ),
        );
      }
      const tip = revisions.get(chain.at(-1)!);
      if (!tip) throw new Error(`Branch ${branchName} has no imported tip`);
      branchTips.set(branchName, tip);
      importedBranches.add(branchName);
      importingBranches.delete(branchName);
      void branchByTip;
    };

    const ordered = [
      defaultBranch,
      ...branches
        .map((branch) => branch.name)
        .filter((name) => name !== defaultBranch)
        .sort(),
    ];
    for (const branch of ordered) await importBranch(branch);
    for (const [sourceBranch, tip] of branchTips) {
      await this.ensureImportedBranchTip(
        job.id,
        workspace,
        sourceBranch,
        tip,
        defaultBranch,
        loginToken,
        repositoryToken,
        controller.signal,
      );
    }
    for (const temporaryBranch of temporaryLoreBranches) {
      await this.command(
        job.id,
        this.config.loreCliPath,
        ["branch", "archive", temporaryBranch, "--force"],
        loreCommandOptions(
          workspace,
          loginToken,
          repositoryToken,
          controller.signal,
        ),
      ).catch(() => {});
    }

    await this.phase(job.id, "creating_refs");
    if (job.include_tags === 1) {
      await this.phase(job.id, "importing_tags");
      const tags = await this.gitTags(job.id, mirror, controller.signal);
      for (const tag of tags) {
        if (tag.type !== "commit") {
          const target = await this.git(
            job.id,
            ["--git-dir", mirror, "rev-parse", `${tag.objectId}^{commit}`],
            controller.signal,
          ).catch(() => "");
          const sha = target.trim();
          if (sha && revisions.has(sha)) {
            await this.storeTag(pending.id, tag, revisions.get(sha)!);
          } else {
            await warn(
              "tag-target",
              `Tag ${tag.name} does not point to an imported commit.`,
              tag.objectId,
            );
          }
        } else if (revisions.has(tag.objectId)) {
          await this.storeTag(pending.id, tag, revisions.get(tag.objectId)!);
        } else {
          await warn(
            "tag-target",
            `Tag ${tag.name} points to a commit outside the imported history.`,
            tag.objectId,
          );
        }
      }
    }

    await this.phase(job.id, "finalizing");
    await this.finish(job.id, "succeeded", "");
    await this.log(job.id, `Import completed with ${revisions.size} revisions\n`);
    await removePathWithRetry(jobDir);
  }

  private async prepareLoreBranch(
    jobId: string,
    workspace: string,
    branchName: string,
    defaultBranch: string,
    parent: ImportedRevision | undefined,
    revisions: Map<string, ImportedRevision>,
    identityToken: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const start = parent?.signature ?? ZERO_REVISION;
    const branches = (
      await this.command(
        jobId,
        this.config.loreCliPath,
        ["branch", "list"],
        loreCommandOptions(workspace, identityToken, accessToken, signal),
      )
    ).stdout;
    const exists = branches.split("\n").some((line) => line.includes(branchName));
    if (exists) {
      if (start !== ZERO_REVISION) {
        await this.command(
          jobId,
          this.config.loreCliPath,
          loreBranchSwitchArgs(branchName, start),
          loreCommandOptions(workspace, identityToken, accessToken, signal),
        );
      }
      return;
    }
    const owner = parent?.branch ?? defaultBranch;
    await this.command(
      jobId,
      this.config.loreCliPath,
      loreBranchSwitchArgs(owner, start),
      loreCommandOptions(workspace, identityToken, accessToken, signal),
    );
    await this.command(
      jobId,
      this.config.loreCliPath,
      ["branch", "create", branchName],
      loreCommandOptions(workspace, identityToken, accessToken, signal),
    );
    await this.command(
      jobId,
      this.config.loreCliPath,
      loreBranchSwitchArgs(branchName, ZERO_REVISION),
      loreCommandOptions(workspace, identityToken, accessToken, signal),
    );
    if (revisions.size === 0 && parent) {
      throw new Error("Cannot create an additional root branch");
    }
  }

  private async materializeGitCommit(
    jobId: string,
    workspace: string,
    mirror: string,
    sha: string,
    jobDir: string,
    signal: AbortSignal,
    gitEnv: NodeJS.ProcessEnv,
    warn: (
      kind: string,
      message: string,
      objectId?: string,
      filePath?: string,
    ) => Promise<void>,
  ): Promise<void> {
    await this.replaceWorkspace(workspace);
    const archiveName = `snapshot-${sha.slice(0, 12)}.tar`;
    const archive = path.join(jobDir, archiveName);
    const extraction = tarExtractionInvocation(jobDir, archive);
    try {
      await this.command(
        jobId,
        this.config.gitPath,
        [
          "--git-dir",
          mirror,
          "archive",
          "--format=tar",
          `--output=${archive}`,
          sha,
        ],
        { signal, env: gitEnv },
      );
      await this.command(
        jobId,
        "tar",
        extraction.args,
        { signal, cwd: extraction.cwd },
      );
      await this.normalizeWorkspace(
        jobId,
        workspace,
        mirror,
        sha,
        signal,
        warn,
      );
    } finally {
      await removePathWithRetry(archive);
    }
  }

  private async applyGitChanges(
    jobId: string,
    workspace: string,
    mirror: string,
    sha: string,
    jobDir: string,
    changes: GitChange[],
    signal: AbortSignal,
    gitEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    const removePaths = new Set<string>();
    const extractPaths = new Set<string>();
    for (const change of changes) {
      const kind = change.status[0];
      if (kind === "R" || kind === "T") {
        removePaths.add(change.oldPath ?? change.path);
      }
      if (kind === "D") {
        removePaths.add(change.path);
      } else {
        extractPaths.add(change.path);
      }
    }
    for (const changedPath of removePaths) {
      if (isReservedWorkspacePath(changedPath)) continue;
      await removePathWithRetry(
        resolveWorkspacePath(workspace, changedPath),
      );
    }
    await this.extractGitPaths(
      jobId,
      workspace,
      mirror,
      sha,
      jobDir,
      [...extractPaths].filter((changedPath) =>
        !isReservedWorkspacePath(changedPath),
      ),
      signal,
      gitEnv,
    );
  }

  private async extractGitPaths(
    jobId: string,
    workspace: string,
    mirror: string,
    sha: string,
    jobDir: string,
    changedPaths: string[],
    signal: AbortSignal,
    gitEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    for (let start = 0; start < changedPaths.length; start += 100) {
      const batch = changedPaths.slice(start, start + 100);
      const archiveName = `changed-${start / 100}.tar`;
      const archive = path.join(jobDir, archiveName);
      const extraction = tarExtractionInvocation(jobDir, archive);
      try {
        await this.command(
          jobId,
          this.config.gitPath,
          [
            "--git-dir",
            mirror,
            "archive",
            "--format=tar",
            `--output=${archive}`,
            sha,
            "--",
            ...batch.map((changedPath) => `:(literal)${changedPath}`),
          ],
          { signal, env: gitEnv },
        );
        await this.command(
          jobId,
          "tar",
          extraction.args,
          { signal, cwd: extraction.cwd },
        );
      } finally {
        await removePathWithRetry(archive);
      }
    }
  }

  private async normalizeChangedPaths(
    jobId: string,
    workspace: string,
    mirror: string,
    sha: string,
    changes: GitChange[],
    signal: AbortSignal,
    warn: (
      kind: string,
      message: string,
      objectId?: string,
      filePath?: string,
    ) => Promise<void>,
  ): Promise<void> {
    const changedPaths = [
      ...new Set(
        changes
          .filter((change) => change.status[0] !== "D")
          .map((change) => change.path)
          .filter((changedPath) => !isReservedWorkspacePath(changedPath)),
      ),
    ];
    for (const changedPath of changedPaths) {
      const fullPath = resolveWorkspacePath(workspace, changedPath);
      const entry = await lstat(fullPath).catch(() => null);
      if (!entry) continue;
      if (entry.isSymbolicLink()) {
        const target = await readlink(fullPath);
        await removePathWithRetry(fullPath);
        await writeFile(fullPath, target, "utf8");
        await warn(
          "symlink",
          "Git symlink imported as a regular text file.",
          "",
          changedPath,
        );
      } else if (entry.isFile()) {
        const handle = await open(fullPath, "r");
        try {
          const header = Buffer.alloc(64);
          const { bytesRead } = await handle.read(header, 0, 64, 0);
          if (
            header
              .subarray(0, bytesRead)
              .toString("utf8")
              .startsWith("version https://git-lfs.github.com/spec/v1")
          ) {
            await warn(
              "lfs-pointer",
              "LFS pointer imported as an ordinary file.",
              "",
              changedPath,
            );
          }
        } finally {
          await handle.close();
        }
      }
    }

    if (changedPaths.length === 0) return;
    const listing = await this.command(
      jobId,
      this.config.gitPath,
      [
        "--git-dir",
        mirror,
        "ls-tree",
        "-r",
        "-z",
        sha,
        "--",
        ...changedPaths.map((changedPath) => `:(literal)${changedPath}`),
      ],
      { signal },
    ).catch(() => ({ stdout: "", stderr: "" }));
    if (listing.stdout.includes("160000 commit")) {
      await warn(
        "submodule",
        "Git submodules are ignored and are not part of the Lore revision.",
      );
    }
  }

  private async stageChangedPaths(
    jobId: string,
    workspace: string,
    jobDir: string,
    changes: GitChange[],
    identityToken: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const changedPaths = [
      ...new Set(
        changes
          .flatMap((change) =>
            change.oldPath
              ? [change.oldPath, change.path]
              : [change.path],
          )
          .filter((changedPath) => !isReservedWorkspacePath(changedPath)),
      ),
    ];
    if (changedPaths.length === 0) return;
    const targets = path.join(jobDir, "changed-paths.txt");
    await writeFile(targets, `${changedPaths.join("\n")}\n`, "utf8");
    try {
      await this.command(
        jobId,
        this.config.loreCliPath,
        ["stage", "--scan", "--force", "--targets", targets],
        loreCommandOptions(workspace, identityToken, accessToken, signal),
      );
    } finally {
      await removePathWithRetry(targets);
    }
  }

  private async ensureImportedBranchTip(
    jobId: string,
    workspace: string,
    branchName: string,
    tip: ImportedRevision,
    fallbackBranch: string,
    identityToken: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const branches = (
      await this.command(
        jobId,
        this.config.loreCliPath,
        ["branch", "list"],
        loreCommandOptions(workspace, identityToken, accessToken, signal),
      )
    ).stdout;
    const exists = branches
      .split("\n")
      .some((line) => line.split(/\s+/).includes(branchName));
    if (!exists) {
      await this.command(
        jobId,
        this.config.loreCliPath,
        loreBranchSwitchArgs(fallbackBranch, tip.signature),
        loreCommandOptions(workspace, identityToken, accessToken, signal),
      );
      await this.command(
        jobId,
        this.config.loreCliPath,
        ["branch", "create", branchName],
        loreCommandOptions(workspace, identityToken, accessToken, signal),
      );
    }
    await this.command(
      jobId,
      this.config.loreCliPath,
      loreBranchSwitchArgs(branchName, tip.signature),
      loreCommandOptions(workspace, identityToken, accessToken, signal),
    );
    await this.command(
      jobId,
      this.config.loreCliPath,
      ["push", branchName],
      loreCommandOptions(workspace, identityToken, accessToken, signal),
    );
  }

  private async resolveMergeConflicts(
    jobId: string,
    workspace: string,
    pathArguments: string[],
    identityToken: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.command(
        jobId,
        this.config.loreCliPath,
        ["branch", "merge", "resolve", "mine", "--force", ...pathArguments],
        loreCommandOptions(workspace, identityToken, accessToken, signal),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("No conflict to resolve")
      ) {
        return;
      }
      throw error;
    }
  }

  private async replaceWorkspace(workspace: string): Promise<void> {
    await mkdir(workspace, { recursive: true });
    for (const entry of await readdir(workspace)) {
      if (entry === ".lore") continue;
      await removePathWithRetry(path.join(workspace, entry));
    }
  }

  private async normalizeWorkspace(
    jobId: string,
    workspace: string,
    mirror: string,
    sha: string,
    signal: AbortSignal,
    warn: (
      kind: string,
      message: string,
      objectId?: string,
      filePath?: string,
    ) => Promise<void>,
  ): Promise<void> {
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".lore") continue;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await readlink(full);
          await removePathWithRetry(full);
          await writeFile(full, target, "utf8");
          await warn(
            "symlink",
            "Git symlink imported as a regular text file.",
            "",
            path.relative(workspace, full),
          );
        } else if (entry.isDirectory()) {
          await visit(full);
        } else if (entry.isFile()) {
          const file = await readFile(full);
          if (
            file.subarray(0, 64).toString("utf8").startsWith(
              "version https://git-lfs.github.com/spec/v1",
            )
          ) {
            await warn(
              "lfs-pointer",
              "LFS pointer imported as an ordinary file.",
              "",
              path.relative(workspace, full),
            );
          }
        }
      }
    };
    await visit(workspace);
    const listing = await this.command(
      jobId,
      this.config.gitPath,
      ["--git-dir", mirror, "ls-tree", "-r", "-z", sha],
      { signal },
    ).catch(() => ({ stdout: "", stderr: "" }));
    if (listing.stdout.includes("160000 commit")) {
      await warn(
        "submodule",
        "Git submodules are ignored and are not part of the Lore revision.",
      );
    }
  }

  private async readCommit(
    jobId: string,
    mirror: string,
    sha: string,
    signal: AbortSignal,
  ): Promise<GitCommit> {
    const body = await this.git(
      jobId,
      ["--git-dir", mirror, "cat-file", "-p", sha],
      signal,
    );
    const split = body.indexOf("\n\n");
    const headers = split >= 0 ? body.slice(0, split) : body;
    const message = split >= 0 ? body.slice(split + 2) : "";
    const parents = headers
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length));
    return {
      sha,
      parents,
      author: parseGitIdentity(headers, "author"),
      committer: parseGitIdentity(headers, "committer"),
      message: message.replace(/\r\n/g, "\n").trimEnd(),
    };
  }

  private async gitBranches(
    jobId: string,
    mirror: string,
    signal: AbortSignal,
  ): Promise<Array<{ name: string; sha: string }>> {
    const output = await this.git(
      jobId,
      [
        "--git-dir",
        mirror,
        "for-each-ref",
        "--format=%(refname:short)%00%(objectname)",
        "refs/heads",
      ],
      signal,
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, sha] = line.split("\0");
        return { name: name ?? "", sha: sha ?? "" };
      });
  }

  private async gitTags(
    jobId: string,
    mirror: string,
    signal: AbortSignal,
  ): Promise<GitTagRef[]> {
    const output = await this.git(
      jobId,
      [
        "--git-dir",
        mirror,
        "for-each-ref",
        "--format=%(refname:short)%00%(objectname)%00%(objecttype)%00%(taggername)%00%(taggeremail)%00%(contents:subject)",
        "refs/tags",
      ],
      signal,
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, objectId, type, tagger, taggerEmail, message] =
          line.split("\0");
        return {
          name: name ?? "",
          objectId: objectId ?? "",
          type: type ?? "",
          tagger: tagger ?? "",
          taggerEmail: taggerEmail ?? "",
          message: message ?? "",
        };
      });
  }

  private async branchContaining(
    jobId: string,
    mirror: string,
    sha: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const output = await this.git(
      jobId,
      [
        "--git-dir",
        mirror,
        "for-each-ref",
        `--contains=${sha}`,
        "--format=%(refname:short)",
        "refs/heads",
      ],
      signal,
    );
    return output.split("\n").find(Boolean) ?? null;
  }

  private async storeTag(
    repositoryId: string,
    tag: GitTagRef,
    revision: ImportedRevision,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO repository_tags
         (repository_id, name, lore_revision, branch_name,
          annotated, tagger, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (repository_id, name)
       DO UPDATE SET lore_revision = EXCLUDED.lore_revision,
                     annotated = EXCLUDED.annotated,
                     branch_name = EXCLUDED.branch_name,
                     tagger = EXCLUDED.tagger,
                     message = EXCLUDED.message`,
      [
        repositoryId,
        tag.name,
        revision.signature,
        revision.branch,
        tag.type === "tag" ? 1 : 0,
        [tag.tagger, tag.taggerEmail].filter(Boolean).join(" "),
        tag.message,
      ],
    );
  }

  private async phase(id: string, phase: RepositoryImportPhase): Promise<void> {
    await this.db.query(
      `UPDATE repository_imports SET phase = $2 WHERE id = $1`,
      [id, phase],
    );
    await this.log(id, `Phase: ${phase}\n`);
  }

  private async finish(
    id: string,
    status: Exclude<RepositoryImportStatus, "queued" | "running">,
    errorMessage: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE repository_imports
          SET status = $2, phase = CASE WHEN $2 = 'succeeded' THEN 'finalizing'
                                        ELSE 'cleaning_up' END,
              error_message = $3, finished_at = $4, queue_slot = NULL
        WHERE id = $1`,
      [id, status, errorMessage, nowIso()],
    );
  }

  private async settleFailedJob(
    job: ImportRow,
    error: unknown,
  ): Promise<void> {
    const cancelled = error instanceof ImportCancelledError;
    const message = error instanceof Error ? error.message : String(error);
    await this.safeLog(job.id, `${message}\n`);

    let latest = job;
    try {
      const result = await this.db.query<ImportRow>(
        `SELECT * FROM repository_imports WHERE id = $1`,
        [job.id],
      );
      latest = result.rows[0] ?? job;
    } catch (lookupError) {
      await this.safeLog(
        job.id,
        `Failed to reload import job during cleanup: ${
          lookupError instanceof Error
            ? lookupError.message
            : String(lookupError)
        }\n`,
      );
    }

    try {
      await this.cleanupTarget(latest);
    } catch (cleanupError) {
      await this.safeLog(
        job.id,
        `Failed to clean import artifacts: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }\n`,
      );
    }
    try {
      await this.finish(
        job.id,
        cancelled ? "cancelled" : "failed",
        message,
      );
    } catch (finishError) {
      await this.safeLog(
        job.id,
        `Failed to persist terminal import status: ${
          finishError instanceof Error
            ? finishError.message
            : String(finishError)
        }\n`,
      );
    }
  }

  private async cleanupTarget(job: ImportRow): Promise<void> {
    if (job.target_repository_id) {
      const repository = await findRepositoryById(
        this.db,
        job.target_repository_id,
      ).catch(() => null);
      const actor = await findUserById(this.db, job.actor_user_id).catch(() => null);
      if (repository && actor) {
        let removed = false;
        try {
          const token = await issueRepositoryToken(
            this.db,
            this.tokens,
            actor,
            repository,
          );
          for (let attempt = 0; attempt < 30; attempt++) {
            try {
              await this.lore.deleteRepository(repository.id, token);
              removed = true;
              break;
            } catch (error) {
              if (error instanceof AppError && error.code === "not_found") {
                removed = true;
                break;
              }
              if (attempt === 29) throw error;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
        } catch (error) {
          await this.safeLog(
            job.id,
            `Failed to remove incomplete repository ${repository.id}: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
          if (!(error instanceof AppError && error.code === "not_found")) {
            await this.db.query(
              `UPDATE repositories SET status = 'failed' WHERE id = $1`,
              [repository.id],
            );
          }
        }
        if (removed) {
          await this.db.query(`DELETE FROM repositories WHERE id = $1`, [
            repository.id,
          ]);
        }
      }
    }
    try {
      await removePathWithRetry(
        path.join(this.config.loreImportWorkDir, job.id),
      );
    } catch (error) {
      await this.safeLog(
        job.id,
        `Failed to remove import workspace: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  private async validateUrlSource(
    value: string,
    allowPrivate = false,
  ): Promise<URL> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw badRequest("Invalid Git URL");
    }
    if (!["http:", "https:", "git:"].includes(url.protocol)) {
      throw badRequest("URL must use http://, https://, or git://");
    }
    if (url.username || url.password) {
      throw badRequest("Do not embed credentials in the Git URL");
    }
    const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
    if (addresses.length === 0) {
      throw badRequest("Git URL hostname could not be resolved");
    }
    if (
      !allowPrivate &&
      addresses.some((entry) => isPrivateAddress(entry.address))
    ) {
      throw badRequest("Git URL must resolve only to public addresses");
    }
    return url;
  }

  private async detectProvider(
    source: URL,
    credentials?: GitCredentials,
  ): Promise<ProviderIdentity> {
    const host = source.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      if (!credentials) return { name: "github" };
      const response = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${credentials.token}`,
          accept: "application/vnd.github+json",
          "user-agent": "yeomai-lore-import",
        },
      });
      if (!response.ok) {
        throw badRequest("GitHub access token was rejected");
      }
      const user = (await response.json()) as { login?: unknown };
      if (typeof user.login !== "string" || !user.login) {
        throw badRequest("GitHub access token has no resolvable user");
      }
      return { name: "github", username: user.login };
    }
    if (source.protocol === "git:") {
      throw badRequest("git:// is only supported for github.com");
    }
    const basePaths = new Set<string>([source.origin]);
    const segments = source.pathname.split("/").filter(Boolean);
    if (segments.length > 2) {
      basePaths.add(`${source.origin}/${segments.slice(0, -2).join("/")}`);
    }
    for (const base of basePaths) {
      const response = await fetch(`${base}/api/v1/version`).catch(() => null);
      if (response?.ok) {
        if (!credentials) return { name: "gitea" };
        const userResponse = await fetch(`${base}/api/v1/user`, {
          headers: { authorization: `token ${credentials.token}` },
        });
        if (!userResponse.ok) {
          throw badRequest("Gitea access token was rejected");
        }
        const user = (await userResponse.json()) as {
          login?: unknown;
        };
        if (typeof user.login !== "string" || !user.login) {
          throw badRequest("Gitea access token has no resolvable user");
        }
        return { name: "gitea", username: user.login };
      }
    }
    throw badRequest("Git URL is neither a GitHub nor a Gitea repository");
  }


  private async command(
    jobId: string,
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
    } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    throwIfAborted(options.signal);
    try {
      const commandEnv = options.env ?? process.env;
      const refresher = this.loreCredentialRefreshers.get(jobId);
      const env =
        refresher &&
        (commandEnv.LORE_IDENTITY_TOKEN || commandEnv.LORE_ACCESS_TOKEN)
          ? await refresher().then((credentials) => ({
              ...commandEnv,
              LORE_IDENTITY_TOKEN: credentials.identityToken,
              LORE_ACCESS_TOKEN: credentials.repositoryToken,
            }))
          : commandEnv;
      const result = await run(command, args, {
        cwd: options.cwd,
        env,
        signal: options.signal,
        timeout: 30 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.stderr.trim()) await this.log(jobId, result.stderr);
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw new ImportCancelledError("Import cancelled");
      const detail =
        typeof error === "object" && error && "stderr" in error
          ? String(error.stderr).trim()
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(
        `${command} failed: ${detail}\nCommand: ${[command, ...args].join(" ")}`,
      );
    }
  }

  private git(
    jobId: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<string> {
    return this.command(jobId, this.config.gitPath, args, { signal }).then(
      (result) => result.stdout,
    );
  }

  private async log(id: string, message: string): Promise<void> {
    const logDir = path.join(this.config.loreImportWorkDir, "logs");
    await mkdir(logDir, { recursive: true });
    await appendFile(this.logPath(id), message, "utf8");
  }

  private async safeLog(id: string, message: string): Promise<void> {
    try {
      await this.log(id, message);
    } catch (error) {
      console.error("Failed to write import log", {
        jobId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async directorySize(directory: string): Promise<number> {
    let total = 0;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        total += await this.directorySize(fullPath);
      } else if (entry.isFile()) {
        total += (await stat(fullPath).catch(() => null))?.size ?? 0;
      }
    }
    return total;
  }
}

function isReservedWorkspacePath(changedPath: string): boolean {
  return changedPath === ".lore" || changedPath.startsWith(".lore/");
}

function resolveWorkspacePath(
  workspace: string,
  changedPath: string,
): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, changedPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Git path escapes the import workspace: ${changedPath}`);
  }
  if (isReservedWorkspacePath(changedPath)) {
    throw new Error(`Reserved Lore workspace path in Git source: ${changedPath}`);
  }
  return resolved;
}

async function removePathWithRetry(target: string): Promise<void> {
  const retryable = new Set([
    "EBUSY",
    "EACCES",
    "EPERM",
    "ENOTEMPTY",
    "EMFILE",
    "ENFILE",
  ]);
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
      });
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if (!retryable.has(code) || attempt === 9) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2_000, 100 * 2 ** attempt)),
      );
    }
  }
}

function loreCommandOptions(
  cwd: string,
  identityToken: string,
  accessToken: string,
  signal: AbortSignal,
) {
  return {
    cwd,
    signal,
    env: loreCommandEnvironment(identityToken, accessToken),
  };
}

export function loreCommandEnvironment(
  identityToken: string,
  accessToken: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    LORE_IDENTITY_TOKEN: identityToken,
    LORE_ACCESS_TOKEN: accessToken,
  };
}

export function loreBranchSwitchArgs(
  branchName: string,
  revision: string,
): string[] {
  return revision === ZERO_REVISION
    ? ["branch", "switch", branchName, "--force", "--reset"]
    : ["branch", "switch", branchName, revision, "--force", "--reset"];
}

function mapImport(
  row: ImportRow,
  queuePosition: number | null = null,
): RepositoryImportRecord {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username ?? row.actor_user_id,
    targetRepositoryId: row.target_repository_id,
    sourceKind: "url",
    sourceValue: row.source_value,
    provider: row.provider,
    includeTags: Boolean(row.include_tags),
    targetOrganizationSlug: row.target_organization_slug,
    targetSlug: row.target_slug,
    targetDescription: row.target_description,
    sourceDefaultBranch: row.source_default_branch,
    status: row.status,
    phase: row.phase,
    totalCommits: Number(row.total_commits),
    importedCommits: Number(row.imported_commits),
    totalBytes: Number(row.total_bytes),
    importedBytes: Number(row.imported_bytes),
    errorMessage: row.error_message,
    queuePosition,
    requestedAt: toIsoString(row.requested_at ?? row.created_at),
    createdAt: toIsoString(row.created_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : null,
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : null,
  };
}

function parseGitIdentity(headers: string, key: "author" | "committer"): GitIdentity {
  const line = headers.split("\n").find((item) => item.startsWith(`${key} `));
  const value = line?.slice(key.length + 1) ?? "";
  const match = value.match(/^(.*?) <(.*?)> (\d+) [+-]\d{4}$/);
  return {
    name: match?.[1] ?? "",
    email: match?.[2] ?? "",
    timestamp: match?.[3] ?? "0",
  };
}

function identityLabel(identity: GitIdentity): string {
  if (identity.name && identity.email) {
    return `${identity.name} <${identity.email}>`;
  }
  return identity.name || identity.email || "Unknown";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportCancelledError("Import cancelled");
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}
