import type { BranchSummary, RepositoryRecord, RevisionSummary, TreeNodeSummary } from "@lore-portal/shared";

export interface LoreRepository {
  id: string;
  name: string;
  description: string;
  defaultBranchId: string;
  defaultBranchName: string;
  creator: string;
  created: number;
}

export interface RevisionDiff {
  files: Array<{
    path: string;
    action: "keep" | "add" | "delete" | "move" | "copy";
    type: "directory" | "file" | "link";
    pathFrom: string;
    addressFrom?: {
      hash: Buffer;
      context: Buffer;
    };
    addressTo?: {
      hash: Buffer;
      context: Buffer;
    };
    automerged: boolean;
  }>;
}

export interface TextDiff {
  binary: boolean;
  truncated: boolean;
  hasConflicts: boolean;
  linesAdded: number;
  linesDeleted: number;
  text: string;
}

export interface BlobResponse {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
}

export interface RepositorySnapshot {
  sizeBytes: number;
  latestRevision: string;
  lastCommitAt: number;
}

export interface LoreClient {
  createRepository(input: {
    id: string;
    defaultBranchId: string;
    name: string;
    description: string;
    defaultBranchName?: string;
    token: string;
  }): Promise<LoreRepository>;
  deleteRepository(repositoryId: string, token: string): Promise<void>;
  getRepositorySnapshot(
    repositoryId: string,
    branchId: string,
    token: string,
  ): Promise<RepositorySnapshot | null>;
  getRevisionSize(input: {
    repositoryId: string;
    revisionSignature: string;
    token: string;
  }): Promise<number>;
  listBranches(repositoryId: string, token: string): Promise<BranchSummary[]>;
  listRevisions(
    repositoryId: string,
    branchId: string,
    token: string,
  ): Promise<RevisionSummary[]>;
  listRevisionGraph(
    repositoryId: string,
    branchId: string,
    token: string,
  ): Promise<RevisionSummary[]>;
  getRevisionTree(input: {
    repositoryId: string;
    branchId: string;
    revisionNumber?: number;
    path?: string;
    maxDepth?: number;
    includeLastRevision?: boolean;
    token: string;
  }): Promise<TreeNodeSummary[]>;
  getRevisionDiff(input: {
    repositoryId: string;
    from: string;
    to: string;
    token: string;
  }): Promise<RevisionDiff>;
  getTextDiff(input: {
    repositoryId: string;
    from?: string;
    to: string;
    toAddress?: string;
    path: string;
    token: string;
  }): Promise<TextDiff>;
  getBlob(input: {
    repository: RepositoryRecord;
    address: string;
    token: string;
  }): Promise<BlobResponse>;
}
