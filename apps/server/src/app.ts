import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import { AppError, unauthorized } from "@lore-portal/shared";
import type { AppConfig } from "./config.ts";
import type { Database } from "./db/index.ts";
import type { LoreClient } from "./lore/types.ts";
import type {
  InitializeEmptyRepositoryInput,
  InitializeIgnoreTemplateInput,
} from "./lore/template-initializer.ts";
import type { SmtpSettings } from "./mail-settings.ts";
import { SessionService, SESSION_COOKIE } from "./auth/session.ts";
import type { TokenService } from "./auth/token-service.ts";
import { OAuthService, OAuthProtocolError } from "./auth/oauth-service.ts";
import type { Mailer } from "./auth/mailer.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerOAuthRoutes } from "./routes/oauth.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerOrganizationRoutes } from "./routes/organizations.ts";
import { registerRepositoryRoutes } from "./routes/repositories.ts";
import { registerMetadataRoutes } from "./routes/metadata.ts";
import { registerImportRoutes } from "./routes/imports.ts";
import { registerSetupRoutes } from "./routes/setup.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import type { RepositoryImportService } from "./imports/service.ts";
import "./types/fastify.d.ts";

export interface AppDependencies {
  config: AppConfig;
  db: Database;
  lore: LoreClient;
  session: SessionService;
  tokens: TokenService;
  oauth: OAuthService;
  mailer: Mailer;
  templateInitializer?: (input: InitializeIgnoreTemplateInput) => Promise<void>;
  emptyRepositoryInitializer?: (
    input: InitializeEmptyRepositoryInput,
  ) => Promise<void>;
  smtpVerifier?: (
    settings: SmtpSettings,
    recipientEmail: string,
  ) => Promise<void>;
  serviceReadiness?: () => Promise<boolean>;
  restartLore?: () => Promise<void>;
  imports?: RepositoryImportService;
  logger?: boolean;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const logger =
    deps.logger !== undefined
      ? deps.logger
      : deps.config.nodeEnv === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true },
            },
          }
        : true;
  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(rateLimit, {
    max: 5000,
    timeWindow: "1 minute",
  });

  app.decorateRequest("sessionUser");
  app.decorateRequest("sessionToken");
  app.decorate("services", deps);

  app.addHook("onRequest", async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.sessionToken = token;
    request.sessionUser = (await deps.session.resolve(token)) ?? undefined;

    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const origin = request.headers.origin;
    const allowedOrigins = new Set([
      deps.config.publicUrl,
      deps.config.apiInternalUrl,
    ]);
    if (
      unsafe &&
      origin &&
      token &&
      !allowedOrigins.has(origin) &&
      !isSameOrigin(request, origin)
    ) {
      throw unauthorized("Cross-site request rejected");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof OAuthProtocolError) {
      return reply.code(error.status).send({
        error: error.error,
        error_description: error.description,
      });
    }
    if (request.url.startsWith("/oauth/")) {
      const oauthError =
        error instanceof AppError
          ? {
              error:
                error.status === 401
                  ? "invalid_token"
                  : error.status === 403
                    ? "access_denied"
                    : "invalid_request",
              error_description: error.message,
            }
          : {
              error: "server_error",
              error_description: "OAuth request failed",
            };
      return reply
        .code(error instanceof AppError ? error.status : 500)
        .send(oauthError);
    }
    if (error instanceof AppError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: "Too many requests" },
      });
    }
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({
      error: { code: "internal", message: "Internal server error" },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({
      error: { code: "not_found", message: "Route not found" },
    });
  });

  app.get("/health_check", async () => ({ status: "ok" }));

  await app.register(registerMetadataRoutes, { prefix: "" });
  await app.register(registerSetupRoutes, { prefix: "/api/v1/setup" });
  await app.register(registerOAuthRoutes, { prefix: "" });
  await app.register(registerAuthRoutes, { prefix: "/api/v1/auth" });
  await app.register(registerAdminRoutes, { prefix: "/api/v1/admin" });
  await app.register(registerSystemRoutes, {
    prefix: "/api/v1/system",
  });
  await app.register(registerImportRoutes, {
    prefix: "/api/v1/repository-imports",
  });
  await app.register(registerOrganizationRoutes, { prefix: "/api/v1/orgs" });
  await app.register(registerRepositoryRoutes, { prefix: "/api/v1/repos" });

  return app as FastifyInstance;
}

function isSameOrigin(request: FastifyRequest, origin: string): boolean {
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost ?? request.headers.host;
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
