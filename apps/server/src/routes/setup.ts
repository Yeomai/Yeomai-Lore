import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  badRequest,
  conflict,
  newId,
} from "@lore-portal/shared";
import { hashPassword } from "../auth/password.ts";
import { audit } from "../auth/audit.ts";
import { withTransaction } from "../db/index.ts";
import { parseInput } from "./helpers.ts";
import {
  applySiteSettings,
  isSetupRequired,
  loreCertificateRequired,
  normalizeUnifiedSiteAddress,
  readSetupDefaults,
  validateLoreCertificate,
  validateWebPublicUrl,
  writeLoreCertificate,
  writeLoreRuntimeConfig,
  normalizeLorePublicUrl,
  type SiteSettings,
} from "../setup.ts";
import {
  setSystemSetting,
  setUserRegistrationEnabled,
} from "../settings.ts";

const setupSchema = z
  .object({
    siteName: z.string().trim().min(1).max(80),
    publicAddress: z.string().trim().min(1).max(500).optional(),
    webPublicUrl: z.string().trim().min(1).max(500).optional(),
    lorePublicUrl: z.string().trim().min(1).max(500).optional(),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
    email: z.string().trim().toLowerCase().email().max(254),
    displayName: z.string().trim().max(80).optional(),
    password: z.string().min(6).max(256),
    confirmPassword: z.string().min(6).max(256),
    userRegistrationEnabled: z.boolean(),
    certificateChain: z.string().max(131_072).optional(),
    privateKey: z.string().max(131_072).optional(),
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  })
  .refine((input) => Boolean(input.publicAddress || input.webPublicUrl), {
    message: "A site address is required",
    path: ["publicAddress"],
  });

export const registerSetupRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, session } = app.services;

  app.get("/", async () => {
    const required = await isSetupRequired(db);
    const siteDefaults = required
      ? await readSetupDefaults(db, config)
      : null;
    return {
      required,
      defaults: required
        ? {
            ...siteDefaults,
            lorePublicUrl: "",
            userRegistrationEnabled: false,
            username: "admin",
            email: "admin@example.com",
            displayName: "Administrator",
          }
        : null,
    };
  });

  app.post(
    "/",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!(await isSetupRequired(db))) {
        throw conflict("Setup has already been completed");
      }
      const input = parseInput(setupSchema, request.body);
      const addresses = normalizeUnifiedSiteAddress(
        input.publicAddress ?? input.webPublicUrl ?? "",
      );
      validateWebPublicUrl(addresses.webPublicUrl);
      const lorePublicUrl = normalizeLorePublicUrl(addresses.lorePublicUrl);

      const certificateChain = input.certificateChain?.trim() ?? "";
      const privateKey = input.privateKey?.trim() ?? "";
      if (loreCertificateRequired(lorePublicUrl)) {
        if (!certificateChain || !privateKey) {
          throw badRequest(
            "A Lore TLS certificate and private key are required for this address",
          );
        }
      }
      if (certificateChain || privateKey) {
        await validateLoreCertificate({
          lorePublicUrl,
          certificateChain,
          privateKey,
        });
        await writeLoreCertificate(config, certificateChain, privateKey);
      }

      const settings: SiteSettings = {
        siteName: input.siteName,
        webPublicUrl: addresses.webPublicUrl,
        lorePublicUrl,
      };
      const previousWebPublicUrl = config.publicUrl;
      const previousLorePublicUrl = config.lorePublicUrl;
      await writeLoreRuntimeConfig(config, settings);
      const userId = newId();
      const passwordHash = await hashPassword(input.password);
      try {
        await withTransaction(db, async (client) => {
          const users = await client.query<{ count: number }>(
            "SELECT count(*) AS count FROM users",
          );
          if (Number(users.rows[0]?.count ?? 0) > 0) {
            throw conflict("Setup has already been completed");
          }
          await client.query(
            `INSERT INTO users
               (id, email, username, display_name, password_hash, global_role,
                status, email_verified_at)
             VALUES ($1, $2, $3, $4, $5, 'admin', 'active',
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
            [
              userId,
              input.email,
              input.username,
              input.displayName || input.username,
              passwordHash,
            ],
          );
          await setSystemSetting(client, "setup_completed", "true");
          await setSystemSetting(client, "site_name", settings.siteName);
          await setSystemSetting(
            client,
            "web_public_url",
            settings.webPublicUrl,
          );
          await setSystemSetting(
            client,
            "lore_public_url",
            settings.lorePublicUrl,
          );
          await setUserRegistrationEnabled(
            client,
            input.userRegistrationEnabled,
          );
        });
      } catch (error) {
        await applySiteSettings(db, config);
        throw error;
      }

      await applySiteSettings(db, config);
      const created = await session.create(userId);
      session.setCookie(reply, created.token, created.expiresAt);
      await audit(db, {
        actorUserId: userId,
        action: "system.setup_completed",
        targetType: "system",
        targetId: "setup",
        metadata: {
          webPublicUrl: settings.webPublicUrl,
          lorePublicUrl: settings.lorePublicUrl,
        },
        ip: request.ip,
      });
      reply.code(201);
      return {
        ok: true,
        restartRequired:
          settings.webPublicUrl !== previousWebPublicUrl ||
          settings.lorePublicUrl !== previousLorePublicUrl ||
          Boolean(certificateChain),
      };
    },
  );
};
