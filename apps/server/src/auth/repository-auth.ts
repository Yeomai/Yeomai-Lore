import type { SessionUser, RepositoryRecord } from "@lore-portal/shared";
import { forbidden, loreActionsForPermission, resourceForRepository } from "@lore-portal/shared";
import type { Database } from "../db/index.ts";
import { repositoryPermission } from "../repositories.ts";
import type { TokenService } from "./token-service.ts";

export async function issueRepositoryToken(
  db: Database,
  tokens: TokenService,
  user: SessionUser,
  repository: RepositoryRecord,
): Promise<string> {
  const permission = await repositoryPermission(db, user, repository);
  if (!permission) {
    throw forbidden("You do not have access to this repository");
  }
  return tokens.signRepositoryToken({
    user,
    repositoryId: repository.id,
    resource: resourceForRepository(repository.id),
    actions: loreActionsForPermission(permission),
  });
}
