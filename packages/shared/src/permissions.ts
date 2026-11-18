import type {
  GlobalRole,
  LoreAction,
  OrgRole,
  RepoPermission,
} from "./types.ts";

export interface RepositoryGrant {
  permission: RepoPermission;
}

export interface RepositoryAccessInput {
  globalRole: GlobalRole;
  orgRole: OrgRole | null;
  directGrants: RepositoryGrant[];
  teamGrants: RepositoryGrant[];
}

const permissionRank: Record<RepoPermission, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

export function strongestPermission(
  grants: RepositoryGrant[],
): RepoPermission | null {
  let strongest: RepoPermission | null = null;
  for (const grant of grants) {
    if (!strongest || permissionRank[grant.permission] > permissionRank[strongest]) {
      strongest = grant.permission;
    }
  }
  return strongest;
}

export function effectiveRepositoryPermission(
  access: RepositoryAccessInput,
): RepoPermission | null {
  if (access.orgRole === "owner" || access.orgRole === "admin") {
    return "admin";
  }
  return strongestPermission([...access.directGrants, ...access.teamGrants]);
}

export function permissionSatisfies(
  actual: RepoPermission | null,
  required: RepoPermission,
): boolean {
  return actual !== null && permissionRank[actual] >= permissionRank[required];
}

export function loreActionsForPermission(
  permission: RepoPermission,
): LoreAction[] {
  switch (permission) {
    case "read":
      return ["read"];
    case "write":
      return ["read", "write"];
    case "admin":
      return [
        "read",
        "write",
        "owner",
        "admin",
        "migrate",
        "obliterate",
        "presign",
        "push-protected",
      ];
  }
}
