import {
  conflict,
  newId,
  type OrgRole,
  type SessionUser,
} from "@lore-portal/shared";
import type { Database, QueryExecutor } from "./db/index.ts";
import { isUniqueConstraint } from "./db/index.ts";

export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
  role: OrgRole | "global-admin";
  repositoryCount: number;
}

export async function listOrganizations(
  db: QueryExecutor,
  user: SessionUser,
): Promise<OrganizationSummary[]> {
  if (user.globalRole === "admin") {
    const result = await db.query<{
      id: string;
      slug: string;
      name: string;
      repository_count: number;
    }>(
      `SELECT o.id, o.slug, o.name, count(r.id) AS repository_count
         FROM organizations o
         LEFT JOIN repositories r
           ON r.organization_id = o.id AND r.status <> 'deleted'
        GROUP BY o.id, o.slug, o.name
        ORDER BY o.slug`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      repositoryCount: Number(row.repository_count),
      role: "global-admin",
    }));
  }
  const result = await db.query<{
    id: string;
    slug: string;
    name: string;
    role: OrgRole;
    repository_count: number;
  }>(
    `SELECT o.id, o.slug, o.name, om.role,
            count(r.id) AS repository_count
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       LEFT JOIN repositories r
         ON r.organization_id = o.id AND r.status <> 'deleted'
      WHERE om.user_id = $1
      GROUP BY o.id, o.slug, o.name, om.role
      ORDER BY o.slug`,
    [user.id],
  );
  return result.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    repositoryCount: Number(row.repository_count),
  }));
}

export async function createOrganization(
  db: Database,
  input: { slug: string; name: string; actor: SessionUser },
): Promise<OrganizationSummary> {
  const id = newId();
  try {
    await db.query(
      `INSERT INTO organizations (id, slug, name, created_by)
       VALUES ($1, $2, $3, $4)`,
      [id, input.slug, input.name, input.actor.id],
    );
    await db.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [id, input.actor.id],
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw conflict("An organization with that slug already exists");
    }
    throw error;
  }
  return {
    id,
    slug: input.slug,
    name: input.name,
    role: "owner",
    repositoryCount: 0,
  };
}

export async function addOrganizationMember(
  db: QueryExecutor,
  input: {
    organizationId: string;
    userId: string;
    role: OrgRole;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, user_id)
     DO UPDATE SET role = EXCLUDED.role`,
    [input.organizationId, input.userId, input.role],
  );
}

export async function createTeam(
  db: QueryExecutor,
  input: {
    organizationId: string;
    slug: string;
    name: string;
  },
): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO teams (id, organization_id, slug, name)
     VALUES ($1, $2, $3, $4)`,
    [id, input.organizationId, input.slug, input.name],
  );
  return id;
}

export async function addTeamMember(
  db: QueryExecutor,
  teamId: string,
  userId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO team_members (team_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [teamId, userId],
  );
}

export async function deleteEmptyOrganization(
  db: Database,
  organizationId: string,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const repositories = await client.query<{ count: number }>(
      `SELECT count(*) AS count
         FROM repositories
        WHERE organization_id = $1`,
      [organizationId],
    );
    if (Number(repositories.rows[0]?.count) > 0) {
      throw conflict(
        "Organization repositories must be deleted before deleting the organization",
      );
    }
    await client.query(
      `DELETE FROM invites WHERE organization_id = $1`,
      [organizationId],
    );
    const deleted = await client.query(
      `DELETE FROM organizations WHERE id = $1`,
      [organizationId],
    );
    if (deleted.rowCount !== 1) {
      throw new Error("Organization disappeared before it could be deleted");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function leaveOrganization(
  db: Database,
  input: { organizationId: string; userId: string },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM team_members
        WHERE user_id = $2
          AND team_id IN (
            SELECT id FROM teams WHERE organization_id = $1
          )`,
      [input.organizationId, input.userId],
    );
    const removed = await client.query(
      `DELETE FROM organization_members
        WHERE organization_id = $1 AND user_id = $2`,
      [input.organizationId, input.userId],
    );
    if (removed.rowCount !== 1) {
      throw conflict("You are not a member of this organization");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function transferOrganizationOwnership(
  db: Database,
  input: {
    organizationId: string;
    targetUserId: string;
  },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query(
      `SELECT 1 FROM organization_members
        WHERE organization_id = $1 AND user_id = $2`,
      [input.organizationId, input.targetUserId],
    );
    if (target.rowCount !== 1) {
      throw conflict("The new owner must be an organization member");
    }
    await client.query(
      `UPDATE organization_members
          SET role = 'admin'
        WHERE organization_id = $1 AND role = 'owner'`,
      [input.organizationId],
    );
    await client.query(
      `UPDATE organization_members
          SET role = 'owner'
        WHERE organization_id = $1 AND user_id = $2`,
      [input.organizationId, input.targetUserId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
