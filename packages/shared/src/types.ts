export type GlobalRole = "admin" | "user";
export type OrgRole = "owner" | "admin" | "member";
export type RepoPermission = "read" | "write" | "admin";
export type LoreAction =
  | "read"
  | "write"
  | "owner"
  | "admin"
  | "migrate"
  | "obliterate"
  | "presign"
  | "push-protected";

export interface SessionUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  globalRole: GlobalRole;
}

export interface RepositoryRecord {
  id: string;
  organizationId: string | null;
  ownerUserId: string | null;
  organizationSlug: string;
  organizationName: string;
  slug: string;
  name: string;
  description: string;
  defaultBranchId: string;
  defaultBranchName: string;
  createdBy: string;
  status: "pending" | "active" | "failed" | "deleted";
  createdAt: string;
}

export interface BranchSummary {
  id: string;
  name: string;
  creator: string;
  latest: string;
  deleted: boolean;
  parentBranchId: string | null;
  parentRevision: string | null;
}

export interface RevisionSummary {
  signature: string;
  branchId: string;
  number: number;
  parents: string[];
  message: string;
  createdBy: string;
  committedBy: string;
  timestamp: number;
}

export interface TreeNodeSummary {
  path: string;
  type: "directory" | "file" | "link";
  size: number;
  address?: string;
  executable: boolean;
  updatedAt?: number;
  updatedMessage?: string;
  updatedRevision?: string;
}

export type RepositoryImportStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RepositoryImportPhase =
  | "validating"
  | "mirroring"
  | "scanning"
  | "importing_commits"
  | "creating_refs"
  | "importing_tags"
  | "finalizing"
  | "cleaning_up";

export interface RepositoryImportWarning {
  id: number;
  kind: string;
  objectId: string;
  path: string;
  message: string;
}

export type RepositoryImportSourceKind = "path" | "https" | "ssh";

export interface RepositoryTag {
  name: string;
  revision: string;
  branchName: string;
  annotated: boolean;
  tagger: string;
  message: string;
}
