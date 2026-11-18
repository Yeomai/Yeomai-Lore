import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { conflict, forbidden, notFound } from "@lore-portal/shared";
import { requireSessionUser } from "../auth/session.ts";
import { findAuthenticatedUser } from "../auth/users.ts";
import {
  addOrganizationMember,
  addTeamMember,
  createOrganization,
  createTeam,
  deleteEmptyOrganization,
  leaveOrganization,
  listOrganizations,
  transferOrganizationOwnership,
} from "../organizations.ts";
import { organizationRole } from "../repositories.ts";
import { parseInput } from "./helpers.ts";
import { audit } from "../auth/audit.ts";

const organizationSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(80),
});
const memberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});
const teamSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(80),
});
const teamMemberSchema = z.object({ email: z.string().email() });
const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});
const deleteOrganizationSchema = z.object({
  confirmation: z.string().min(1).max(80),
});
const transferOwnershipSchema = z.object({
  userId: z.string().uuid(),
});

export const registerOrganizationRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.services;

  app.get("/", async (request) => {
    const user = await requireSessionUser(request);
    return { organizations: await listOrganizations(db, user) };
  });

  app.post("/", async (request) => {
    const actor = await requireSessionUser(request);
    if (actor.globalRole !== "admin") {
      throw forbidden("Only a global administrator can create organizations");
    }
    const input = parseInput(organizationSchema, request.body);
    const organization = await createOrganization(db, { ...input, actor });
    await audit(db, {
      actorUserId: actor.id,
      action: "organization.created",
      targetType: "organization",
      targetId: organization.id,
      ip: request.ip,
    });
    return organization;
  });

  app.delete("/:organizationId", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(organizationParamsSchema, request.params);
    const input = parseInput(deleteOrganizationSchema, request.body);
    await assertOrganizationAdmin(db, actor, params.organizationId);
    const organization = await db.query<{ slug: string }>(
      `SELECT slug FROM organizations WHERE id = $1`,
      [params.organizationId],
    );
    const slug = organization.rows[0]?.slug;
    if (!slug) {
      throw notFound("Organization not found");
    }
    if (input.confirmation !== slug) {
      throw conflict("Organization confirmation does not match");
    }
    await deleteEmptyOrganization(db, params.organizationId);
    await audit(db, {
      actorUserId: actor.id,
      action: "organization.deleted",
      targetType: "organization",
      targetId: params.organizationId,
      metadata: { slug },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.delete("/:organizationId/members/me", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(organizationParamsSchema, request.params);
    if (actor.globalRole === "admin") {
      throw forbidden("Organization administrators cannot leave the organization");
    }
    const role = await organizationRole(db, actor.id, params.organizationId);
    if (!role) {
      throw notFound("Organization membership not found");
    }
    if (role === "owner" || role === "admin") {
      throw forbidden("Organization administrators cannot leave the organization");
    }
    await leaveOrganization(db, {
      organizationId: params.organizationId,
      userId: actor.id,
    });
    await audit(db, {
      actorUserId: actor.id,
      action: "organization.member_left",
      targetType: "organization",
      targetId: params.organizationId,
      ip: request.ip,
    });
    return { ok: true };
  });

  app.post("/:organizationId/owner", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(organizationParamsSchema, request.params);
    const input = parseInput(transferOwnershipSchema, request.body);
    const role = await organizationRole(db, actor.id, params.organizationId);
    if (
      actor.globalRole !== "admin" &&
      role !== "owner"
    ) {
      throw forbidden(
        "Only the portal organization owner can transfer the portal role",
      );
    }
    if (input.userId === actor.id) {
      throw conflict("The new owner must be a different organization member");
    }
    await transferOrganizationOwnership(db, {
      organizationId: params.organizationId,
      targetUserId: input.userId,
    });
    await audit(db, {
      actorUserId: actor.id,
      action: "organization.owner_transferred",
      targetType: "organization",
      targetId: params.organizationId,
      metadata: { targetUserId: input.userId },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get("/:organizationId/members", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(
      z.object({ organizationId: z.string().uuid() }),
      request.params,
    );
    await assertOrganizationAdmin(db, actor, params.organizationId);
    const result = await db.query<{
      user_id: string;
      username: string;
      email: string;
      display_name: string;
      role: string;
    }>(
      `SELECT u.id AS user_id, u.username, u.email, u.display_name, om.role
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = $1
        ORDER BY om.role, u.username`,
      [params.organizationId],
    );
    return {
      members: result.rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
      })),
    };
  });

  app.post("/:organizationId/members", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(
      z.object({ organizationId: z.string().uuid() }),
      request.params,
    );
    await assertOrganizationAdmin(db, actor, params.organizationId);
    const input = parseInput(memberSchema, request.body);
    const target = await findAuthenticatedUser(db, input.email);
    if (!target) {
      throw conflict("That user must accept an invitation first");
    }
    await addOrganizationMember(db, {
      organizationId: params.organizationId,
      userId: target.user.id,
      role: input.role,
    });
    return { ok: true };
  });

  app.post("/:organizationId/teams", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(
      z.object({ organizationId: z.string().uuid() }),
      request.params,
    );
    await assertOrganizationAdmin(db, actor, params.organizationId);
    const input = parseInput(teamSchema, request.body);
    const id = await createTeam(db, {
      organizationId: params.organizationId,
      ...input,
    });
    return { id };
  });

  app.post("/:organizationId/teams/:teamId/members", async (request) => {
    const actor = await requireSessionUser(request);
    const params = parseInput(
      z.object({
        organizationId: z.string().uuid(),
        teamId: z.string().uuid(),
      }),
      request.params,
    );
    await assertOrganizationAdmin(db, actor, params.organizationId);
    const team = await db.query(
      `SELECT 1 FROM teams WHERE id = $1 AND organization_id = $2`,
      [params.teamId, params.organizationId],
    );
    if (team.rowCount !== 1) {
      throw conflict("Team does not belong to this organization");
    }
    const input = parseInput(teamMemberSchema, request.body);
    const target = await findAuthenticatedUser(db, input.email);
    if (!target) {
      throw conflict("That user must accept an invitation first");
    }
    await addOrganizationMember(db, {
      organizationId: params.organizationId,
      userId: target.user.id,
      role: "member",
    });
    await addTeamMember(db, params.teamId, target.user.id);
    return { ok: true };
  });
};

async function assertOrganizationAdmin(
  db: Parameters<typeof organizationRole>[0],
  actor: Awaited<ReturnType<typeof requireSessionUser>>,
  organizationId: string,
): Promise<void> {
  if (actor.globalRole === "admin") {
    return;
  }
  const role = await organizationRole(db, actor.id, organizationId);
  if (role !== "owner" && role !== "admin") {
    throw forbidden("Organization administrator access is required");
  }
}
