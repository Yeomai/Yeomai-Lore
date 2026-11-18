import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  badRequest,
  conflict,
  forbidden,
  newId,
  notFound,
} from "@lore-portal/shared";
import {
  requireAdmin,
  requireSessionUser,
} from "../auth/session.ts";
import { hashToken, randomToken } from "../auth/random.ts";
import {
  decryptInviteToken,
  encryptInviteToken,
} from "../auth/invite-links.ts";
import { audit } from "../auth/audit.ts";
import { parseInput } from "./helpers.ts";
import {
  isoAfterSeconds,
  isUniqueConstraint,
  nowIso,
  toIsoString,
} from "../db/index.ts";
import {
  isUserInvitationsEnabled,
  isUserRegistrationEnabled,
  setUserInvitationsEnabled,
  setUserRegistrationEnabled,
} from "../settings.ts";
import {
  loreCertificateRequired,
  readLoreCertificateStatus,
  readSiteSettings,
  validateLoreCertificate,
  writeLoreCertificate,
} from "../setup.ts";
import {
  applySmtpSettings,
  hasSmtpPassword,
  readSmtpPassword,
  readSmtpSettings,
  saveSmtpSettings,
  sendSmtpTestEmail,
  smtpSettingsSchema,
  type SmtpSettings,
} from "../mail-settings.ts";

const inviteSchema = z.object({
  email: z.string().email(),
  organizationId: z
    .union([z.string().uuid(), z.literal(""), z.null()])
    .optional(),
  organizationRole: z.enum(["owner", "admin", "member"]).default("member"),
});
const inviteParamsSchema = z.object({
  inviteId: z.string().uuid(),
});
const systemSettingsSchema = z.object({
  userRegistrationEnabled: z.boolean(),
  userInvitationsEnabled: z.boolean(),
});
const certificateSchema = z.object({
  certificateChain: z.string().trim().min(1).max(131_072),
  privateKey: z.string().trim().min(1).max(131_072),
});

export const registerAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, mailer } = app.services;
  const cleanupExpiredInvites = async () => {
    await db.query(
      `DELETE FROM invites
        WHERE accepted_at IS NULL AND expires_at <= $1`,
      [nowIso()],
    );
  };
  const requireInvitationAccess = async (
    request: Parameters<typeof requireSessionUser>[0],
  ) => {
    const user = await requireSessionUser(request);
    if (
      user.globalRole !== "admin" &&
      !(await isUserInvitationsEnabled(db))
    ) {
      throw forbidden("User invitations are disabled");
    }
    return user;
  };

  app.get("/settings", async (request) => {
    await requireAdmin(request);
    return {
      userRegistrationEnabled: await isUserRegistrationEnabled(db),
      userInvitationsEnabled: await isUserInvitationsEnabled(db),
    };
  });

  app.get("/system-info", async (request) => {
    await requireAdmin(request);
    const settings = await readSiteSettings(db, config);
    return {
      webPublicUrl: settings.webPublicUrl,
      lorePublicUrl: settings.lorePublicUrl,
      loreReady: await (app.services.serviceReadiness?.() ?? true),
    };
  });

  app.get("/certificate", async (request) => {
    await requireAdmin(request);
    const settings = await readSiteSettings(db, config);
    const required = loreCertificateRequired(settings.lorePublicUrl);
    return {
      lorePublicUrl: settings.lorePublicUrl,
      required,
      certificate: required
        ? await readLoreCertificateStatus(config)
        : null,
    };
  });

  app.put(
    "/certificate",
    {
      config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
    },
    async (request) => {
      const admin = await requireAdmin(request);
      const settings = await readSiteSettings(db, config);
      if (!loreCertificateRequired(settings.lorePublicUrl)) {
        throw badRequest(
          "Certificate management is not available for this Lore address",
        );
      }
      const input = parseInput(certificateSchema, request.body);
      await validateLoreCertificate({
        lorePublicUrl: settings.lorePublicUrl,
        certificateChain: input.certificateChain,
        privateKey: input.privateKey,
      });
      await writeLoreCertificate(
        config,
        input.certificateChain,
        input.privateKey,
      );
      await audit(db, {
        actorUserId: admin.id,
        action: "admin.certificate_updated",
        targetType: "lore_certificate",
        targetId: settings.lorePublicUrl,
        metadata: {},
        ip: request.ip,
      });
      return {
        ok: true,
        certificate: await readLoreCertificateStatus(config),
      };
    },
  );

  app.get("/smtp", async (request) => {
    await requireAdmin(request);
    return {
      settings: await readSmtpSettings(db),
      hasPassword: await hasSmtpPassword(db),
    };
  });

  app.put("/smtp", async (request) => {
    const admin = await requireAdmin(request);
    const settings = parseInput(smtpSettingsSchema, request.body);
    if (
      settings.enabled &&
      settings.username &&
      !settings.password &&
      !(await hasSmtpPassword(db))
    ) {
      throw badRequest("SMTP password is required");
    }
    await saveSmtpSettings(db, config, settings, true);
    await applySmtpSettings(db, config);
    await audit(db, {
      actorUserId: admin.id,
      action: "admin.smtp_settings_updated",
      targetType: "system_settings",
      targetId: "smtp",
      metadata: {
        enabled: settings.enabled,
        host: settings.enabled ? settings.host : "",
        port: settings.enabled ? settings.port : 587,
        security: settings.enabled ? settings.security : "ssl",
      },
      ip: request.ip,
    });
    return {
      settings: await readSmtpSettings(db),
      hasPassword: await hasSmtpPassword(db),
    };
  });

  app.post(
    "/smtp/test",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request) => {
      const admin = await requireAdmin(request);
      const input = parseInput(
        smtpSettingsSchema.extend({
          recipientEmail: z.string().trim().email().max(254),
        }),
        request.body,
      );
      const { recipientEmail, ...settings } = input;
      if (!settings.enabled) {
        throw badRequest("SMTP is not enabled");
      }
      const password =
        settings.password || (await readSmtpPassword(db, config));
      if (settings.username && !password) {
        throw badRequest("SMTP password is required");
      }
      const testedSettings: SmtpSettings = { ...settings, password };
      try {
        await (app.services.smtpVerifier ?? sendSmtpTestEmail)(
          testedSettings,
          recipientEmail,
        );
      } catch (error) {
        request.log.warn({ err: error, actorUserId: admin.id }, "SMTP test email failed");
        throw badRequest("SMTP test email failed");
      }
      await audit(db, {
        actorUserId: admin.id,
        action: "admin.smtp_test_sent",
        targetType: "email",
        targetId: recipientEmail.toLowerCase(),
        metadata: { host: settings.host },
        ip: request.ip,
      });
      return { ok: true };
    },
  );

  app.put("/settings", async (request) => {
    const admin = await requireAdmin(request);
    const input = parseInput(systemSettingsSchema, request.body);
    await setUserRegistrationEnabled(db, input.userRegistrationEnabled);
    await setUserInvitationsEnabled(db, input.userInvitationsEnabled);
    await audit(db, {
      actorUserId: admin.id,
      action: "system.settings_updated",
      targetType: "system_settings",
      targetId: "user_registration_enabled",
      metadata: {
        userRegistrationEnabled: input.userRegistrationEnabled,
        userInvitationsEnabled: input.userInvitationsEnabled,
      },
      ip: request.ip,
    });
    return input;
  });

  app.get("/users", async (request) => {
    await requireAdmin(request);
    const result = await db.query<{
      id: string;
      email: string;
      username: string;
      display_name: string;
      global_role: string;
      created_at: string;
    }>(
      `SELECT id, email, username, display_name, global_role, created_at
         FROM users ORDER BY created_at`,
    );
    return {
      users: result.rows.map((row) => ({
        id: row.id,
        email: row.email,
        username: row.username,
        displayName: row.display_name,
        globalRole: row.global_role,
        createdAt: toIsoString(row.created_at),
      })),
    };
  });

  app.get("/invites", async (request) => {
    const user = await requireInvitationAccess(request);
    const adminScope = user.globalRole === "admin" ? null : user.id;
    await cleanupExpiredInvites();
    const result = await db.query<{
      id: string;
      email: string;
      organization_id: string | null;
      organization_name: string | null;
      organization_role: string;
      expires_at: string;
      created_at: string;
      token_ciphertext: string | null;
    }>(
      `SELECT i.id, i.email, i.organization_id, o.name AS organization_name,
              i.organization_role, i.expires_at, i.created_at,
              i.token_ciphertext
         FROM invites i
         LEFT JOIN organizations o ON o.id = i.organization_id
        WHERE i.accepted_at IS NULL AND i.expires_at > $1
          AND ($2 IS NULL OR i.invited_by = $2)
        ORDER BY i.created_at DESC`,
      [nowIso(), adminScope],
    );
    return {
      invites: await Promise.all(
        result.rows.map(async (row) => {
          const token = await decryptInviteToken(
            config,
            row.token_ciphertext,
          );
          return {
            id: row.id,
            email: row.email,
            organizationId: row.organization_id,
            organizationName: row.organization_name,
            organizationRole: row.organization_role,
            expiresAt: toIsoString(row.expires_at),
            createdAt: toIsoString(row.created_at),
            inviteUrl: token
              ? `${config.publicUrl}/accept-invite?token=${encodeURIComponent(token)}`
              : null,
          };
        }),
      ),
    };
  });

  app.post("/invites", async (request) => {
    const actor = await requireInvitationAccess(request);
    const input = parseInput(inviteSchema, request.body);
    const organizationId = input.organizationId || null;
    if (actor.globalRole !== "admin" && organizationId) {
      throw forbidden("Only administrators can invite users into an organization");
    }
    await cleanupExpiredInvites();
    const token = randomToken(40);
    const tokenCiphertext = await encryptInviteToken(config, token);
    try {
      await db.query(
        `INSERT INTO invites
           (id, email, token_hash, token_ciphertext, organization_id,
            organization_role, invited_by, expires_at)
         VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8)`,
        [
          newId(),
          input.email,
          hashToken(token),
          tokenCiphertext,
          organizationId,
          input.organizationRole,
          actor.id,
          isoAfterSeconds(config.inviteTtlSeconds),
        ],
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw conflict("An invitation for that email is already pending");
      }
      throw error;
    }
    const inviteUrl = `${config.publicUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    const escapedInviteUrl = inviteUrl
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;");
    let emailSent = false;
    if (config.smtpUrl) {
      try {
        await mailer.send(
          input.email,
          "Lore邀请",
          {
            html: `<p>您好，欢迎加入。点击以下链接可接受邀请：</p><p><a href="${escapedInviteUrl}">${escapedInviteUrl}</a></p>`,
          },
        );
        emailSent = true;
      } catch (error) {
        request.log.warn(
          { err: error, inviteEmail: input.email },
          "Invitation email failed",
        );
      }
    }
    await audit(db, {
      actorUserId: actor.id,
      action: "admin.invite_created",
      targetType: "email",
      targetId: input.email.toLowerCase(),
      metadata: {
        organizationId,
        role: input.organizationRole,
        emailSent,
      },
      ip: request.ip,
    });
    return {
      inviteUrl,
      expiresIn: config.inviteTtlSeconds,
      emailSent,
    };
  });

  app.delete("/invites/:inviteId", async (request) => {
    const actor = await requireInvitationAccess(request);
    const adminScope = actor.globalRole === "admin" ? null : actor.id;
    const { inviteId } = parseInput(inviteParamsSchema, request.params);
    const removed = await db.query<{
      email: string;
      organization_id: string | null;
    }>(
      `DELETE FROM invites
        WHERE id = $1 AND accepted_at IS NULL
          AND ($2 IS NULL OR invited_by = $2)
        RETURNING email, organization_id`,
      [inviteId, adminScope],
    );
    const invite = removed.rows[0];
    if (!invite) {
      throw notFound("Invitation not found");
    }
    await audit(db, {
      actorUserId: actor.id,
      action: "admin.invite_revoked",
      targetType: "email",
      targetId: invite.email,
      metadata: {
        invitationId: inviteId,
        organizationId: invite.organization_id,
      },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get("/audit", async (request) => {
    await requireAdmin(request);
    const query = parseInput(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
    );
    const result = await db.query<{
      id: string;
      action: string;
      target_type: string;
      target_id: string;
      metadata: string;
      created_at: string;
      actor_user_id: string | null;
      actor_username: string | null;
    }>(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.metadata,
              a.created_at, a.actor_user_id, u.username AS actor_username
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.created_at DESC
        LIMIT $1 OFFSET $2`,
      [query.limit, query.offset],
    );
    return {
      events: result.rows.map((row) => ({
        id: row.id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        createdAt: toIsoString(row.created_at),
        actorUserId: row.actor_user_id,
        actorUsername: row.actor_username,
      })),
    };
  });
};
