import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "@lore-portal/shared";
import { requireSessionUser } from "../auth/session.ts";
import { parseInput } from "./helpers.ts";

const createImportSchema = z.object({
  sourceValue: z.string().trim().min(1).max(4096),
  includeTags: z.boolean().default(false),
  credentials: z
    .object({
      type: z.literal("https-token"),
      token: z.string().min(1).max(8192),
    })
    .optional(),
  organizationId: z.string().uuid().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
  description: z.string().max(2000).default(""),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

export const registerImportRoutes: FastifyPluginAsync = async (app) => {
  if (!app.services.imports) {
    app.get("/", async () => ({ imports: [] }));
    app.post("/", async () => {
      throw badRequest("Repository imports are not enabled");
    });
    return;
  }
  const imports = app.services.imports;

  app.get("/", async (request) => {
    const user = await requireSessionUser(request);
    return { imports: await imports.list(user) };
  });

  app.post("/", async (request, reply) => {
    const user = await requireSessionUser(request);
    const input = parseInput(createImportSchema, request.body);
    const credentials =
      input.credentials?.type === "https-token"
        ? {
            type: "https-token" as const,
            token: input.credentials.token,
          }
        : undefined;
    const job = await imports.create(user, {
      sourceValue: input.sourceValue,
      includeTags: input.includeTags,
      slug: input.slug,
      description: input.description,
      ...(credentials ? { credentials } : {}),
      ...(input.organizationId
        ? { organizationId: input.organizationId }
        : {}),
    });
    return reply.code(202).send(job);
  });

  app.get("/:id", async (request) => {
    const user = await requireSessionUser(request);
    const { id } = parseInput(idParamsSchema, request.params);
    const job = await imports.getVisible(id, user);
    if (!job) throw notFound("Import job not found");
    return { job, warnings: await imports.warnings(id) };
  });

  app.post("/:id/cancel", async (request) => {
    const user = await requireSessionUser(request);
    const { id } = parseInput(idParamsSchema, request.params);
    return { job: await imports.cancel(id, user) };
  });

  app.delete("/:id", async (request) => {
    const user = await requireSessionUser(request);
    const { id } = parseInput(idParamsSchema, request.params);
    await imports.remove(id, user);
    return { ok: true };
  });

  app.get("/:id/report", async (request, reply) => {
    const user = await requireSessionUser(request);
    const { id } = parseInput(idParamsSchema, request.params);
    const report = await imports.report(id, user);
    reply.header(
      "content-disposition",
      `attachment; filename*=UTF-8''lore-import-${encodeURIComponent(id)}.json`,
    );
    reply.type("application/json");
    return report;
  });
};
