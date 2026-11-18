import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  badRequest,
  conflict,
  forbidden,
  newId,
  notFound,
  unauthorized,
} from "@lore-portal/shared";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import {
  findAuthenticatedUser,
  findUserById,
  findUserByUsername,
  searchUserDirectory,
} from "../auth/users.ts";
import { hashToken, randomToken } from "../auth/random.ts";
import { audit } from "../auth/audit.ts";
import { requireSessionUser } from "../auth/session.ts";
import { parseInput } from "./helpers.ts";
import {
  isoAfterSeconds,
  isUniqueConstraint,
  nowIso,
  toIsoString,
} from "../db/index.ts";
import { isUserRegistrationEnabled } from "../settings.ts";
import {
  listOAuthIdentities,
  revokeOAuthIdentity,
  revokeAllOAuthIdentities,
} from "../auth/oauth-identities.ts";
import { isSetupRequired } from "../setup.ts";

const passwordSchema = z.string().min(6).max(256);
const changePasswordSchema = z
  .object({
    oldPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
    confirmNewPassword: passwordSchema,
  })
  .refine((input) => input.newPassword === input.confirmNewPassword, {
    message: "New passwords do not match",
    path: ["confirmNewPassword"],
  });
const deleteAccountSchema = z.object({
  confirmation: z.literal("DELETE"),
});

const loginSchema = z
  .object({
    identifier: z.string().trim().min(1).max(254).optional(),
    email: z.string().trim().min(1).max(254).optional(),
    password: z.string().min(1).max(256),
  })
  .refine((input) => input.identifier || input.email);

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
  displayName: z.string().trim().min(1).max(80).optional(),
  password: passwordSchema,
});

const acceptInviteSchema = z.object({
  token: z.string().min(20),
  username: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/)
    .optional(),
  displayName: z.string().min(1).max(80),
  password: passwordSchema,
});
const inviteQuerySchema = z.object({
  token: z.string().min(20),
});

const resetRequestSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});
const apiTokenSchema = z.object({ name: z.string().min(1).max(80) });
const deviceSchema = z.object({ userCode: z.string().min(4).max(32) });

export const registerAuthRoutes: FastifyPluginAsync = async (app) => {
  const { db, session, oauth, mailer, config } = app.services;

  app.post(
    "/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const input = parseInput(loginSchema, request.body);
      const identifier = input.identifier ?? input.email ?? "";
      const authenticated = await findAuthenticatedUser(db, identifier);
      const valid =
        authenticated &&
        (await verifyPassword(authenticated.passwordHash, input.password));
      if (!authenticated || !valid) {
        await audit(db, {
          action: "auth.login_failed",
          targetType: "user",
          targetId: identifier.toLowerCase(),
          ip: request.ip,
        });
        throw unauthorized("Invalid email, username, or password");
      }
      const created = await session.create(authenticated.user.id);
      session.setCookie(reply, created.token, created.expiresAt);
      await audit(db, {
        actorUserId: authenticated.user.id,
        action: "auth.login",
        targetType: "user",
        targetId: authenticated.user.id,
        ip: request.ip,
      });
      return { user: authenticated.user };
    },
  );

  app.post(
    "/register",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      if (await isSetupRequired(db)) {
        throw conflict("Setup must be completed first");
      }
      if (!(await isUserRegistrationEnabled(db))) {
        throw forbidden("User registration is disabled");
      }
      const input = parseInput(registerSchema, request.body);
      if (await findUserByUsername(db, input.username)) {
        throw conflict("That username is already in use");
      }
      if (await findAuthenticatedUser(db, input.email)) {
        throw conflict("An account already exists for this email");
      }

      const userId = newId();
      const passwordHash = await hashPassword(input.password);
      try {
        await db.query(
          `INSERT INTO users
             (id, email, username, display_name, password_hash,
              global_role, status, email_verified_at)
           VALUES ($1, $2, $3, $4, $5, 'user', 'active', NULL)`,
          [
            userId,
            input.email,
            input.username,
            input.displayName ?? input.username,
            passwordHash,
          ],
        );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw conflict("Username or email is already in use");
        }
        throw error;
      }

      const user = await findUserById(db, userId);
      if (!user) {
        throw new Error("Created user could not be loaded");
      }
      const created = await session.create(user.id);
      session.setCookie(reply, created.token, created.expiresAt);
      await audit(db, {
        actorUserId: user.id,
        action: "auth.registered",
        targetType: "user",
        targetId: user.id,
        ip: request.ip,
      });
      reply.code(201);
      return { user };
    },
  );

  app.get("/session", async (request) => ({
    user: request.sessionUser ?? null,
  }));

  app.post("/logout", async (request, reply) => {
    await session.revoke(request.sessionToken);
    session.clearCookie(reply);
    return { ok: true };
  });

  app.put("/password", async (request, reply) => {
    const user = await requireSessionUser(request);
    const input = parseInput(changePasswordSchema, request.body);
    const existing = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [user.id],
    );
    const passwordHash = existing.rows[0]?.password_hash;
    if (!passwordHash) {
      throw notFound("User not found");
    }
    if (!(await verifyPassword(passwordHash, input.oldPassword))) {
      throw badRequest("Current password is incorrect");
    }
    if (input.oldPassword === input.newPassword) {
      throw badRequest("New password must be different from the current password");
    }
    const nextHash = await hashPassword(input.newPassword);
    await db.query(
      `UPDATE users
          SET password_hash = $2, updated_at = $3
        WHERE id = $1`,
      [user.id, nextHash, nowIso()],
    );
    await db.query(
      `UPDATE sessions SET revoked_at = $2
        WHERE user_id = $1
          AND revoked_at IS NULL`,
      [user.id, nowIso()],
    );
    session.clearCookie(reply);
    await audit(db, {
      actorUserId: user.id,
      action: "auth.password_changed",
      targetType: "user",
      targetId: user.id,
      ip: request.ip,
    });
    return { ok: true, requireLogin: true };
  });

  app.delete("/account", async (request, reply) => {
    const user = await requireSessionUser(request);
    if (user.globalRole === "admin") {
      throw forbidden("Administrator accounts cannot be deleted here");
    }
    parseInput(deleteAccountSchema, request.body);

    const client = await db.connect();
    try {
      await client.query("BEGIN IMMEDIATE");
      const repositories = await client.query<{ count: number }>(
        `SELECT count(*) AS count
           FROM repositories
          WHERE owner_user_id = $1 OR created_by = $1`,
        [user.id],
      );
      if (Number(repositories.rows[0]?.count) > 0) {
        throw conflict(
          "Delete or transfer all repositories owned or created by this account before deleting it",
        );
      }
      const organizations = await client.query<{ count: number }>(
        `SELECT count(*) AS count
           FROM organizations
          WHERE created_by = $1`,
        [user.id],
      );
      if (Number(organizations.rows[0]?.count) > 0) {
        throw conflict(
          "Transfer or delete organizations created by this account before deleting it",
        );
      }
      await client.query(
        `DELETE FROM repository_grants
          WHERE subject_type = 'user' AND subject_id = $1`,
        [user.id],
      );
      await client.query(
        `DELETE FROM invites WHERE invited_by = $1`,
        [user.id],
      );
      await client.query(
        `UPDATE audit_events SET actor_user_id = NULL WHERE actor_user_id = $1`,
        [user.id],
      );
      await client.query(`DELETE FROM users WHERE id = $1`, [user.id]);
      await audit(client, {
        actorUserId: null,
        action: "auth.account_deleted",
        targetType: "user",
        targetId: user.id,
        metadata: { username: user.username, email: user.email },
        ip: request.ip,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    session.clearCookie(reply);
    return { ok: true, requireLogin: true };
  });

  app.post("/accept-invite", async (request, reply) => {
    const input = parseInput(acceptInviteSchema, request.body);
    const tokenHash = hashToken(input.token);
    const inviteResult = await db.query<{
      id: string;
      email: string;
      organization_id: string | null;
      organization_role: "owner" | "admin" | "member";
    }>(
      `SELECT id, email, organization_id, organization_role
         FROM invites
        WHERE token_hash = $1
          AND accepted_at IS NULL
          AND expires_at > $2`,
      [tokenHash, nowIso()],
    );
    const invite = inviteResult.rows[0];
    if (!invite) {
      throw notFound("Invite is invalid or expired");
    }
    const username = input.username ?? usernameFromEmail(invite.email);
    if (await findUserByUsername(db, username)) {
      throw conflict("That username is already in use");
    }
    const existing = await findAuthenticatedUser(db, invite.email);
    if (existing) {
      throw conflict("An account already exists for this email");
    }
    const userId = newId();
    const passwordHash = await hashPassword(input.password);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO users
           (id, email, username, display_name, password_hash,
            global_role, status, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, 'user', 'active', $6)`,
        [
          userId,
          invite.email,
          username,
          input.displayName,
          passwordHash,
          nowIso(),
        ],
      );
      await client.query(
        `UPDATE invites SET accepted_at = $2 WHERE id = $1`,
        [invite.id, nowIso()],
      );
      if (invite.organization_id) {
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role)
           VALUES ($1, $2, $3)`,
          [invite.organization_id, userId, invite.organization_role],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueConstraint(error)) {
        throw conflict("Username or email is already in use");
      }
      throw error;
    } finally {
      client.release();
    }
    const user = await findUserById(db, userId);
    if (!user) {
      throw new Error("Created user could not be loaded");
    }
    const created = await session.create(user.id);
    session.setCookie(reply, created.token, created.expiresAt);
    await audit(db, {
      actorUserId: user.id,
      action: "auth.invite_accepted",
      targetType: "user",
      targetId: user.id,
      ip: request.ip,
    });
    return { user };
  });

  app.get("/invite", async (request) => {
    const input = parseInput(inviteQuerySchema, request.query);
    const tokenHash = hashToken(input.token);
    await db.query(
      `DELETE FROM invites
        WHERE accepted_at IS NULL AND expires_at <= $1`,
      [nowIso()],
    );
    const result = await db.query<{ id: string }>(
      `SELECT id
         FROM invites
        WHERE token_hash = $1
          AND accepted_at IS NULL
          AND expires_at > $2`,
      [tokenHash, nowIso()],
    );
    if (!result.rows[0]) {
      throw notFound("Invite is invalid or expired");
    }
    return { valid: true };
  });

  app.post(
    "/password-reset/request",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request) => {
      const input = parseInput(resetRequestSchema, request.body);
      const authenticated = await findAuthenticatedUser(db, input.email);
      if (authenticated) {
        const token = randomToken(40);
        await db.query(
          `INSERT INTO password_resets (id, user_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [
            newId(),
            authenticated.user.id,
            hashToken(token),
            isoAfterSeconds(30 * 60),
          ],
        );
        const url = `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
        await mailer.send(
          authenticated.user.email,
          "Reset your Yeomai Lore password",
          {
            text: `Open this one-time link to reset your password:\n\n${url}`,
          },
        );
      }
      return {
        ok: true,
        message: "If that account exists, a reset link has been sent.",
      };
    },
  );

  app.post("/password-reset/complete", async (request) => {
    const input = parseInput(resetSchema, request.body);
    const client = await db.connect();
    let reset: { id: string; user_id: string };
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id
           FROM password_resets
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
        [hashToken(input.token), nowIso()],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        throw notFound("Password reset link is invalid or expired");
      }
      reset = row;
      const passwordHash = await hashPassword(input.password);
      await client.query(
        `UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1`,
        [reset.user_id, passwordHash, nowIso()],
      );
      await client.query(
        `UPDATE password_resets SET used_at = $2 WHERE id = $1`,
        [reset.id, nowIso()],
      );
      await client.query(
        `UPDATE sessions SET revoked_at = $2
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [reset.user_id, nowIso()],
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back for a missing token.
      }
      throw error;
    } finally {
      client.release();
    }
    await audit(db, {
      actorUserId: reset.user_id,
      action: "auth.password_reset",
      targetType: "user",
      targetId: reset.user_id,
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get("/api-tokens", async (request) => {
    const user = await requireSessionUser(request);
    const result = await db.query<{
      id: string;
      name: string;
      prefix: string;
      created_at: string;
      last_used_at: string | null;
      expires_at: string | null;
    }>(
      `SELECT id, name, prefix, created_at, last_used_at, expires_at
         FROM api_tokens
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [user.id],
    );
    return {
      tokens: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        createdAt: toIsoString(row.created_at),
        lastUsedAt: row.last_used_at ? toIsoString(row.last_used_at) : null,
        expiresAt: row.expires_at ? toIsoString(row.expires_at) : null,
      })),
    };
  });

  app.post("/api-tokens", async (request) => {
    const user = await requireSessionUser(request);
    const input = parseInput(apiTokenSchema, request.body);
    const created = await oauth.createApiToken(user, input.name);
    await audit(db, {
      actorUserId: user.id,
      action: "auth.api_token_created",
      targetType: "api_token",
      targetId: created.id,
      ip: request.ip,
    });
    return { token: created.token, id: created.id, prefix: created.prefix };
  });

  app.delete("/api-tokens/:id", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(z.object({ id: z.string().uuid() }), request.params);
    const result = await db.query(
      `UPDATE api_tokens SET revoked_at = $3
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [params.id, user.id, nowIso()],
    );
    if (result.rowCount !== 1) {
      throw notFound("API token not found");
    }
    await audit(db, {
      actorUserId: user.id,
      action: "auth.api_token_revoked",
      targetType: "api_token",
      targetId: params.id,
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get("/device/status", async (request) => {
    const query = parseInput(
      z.object({ user_code: z.string().min(4).max(32) }),
      request.query,
    );
    const device = await oauth.deviceForUserCode(query.user_code);
    if (!device) {
      throw notFound("Device code not found");
    }
    return {
      status: device.status,
      clientId: device.clientId,
    };
  });

  app.post("/device/approve", async (request) => {
    const user = await requireSessionUser(request);
    const input = parseInput(deviceSchema, request.body);
    await oauth.approveDevice(input.userCode, user);
    return { ok: true };
  });

  app.post("/device/deny", async (request) => {
    const user = await requireSessionUser(request);
    const input = parseInput(deviceSchema, request.body);
    await oauth.denyDevice(input.userCode, user);
    return { ok: true };
  });

  app.get("/oauth-identities", async (request) => {
    const user = await requireSessionUser(request);
    return {
      identities: await listOAuthIdentities(
        db,
        user.id,
        config.accessTokenTtlSeconds,
      ),
    };
  });

  app.delete("/oauth-identities/:sessionId", async (request) => {
    const user = await requireSessionUser(request);
    const params = parseInput(
      z.object({
        sessionId: z.string().regex(
          /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/i,
        ),
      }),
      request.params,
    );
    const revokedCount = await revokeOAuthIdentity(db, {
      sessionId: params.sessionId.toLowerCase(),
      userId: user.id,
    });
    if (revokedCount === 0) {
      throw notFound("OAuth authentication not found");
    }
    await audit(db, {
      actorUserId: user.id,
      action: "auth.oauth_identity_revoked",
      targetType: "oauth_identity",
      targetId: params.sessionId,
      metadata: { revokedCount },
      ip: request.ip,
    });
    return { ok: true, revokedCount };
  });

  app.delete("/oauth-identities", async (request) => {
    const user = await requireSessionUser(request);
    const revoked = await revokeAllOAuthIdentities(db, user.id);
    await audit(db, {
      actorUserId: user.id,
      action: "auth.oauth_identity_revoked",
      targetType: "oauth_identity",
      targetId: user.id,
      metadata: revoked,
      ip: request.ip,
    });
    return { ok: true, ...revoked };
  });

  app.get(
    "/users/search",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const user = await requireSessionUser(request);
      const query = parseInput(
        z.object({
          q: z.string().trim().min(2).max(80),
        }),
        request.query,
      );
      return {
        users: await searchUserDirectory(db, {
          query: query.q,
          excludeUserId: user.id,
        }),
      };
    },
  );

};

function usernameFromEmail(email: string): string {
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, "-") ?? "";
  const username = local.slice(0, 28);
  if (username.length < 3) {
    throw badRequest("Could not derive a username");
  }
  return username;
}
