import type { RepositoryRecord } from "@lore-portal/shared";

export function repositoryLabel(
  repository: Pick<
    RepositoryRecord,
    "ownerUserId" | "organizationSlug" | "slug"
  >,
  currentUserId: string,
): string {
  return repository.ownerUserId === currentUserId
    ? repository.slug
    : `${repository.organizationSlug}/${repository.slug}`;
}
