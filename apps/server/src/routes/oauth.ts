import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { badRequest } from "@lore-portal/shared";
import { parseInput } from "./helpers.ts";

const deviceAuthorizationSchema = z.object({
  client_id: z.string().min(1),
  scope: z.string().optional(),
});

function formObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Expected an OAuth form body");
  }
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      output[key] = raw;
    } else if (Array.isArray(raw) && typeof raw[0] === "string") {
      output[key] = raw[0];
    }
  }
  return output;
}

export const registerOAuthRoutes: FastifyPluginAsync = async (app) => {
  const { oauth, tokens, config } = app.services;

  app.get("/.well-known/openid-configuration", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return tokens.discoveryDocument();
  });

  app.get("/.well-known/jwks.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return tokens.jwks();
  });

  app.post(
    "/oauth/device_authorization",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const input = parseInput(deviceAuthorizationSchema, formObject(request.body));
      const result = await oauth.startDevice({
        clientId: input.client_id,
        userAgent:
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : "",
        ip: request.ip,
      });
      reply.header("cache-control", "no-store");
      return result;
    },
  );

  app.post(
    "/oauth/token",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = formObject(request.body);
      const clientId = body.client_id || config.oidcClientId;
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
      switch (body.grant_type) {
        case "urn:ietf:params:oauth:grant-type:device_code":
          if (!body.device_code) {
            throw badRequest("device_code is required");
          }
          return oauth.pollDevice(body.device_code, clientId);
        case "refresh_token":
          if (!body.refresh_token) {
            throw badRequest("refresh_token is required");
          }
          return oauth.refresh(body.refresh_token, clientId);
        case "urn:ietf:params:oauth:grant-type:token-exchange":
          if (!body.subject_token || !body.subject_token_type) {
            throw badRequest("subject_token and subject_token_type are required");
          }
          return oauth.exchange({
            subjectToken: body.subject_token,
            subjectTokenType: body.subject_token_type,
            ...(body.resource ? { resource: body.resource } : {}),
            clientId,
          });
        default:
          throw badRequest("Unsupported grant_type");
      }
    },
  );

  app.post("/oauth/revoke", async (request, reply) => {
    const body = formObject(request.body);
    if (body.token) {
      await oauth.revoke(body.token);
    }
    reply.header("cache-control", "no-store");
    return reply.code(200).send();
  });

  app.get("/oauth/userinfo", async (request) => {
    const user = await oauth.verifyBearerUser(request.headers.authorization);
    return {
      sub: user.id,
      name: user.displayName,
      preferred_username: user.username,
      email: user.email,
      email_verified: true,
    };
  });
};
