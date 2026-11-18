import type { SessionUser } from "@lore-portal/shared";
import type { AppDependencies } from "../app.ts";

declare module "fastify" {
  interface FastifyInstance {
    services: AppDependencies;
  }

  interface FastifyRequest {
    sessionUser: SessionUser | undefined;
    sessionToken: string | undefined;
  }
}

export {};
