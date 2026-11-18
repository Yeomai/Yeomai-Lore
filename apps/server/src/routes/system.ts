import type { FastifyPluginAsync } from "fastify";
import { AppError } from "@lore-portal/shared";
import { requireAdmin } from "../auth/session.ts";

export const registerSystemRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/restart-lore",
    {
      config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
    },
    async (request) => {
      await requireAdmin(request);
      if (!app.services.restartLore) {
        throw new AppError(
          "lore_unavailable",
          503,
          "Lore restart is unavailable",
        );
      }
      await app.services.restartLore();
      return {
        ok: true,
        restartedAt: new Date().toISOString(),
      };
    },
  );
};
