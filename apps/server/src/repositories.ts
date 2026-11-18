import {
  badRequest,
  conflict,
  effectiveRepositoryPermission,
  forbidden,
  newId,
  notFound,
  permissionSatisfies,
  type OrgRole,
  type RepoPermission,
  type RepositoryRecord,
  type SessionUser,
} from "@lore-portal/shared";
import {
  isUniqueConstraint,
  nowIso,
  toIsoString,
  withTransaction,
  type Database,
  type QueryExecutor,
} from "./db/index.ts";
import { audit } from "./auth/audit.ts";

// Lore derives the default "main" branch context from the first 16 bytes of
// BLAKE3("main"). Keeping the same value lets repositories created directly
// by Lore clients resolve correctly in the portal.
export const LORE_MAIN_BRANCH_ID = "e726318b-bc3f-d75a-c873-3a7e030cc35b";

interface RepositoryRow {
  id: string;
  organization_id: string | null;
  owner_user_id: string | null;
  organization_slug: string;
  organization_name: string;
  slug: string;
  lore_name: string;
  description: string;
  default_branch_id: string;
  default_branch_name: string;
  created_by: string;
  status: RepositoryRecord["status"];
  created_at: string;
}

function mapRepository(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    organizationSlug: row.organization_slug,
    organizationName: row.organization_name,
    slug: row.slug,
    name: row.lore_name,
    description: row.description,
    defaultBranchId: row.default_branch_id,
    defaultBranchName: row.default_branch_name,
    createdBy: row.created_by,
    status: row.status,
    createdAt: toIsoString(row.created_at),
  };
}

const repositorySelect = `
  SELECT r.id, r.organization_id, r.owner_user_id,
         COALESCE(o.slug, owner.username) AS organization_slug,
         COALESCE(o.name, owner.display_name) AS organization_name,
         r.slug, r.lore_name, r.description,
         r.default_branch_id, r.default_branch_name, r.created_by, r.status,
         r.created_at
    FROM repositories r
    LEFT JOIN organizations o ON o.id = r.organization_id
    LEFT JOIN users owner ON owner.id = r.owner_user_id
`;

export async function listAccessibleRepositories(
  db: QueryExecutor,
  user: SessionUser,
): Promise<RepositoryRecord[]> {
  const result = await db.query<RepositoryRow>(
    `${repositorySelect}
      WHERE r.status <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM repository_imports ri
           WHERE ri.target_repository_id = r.id
             AND ri.status IN ('queued', 'running')
        )
        AND (
          r.owner_user_id = $1
          OR EXISTS (
            SELECT 1 FROM organization_members om
             WHERE om.organization_id = r.organization_id
               AND om.user_id = $1
               AND om.role IN ('owner', 'admin')
          )
          OR EXISTS (
            SELECT 1 FROM repository_grants rg
             WHERE rg.repository_id = r.id
               AND rg.subject_type = 'user'
               AND rg.subject_id = $1
          )
          OR EXISTS (
            SELECT 1
              FROM repository_grants rg
              JOIN team_members tm ON tm.team_id = rg.subject_id
             WHERE rg.repository_id = r.id
               AND rg.subject_type = 'team'
               AND tm.user_id = $1
          )
        )
      ORDER BY COALESCE(o.slug, owner.username), r.slug`,
    [user.id],
  );
  return result.rows.map(mapRepository);
}

export async function listAccessibleRepositoriesWithPermission(
  db: QueryExecutor,
  user: SessionUser,
): Promise<
  Array<
    RepositoryRecord & {
      permission: RepoPermission;
      canDelete: boolean;
    }
  >
> {
  const repositories = await listAccessibleRepositories(db, user);
  const result: Array<
    RepositoryRecord & {
      permission: RepoPermission;
      canDelete: boolean;
    }
  > = [];
  for (const repository of repositories) {
    const permission = await repositoryPermission(db, user, repository);
    if (permission) {
      result.push({
        ...repository,
        permission,
        canDelete: await canDeleteRepository(db, user, repository),
      });
    }
  }
  return result;
}

export async function canDeleteRepository(
  db: QueryExecutor,
  user: SessionUser,
  repository: RepositoryRecord,
): Promise<boolean> {
  if (repository.ownerUserId) {
    return repository.ownerUserId === user.id;
  }
  if (!repository.organizationId) {
    return false;
  }
  const role = await organizationRole(db, user.id, repository.organizationId);
  return role === "owner" || role === "admin";
}

export async function findRepositoryBySlug(
  db: QueryExecutor,
  organizationSlug: string,
  repositorySlug: string,
): Promise<RepositoryRecord | null> {
  const result = await db.query<RepositoryRow>(
    `${repositorySelect}
      WHERE r.slug = $2
        AND r.status <> 'deleted'
        AND (
          o.slug = $1
          OR lower(owner.username) = lower($1)
        )
      ORDER BY CASE WHEN o.slug = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [organizationSlug, repositorySlug],
  );
  return result.rows[0] ? mapRepository(result.rows[0]) : null;
}

export async function findRepositoryById(
  db: QueryExecutor,
  repositoryId: string,
): Promise<RepositoryRecord | null> {
  const result = await db.query<RepositoryRow>(
    `${repositorySelect}
      WHERE r.id = $1 AND r.status <> 'deleted'`,
    [repositoryId],
  );
  return result.rows[0] ? mapRepository(result.rows[0]) : null;
}

export async function organizationRole(
  db: QueryExecutor,
  userId: string,
  organizationId: string,
): Promise<OrgRole | null> {
  const result = await db.query<{ role: OrgRole }>(
    `SELECT role FROM organization_members
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  return result.rows[0]?.role ?? null;
}

export async function repositoryPermission(
  db: QueryExecutor,
  user: SessionUser,
  repository: RepositoryRecord,
): Promise<RepoPermission | null> {
  const [membership, direct, teams] = await Promise.all([
    repository.organizationId
      ? organizationRole(db, user.id, repository.organizationId)
      : Promise.resolve(null),
    db.query<{ permission: RepoPermission }>(
      `SELECT permission FROM repository_grants
        WHERE repository_id = $1
          AND subject_type = 'user'
          AND subject_id = $2`,
      [repository.id, user.id],
    ),
    db.query<{ permission: RepoPermission }>(
      `SELECT rg.permission
         FROM repository_grants rg
         JOIN team_members tm ON tm.team_id = rg.subject_id
        WHERE rg.repository_id = $1
          AND rg.subject_type = 'team'
          AND tm.user_id = $2`,
      [repository.id, user.id],
    ),
  ]);
  if (repository.ownerUserId === user.id) {
    return "admin";
  }
  return effectiveRepositoryPermission({
    globalRole: user.globalRole,
    orgRole: membership,
    directGrants: direct.rows,
    teamGrants: teams.rows,
  });
}

export async function requireRepositoryAccess(
  db: QueryExecutor,
  user: SessionUser,
  organizationSlug: string,
  repositorySlug: string,
  required: RepoPermission,
): Promise<{ repository: RepositoryRecord; permission: RepoPermission }> {
  const repository = await findRepositoryBySlug(
    db,
    organizationSlug,
    repositorySlug,
  );
  if (!repository) {
    throw notFound("Repository not found");
  }
  const permission = await repositoryPermission(db, user, repository);
  if (!permission || !permissionSatisfies(permission, required)) {
    throw notFound("Repository not found");
  }
  return { repository, permission };
}

export async function canCreateRepository(
  db: QueryExecutor,
  user: SessionUser,
  organizationId: string | null,
): Promise<boolean> {
  if (user.globalRole === "admin") {
    return true;
  }
  if (!organizationId) {
    return false;
  }
  return (await organizationRole(db, user.id, organizationId)) !== null;
}

export async function createPendingRepository(
  db: Database,
  input: {
    organizationId: string | null;
    ownerUserId: string | null;
    organizationSlug: string;
    slug: string;
    description: string;
    defaultBranchName?: string;
    userId: string;
  },
): Promise<RepositoryRecord> {
  const id = newId();
  const defaultBranchId = newId();
  const loreName = `${input.organizationSlug}/${input.slug}`;
  const defaultBranchName = input.defaultBranchName ?? "main";
  try {
    await db.query(
      `INSERT INTO repositories
         (id, organization_id, owner_user_id, slug, lore_name, description,
          default_branch_id, default_branch_name, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [
        id,
        input.organizationId,
        input.ownerUserId,
        input.slug,
        loreName,
        input.description,
        defaultBranchId,
        defaultBranchName,
        input.userId,
      ],
    );
    await db.query(
      `INSERT INTO repository_grants
         (repository_id, subject_type, subject_id, permission)
       VALUES ($1, 'user', $2, 'admin')`,
      [id, input.userId],
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw conflict("A repository with that name already exists");
    }
    throw error;
  }
  const created = await findRepositoryById(db, id);
  if (!created) {
    throw new Error("Repository row disappeared after insert");
  }
  return created;
}

export async function registerRepositoryFromLore(
  db: Database,
  input: {
    repositoryId: string;
    name: string;
    user: SessionUser;
  },
): Promise<RepositoryRecord> {
  const existing = await findRepositoryById(db, input.repositoryId);
  if (existing) {
    assertRepositoryRegistration(existing, input.name, input.user, db);
    return existing;
  }

  const parsed = parseRepositoryName(input.name);
  const organization = await db.query<{ id: string }>(
    `SELECT id FROM organizations WHERE lower(slug) = lower($1) LIMIT 1`,
    [parsed.namespace],
  );
  const organizationId = organization.rows[0]?.id ?? null;
  const ownerUserId =
    organizationId ||
    input.user.username.toLowerCase() !== parsed.namespace.toLowerCase()
      ? null
      : input.user.id;

  if (organizationId) {
    if (!(await canCreateRepository(db, input.user, organizationId))) {
      throw forbidden(
        "You do not have permission to create repositories in this organization",
      );
    }
  } else if (!ownerUserId) {
    throw forbidden(
      "Repository namespace does not match your account or an organization you can use",
    );
  }

  try {
    await withTransaction(db, async (client) => {
      await client.query(
        `INSERT INTO repositories
           (id, organization_id, owner_user_id, slug, lore_name, description,
            default_branch_id, default_branch_name, created_by, status)
         VALUES ($1, $2, $3, $4, $5, '', $6, 'main', $7, 'pending')`,
        [
          input.repositoryId,
          organizationId,
          ownerUserId,
          parsed.slug,
          input.name,
          LORE_MAIN_BRANCH_ID,
          input.user.id,
        ],
      );
      await client.query(
        `INSERT INTO repository_grants
           (repository_id, subject_type, subject_id, permission)
         VALUES ($1, 'user', $2, 'admin')`,
        [input.repositoryId, input.user.id],
      );
      await audit(client, {
        actorUserId: input.user.id,
        action: "repository.registered",
        targetType: "repository",
        targetId: input.repositoryId,
        metadata: { name: input.name, source: "lore-client" },
      });
    });
  } catch (error) {
    if (!isUniqueConstraint(error)) {
      throw error;
    }
    const concurrentlyCreated = await findRepositoryById(db, input.repositoryId);
    if (concurrentlyCreated) {
      assertRepositoryRegistration(
        concurrentlyCreated,
        input.name,
        input.user,
        db,
      );
      return concurrentlyCreated;
    }
    throw conflict("A repository with that name already exists");
  }

  const created = await findRepositoryById(db, input.repositoryId);
  if (!created) {
    throw new Error("Registered repository could not be loaded");
  }
  return created;
}

function parseRepositoryName(name: string): {
  namespace: string;
  slug: string;
} {
  const segments = name.split("/");
  const slugPattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
  if (
    segments.length !== 2 ||
    !segments[0] ||
    !slugPattern.test(segments[0]) ||
    !segments[1] ||
    !slugPattern.test(segments[1])
  ) {
    throw badRequest(
      "Repository names must use namespace/repository with lowercase letters, digits, '.', '_' or '-'",
    );
  }
  return { namespace: segments[0], slug: segments[1] };
}

async function assertRepositoryRegistration(
  repository: RepositoryRecord,
  name: string,
  user: SessionUser,
  db: QueryExecutor,
): Promise<void> {
  if (repository.name !== name) {
    throw conflict("Repository name mismatch");
  }
  if (repository.status === "deleted" || repository.status === "failed") {
    throw conflict("Repository cannot be registered");
  }
  const canRegister = repository.ownerUserId
    ? repository.ownerUserId === user.id
    : await canCreateRepository(db, user, repository.organizationId);
  if (!canRegister) {
    throw forbidden("Create permission denied");
  }
}

export async function updateRepositoryDefaultBranch(
  db: QueryExecutor,
  repositoryId: string,
  branchId: string,
  branchName: string,
): Promise<void> {
  await db.query(
    `UPDATE repositories
        SET default_branch_id = $2,
            default_branch_name = $3,
            updated_at = $4
      WHERE id = $1`,
    [repositoryId, branchId, branchName, nowIso()],
  );
}

export async function markRepositoryStatus(
  db: QueryExecutor,
  repositoryId: string,
  status: RepositoryRecord["status"],
): Promise<void> {
  await db.query(
    `UPDATE repositories SET status = $2, updated_at = $3 WHERE id = $1`,
    [repositoryId, status, nowIso()],
  );
}

export async function listRepositoryGrants(
  db: QueryExecutor,
  repositoryId: string,
): Promise<
  Array<{
    subjectType: "user" | "team";
    subjectId: string;
    subjectName: string;
    permission: RepoPermission;
  }>
> {
  const result = await db.query<{
    subject_type: "user" | "team";
    subject_id: string;
    subject_name: string;
    permission: RepoPermission;
  }>(
    `SELECT rg.subject_type, rg.subject_id,
            CASE
              WHEN rg.subject_type = 'user' THEN coalesce(u.username, u.email)
              ELSE t.name
            END AS subject_name,
            rg.permission
       FROM repository_grants rg
       LEFT JOIN users u
         ON rg.subject_type = 'user' AND u.id = rg.subject_id
       LEFT JOIN teams t
         ON rg.subject_type = 'team' AND t.id = rg.subject_id
      WHERE rg.repository_id = $1
      ORDER BY rg.subject_type, subject_name`,
    [repositoryId],
  );
  return result.rows.map((row) => ({
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    permission: row.permission,
  }));
}

export async function upsertUserRepositoryGrant(
  db: QueryExecutor,
  input: {
    repositoryId: string;
    userId: string;
    permission: RepoPermission;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO repository_grants
       (repository_id, subject_type, subject_id, permission)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT (repository_id, subject_type, subject_id)
     DO UPDATE SET permission = EXCLUDED.permission`,
    [input.repositoryId, input.userId, input.permission],
  );
}

export async function upsertTeamRepositoryGrant(
  db: QueryExecutor,
  input: {
    repositoryId: string;
    teamId: string;
    permission: RepoPermission;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO repository_grants
       (repository_id, subject_type, subject_id, permission)
     VALUES ($1, 'team', $2, $3)
     ON CONFLICT (repository_id, subject_type, subject_id)
     DO UPDATE SET permission = EXCLUDED.permission`,
    [input.repositoryId, input.teamId, input.permission],
  );
}
