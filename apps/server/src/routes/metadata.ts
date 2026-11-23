import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.ts";
import {
  isUserInvitationsEnabled,
  isUserRegistrationEnabled,
} from "../settings.ts";
import { readSiteSettings } from "../setup.ts";

const execFileAsync = promisify(execFile);
let loreVersionPromise: Promise<string> | undefined;

export const registerMetadataRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/openapi.json", async () => openApiDocument(app.services.config));
  app.get("/api/v1/ready", async (_request, reply) => {
    const ready = await (app.services.serviceReadiness?.() ??
      Promise.resolve(true));
    if (!ready) {
      return reply.code(503).send({ ready: false });
    }
    return { ready: true };
  });
  app.get("/api/v1/meta", async () => {
    const settings = await readSiteSettings(
      app.services.db,
      app.services.config,
    );
    return {
      productName: settings.siteName,
      siteName: settings.siteName,
      webPublicUrl: settings.webPublicUrl,
      loreRemoteUrl: settings.lorePublicUrl,
      loreVersion: await readLoreVersion(app.services.config.loreCliPath),
      portalVersion: app.services.config.portalVersion,
      apiVersion: "v1",
      userRegistrationEnabled: await isUserRegistrationEnabled(app.services.db),
      userInvitationsEnabled: await isUserInvitationsEnabled(app.services.db),
    };
  });
};

function readLoreVersion(cliPath: string): Promise<string> {
  loreVersionPromise ??= execFileAsync(cliPath, ["--version"], {
    timeout: 5_000,
  })
    .then(({ stdout, stderr }) => {
      const output = `${stdout}\n${stderr}`;
      const match = /\blore\s+(\S+)/i.exec(output);
      return match?.[1] ?? fallbackLoreVersion();
    })
    .catch(() => fallbackLoreVersion());
  return loreVersionPromise;
}

function fallbackLoreVersion(): string {
  return process.env.LORE_VERSION ?? "0.14.0";
}

function openApiDocument(config: AppConfig): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Yeomai Lore API",
      version: config.portalVersion,
      description:
        "Prototype control-plane API for a self-hosted Lore server. This is not a Gitea-compatible API.",
    },
    servers: [{ url: config.publicUrl }],
    paths: {
      "/api/v1/ready": {
        get: { summary: "Read API and Lore service readiness" },
      },
      "/api/v1/setup": {
        get: { summary: "Read first-run setup status and defaults" },
        post: { summary: "Complete first-run setup" },
      },
      "/api/v1/auth/session": {
        get: { summary: "Read the current browser session" },
      },
      "/api/v1/auth/login": {
        post: { summary: "Create a browser session" },
      },
      "/api/v1/repos": {
        get: { summary: "List repositories visible to the caller" },
        post: { summary: "Create a Lore repository" },
      },
      "/api/v1/system/restart-lore": {
        post: { summary: "Restart the Lore data-plane service" },
      },
      "/api/v1/admin/settings": {
        get: { summary: "Read system settings" },
        put: { summary: "Update system settings" },
      },
      "/api/v1/admin/system-info": {
        get: { summary: "Read Web and Lore service information" },
      },
      "/api/v1/admin/smtp": {
        get: { summary: "Read SMTP email settings" },
        put: { summary: "Update SMTP email settings" },
      },
      "/api/v1/admin/smtp/test": {
        post: { summary: "Send an SMTP test email" },
      },
      "/api/v1/admin/certificate": {
        get: { summary: "Read the configured Lore certificate" },
        put: { summary: "Upload a replacement Lore certificate" },
      },
      "/api/v1/repository-imports": {
        get: { summary: "List visible Git import jobs" },
        post: { summary: "Queue a Git import job for the current user" },
      },
      "/api/v1/repository-imports/{id}": {
        get: { summary: "Read Git import progress and warnings" },
        delete: { summary: "Remove a completed import record and its logs" },
      },
      "/api/v1/repository-imports/{id}/cancel": {
        post: { summary: "Cancel a Git import job" },
      },
      "/api/v1/repository-imports/{id}/report": {
        get: { summary: "Download a Git import report" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}": {
        get: { summary: "Read repository metadata and effective permission" },
        delete: { summary: "Permanently delete a repository" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}/branches": {
        get: { summary: "List Lore branches" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}/tags": {
        get: { summary: "List imported Git tags" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}/file-index": {
        get: { summary: "List searchable file paths for a branch revision" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}/revisions": {
        get: { summary: "List branch revisions" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}/tree": {
        get: { summary: "List revision tree children" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}/blob": {
        get: { summary: "Download a file from a branch or revision" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}/diff": {
        get: { summary: "Compare two revisions" },
      },
      "/api/v1/repos/{organizationSlug}/{repositorySlug}/text-diff": {
        get: { summary: "Return a text diff for one changed path" },
      },
      "/oauth/token": {
        post: {
          summary:
            "OAuth token endpoint for device, refresh, API-key, and RFC 8693 exchanges",
        },
      },
      "/.well-known/openid-configuration": {
        get: { summary: "OIDC discovery document" },
      },
    },
    components: {
      securitySchemes: {
        browserSession: {
          type: "apiKey",
          in: "cookie",
          name: "lore_portal_session",
        },
      },
    },
  };
}
