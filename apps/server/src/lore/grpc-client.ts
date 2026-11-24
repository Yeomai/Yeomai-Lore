import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createTwoFilesPatch } from "diff";
import {
  AppError,
  bytesToUuid,
  contextBytesToString,
  contextToBytes,
  notFound,
  uuidToBytes,
  type BranchSummary,
  type RepositoryRecord,
  type RevisionSummary,
  type TreeNodeSummary,
} from "@lore-portal/shared";
import type { AppConfig } from "../config.ts";
import type {
  BlobResponse,
  LoreClient,
  RepositorySnapshot,
  LoreRepository,
  RevisionDiff,
  TextDiff,
} from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const protoRoot =
  [path.resolve(here, "proto"), path.resolve(here, "../../proto")].find(
    existsSync,
  ) ?? path.resolve(here, "proto");

const packageDefinition = protoLoader.loadSync(
  [
    "lore/repository/v1/repository.proto",
    "lore/revision/v1/revision.proto",
    "lore/thin_client/v1/thin_client.proto",
    "lore/user/v1/user.proto",
    "lore/auth/v1/auth_api.proto",
  ],
  {
    includeDirs: [protoRoot],
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  },
);

export const loreProto = grpc.loadPackageDefinition(packageDefinition) as any;

type DynamicClient = {
  [key: string]: (...args: any[]) => any;
};

function unary<T>(
  client: DynamicClient,
  method: string,
  request: unknown,
  metadata: grpc.Metadata,
): Promise<T> {
  return new Promise((resolve, reject) => {
    client[method]!(request, metadata, (error: grpc.ServiceError | null, value: T) => {
      if (error) {
        reject(mapGrpcError(error));
      } else {
        resolve(value);
      }
    });
  });
}

function mapGrpcError(error: grpc.ServiceError): Error {
  switch (error.code) {
    case grpc.status.NOT_FOUND:
      return notFound(error.details || "Lore object not found");
    case grpc.status.PERMISSION_DENIED:
    case grpc.status.UNAUTHENTICATED:
      return new AppError("forbidden", 403, "Lore denied this request");
    case grpc.status.UNAVAILABLE:
    case grpc.status.DEADLINE_EXCEEDED:
      return new AppError(
        "lore_unavailable",
        503,
        "Lore is temporarily unavailable",
      );
    default:
      return new AppError(
        "internal",
        502,
        `Lore request failed: ${error.details || error.message}`,
      );
  }
}

function metadataFor(token: string, repositoryId?: string): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${token}`);
  if (repositoryId) {
    metadata.set("urc-repository-id-bin", uuidToBytes(repositoryId));
  }
  return metadata;
}

function bytesHex(value: Uint8Array | Buffer | string | undefined): string {
  if (!value) {
    return "";
  }
  return Buffer.isBuffer(value)
    ? value.toString("hex")
    : Buffer.from(value).toString("hex");
}

function addressString(
  address: { hash?: Uint8Array; context?: Uint8Array } | undefined,
): string | undefined {
  if (!address?.hash) {
    return undefined;
  }
  const hash = bytesHex(address.hash);
  const context = bytesHex(address.context) || "0".repeat(32);
  return `${hash}-${context}`;
}

function parseAddress(
  value: string | undefined,
): { hash: Uint8Array; context: Uint8Array } | undefined {
  if (!value) {
    return undefined;
  }
  const [hash, context] = value.split("-");
  if (!hash || !context) {
    return undefined;
  }
  return {
    hash: Buffer.from(hash, "hex"),
    context: Buffer.from(context, "hex"),
  };
}

function nodeType(value: string | number): TreeNodeSummary["type"] {
  if (value === "FILE" || value === 1) {
    return "file";
  }
  if (value === "LINK" || value === 2) {
    return "link";
  }
  return "directory";
}

function actionType(value: string | number): RevisionDiff["files"][number]["action"] {
  if (value === "ADD" || value === 1) {
    return "add";
  }
  if (value === "DELETE" || value === 2) {
    return "delete";
  }
  if (value === "MOVE" || value === 3) {
    return "move";
  }
  if (value === "COPY" || value === 4) {
    return "copy";
  }
  return "keep";
}

function revisionSummary(revision: any): RevisionSummary {
  return {
    signature: bytesHex(revision.signature),
    branchId: contextBytesToString(revision.identifier.branchId),
    number: Number(revision.number),
    parents: [
      bytesHex(revision.parentSelf?.signature),
      bytesHex(revision.parentOther?.signature),
    ].filter(Boolean),
    message: revision.commitMessage,
    createdBy: revision.createdBy,
    committedBy: revision.committedBy,
    timestamp: Number(revision.timestamp),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await map(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export class GrpcLoreClient implements LoreClient {
  private readonly repository: DynamicClient;
  private readonly revision: DynamicClient;
  private readonly thinClient: DynamicClient;

  constructor(private readonly config: AppConfig) {
    const credentials = config.loreTls
      ? grpc.credentials.createSsl(
          config.loreCaFile ? readFileSync(config.loreCaFile) : undefined,
        )
      : grpc.credentials.createInsecure();
    const options = {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
    };
    this.repository = new loreProto.lore.repository.v1.RepositoryService(
      config.loreGrpcUrl,
      credentials,
      options,
    );
    this.revision = new loreProto.lore.revision.v1.RevisionService(
      config.loreGrpcUrl,
      credentials,
      options,
    );
    this.thinClient = new loreProto.lore.thin_client.v1.ThinClientService(
      config.loreGrpcUrl,
      credentials,
      options,
    );
  }

  async createRepository(input: {
    id: string;
    defaultBranchId: string;
    name: string;
    description: string;
    defaultBranchName?: string;
    token: string;
  }): Promise<LoreRepository> {
    const response = await unary<any>(
      this.repository,
      "repositoryCreate",
      {
        id: uuidToBytes(input.id),
        name: input.name,
        description: input.description,
        defaultBranchId: contextToBytes(input.defaultBranchId),
        defaultBranchName: input.defaultBranchName ?? "main",
      },
      metadataFor(input.token),
    );
    const repository = response.repository;
    return {
      id: bytesToUuid(repository.id),
      name: repository.name,
      description: repository.description,
      defaultBranchId: contextBytesToString(repository.defaultBranchId),
      defaultBranchName: repository.defaultBranchName,
      creator: repository.creator,
      created: Number(repository.created),
    };
  }

  async deleteRepository(repositoryId: string, token: string): Promise<void> {
    await unary<any>(
      this.repository,
      "repositoryDelete",
      { id: uuidToBytes(repositoryId) },
      metadataFor(token, repositoryId),
    );
  }

  async getRepositorySnapshot(
    repositoryId: string,
    branchId: string,
    token: string,
  ): Promise<RepositorySnapshot | null> {
    const metadata = metadataFor(token, repositoryId);
    let latestRevision = "";
    let sizeBytes = 0;
    try {
      const stream = this.thinClient.revisionTree!(
        {
          identifier: {
            branchId: contextToBytes(branchId),
            number: 0,
          },
          maxDepth: 1,
          includeLastRevision: false,
        },
        metadata,
      );
      for await (const value of stream as AsyncIterable<any>) {
        latestRevision ||= bytesHex(value.header?.signature);
        if (value.node) {
          sizeBytes += Number(value.node.size);
        }
      }
    } catch (error) {
      if (
        (error as grpc.ServiceError).code === grpc.status.NOT_FOUND ||
        (error instanceof AppError && error.code === "not_found")
      ) {
        return null;
      }
      throw error;
    }
    if (!latestRevision) {
      return null;
    }
    const info = await unary<any>(
      this.thinClient,
      "revisionInfo",
      { signature: Buffer.from(latestRevision, "hex") },
      metadata,
    );
    if (!info.revision) {
      return null;
    }
    return {
      sizeBytes,
      latestRevision,
      lastCommitAt: Number(info.revision.timestamp),
    };
  }

  async getRevisionSize(input: {
    repositoryId: string;
    revisionSignature: string;
    token: string;
  }): Promise<number> {
    if (!/^[0-9a-f]{64}$/i.test(input.revisionSignature)) {
      throw new AppError(
        "bad_request",
        400,
        "Invalid revision signature",
      );
    }
    const stream = this.thinClient.revisionTree!(
      {
        signature: Buffer.from(input.revisionSignature, "hex"),
        maxDepth: 1,
        includeLastRevision: false,
      },
      metadataFor(input.token, input.repositoryId),
    );
    let sizeBytes = 0;
    let found = false;
    for await (const value of stream as AsyncIterable<any>) {
      if (value.header) found = true;
      if (value.node) sizeBytes += Number(value.node.size);
    }
    if (!found) {
      throw notFound("Revision not found");
    }
    return sizeBytes;
  }

  async listBranches(
    repositoryId: string,
    token: string,
  ): Promise<BranchSummary[]> {
    const stream = this.revision.branchList!(
      { includeDeleted: false },
      metadataFor(token, repositoryId),
    );
    const branches: BranchSummary[] = [];
    for await (const value of stream as AsyncIterable<any>) {
      const branch = value.branch;
      if (!branch) {
        continue;
      }
      const parent = branch.stack?.[0];
      branches.push({
        id: contextBytesToString(branch.id),
        name: branch.name,
        creator: branch.creator,
        latest: bytesHex(branch.latest),
        deleted: false,
        parentBranchId: parent?.branchId
          ? contextBytesToString(parent.branchId)
          : null,
        parentRevision: bytesHex(parent?.revisionSignature) || null,
      });
    }
    return branches;
  }

  async listRevisions(
    repositoryId: string,
    branchId: string,
    token: string,
  ): Promise<RevisionSummary[]> {
    const metadata = metadataFor(token, repositoryId);
    const items = new Map<string, any>();
    const seenCursors = new Set<string>();
    let signature: Uint8Array | undefined;
    for (let page = 0; page < 1_000; page++) {
      const response = await unary<any>(
        this.revision,
        "revisionList",
        signature
          ? { signature }
          : {
              identifier: {
                branchId: contextToBytes(branchId),
                number: 0,
              },
            },
        metadata,
      );
      for (const item of (response.items ?? []) as any[]) {
        items.set(bytesHex(item.signature), item);
      }
      const next = response.signatureBackward as Uint8Array | undefined;
      if (!next?.length) break;
      const nextKey = bytesHex(next);
      if (seenCursors.has(nextKey)) break;
      seenCursors.add(nextKey);
      signature = next;
    }
    const ordered = [...items.values()].sort(
      (left, right) => Number(right.number) - Number(left.number),
    );
    const revisions = await mapWithConcurrency(
      ordered,
      12,
      async (item) => {
        try {
          return await this.getRevision(item.signature, metadata);
        } catch (error) {
          if (error instanceof AppError && error.code === "not_found") {
            return null;
          }
          throw error;
        }
      },
    );
    return revisions.filter(
      (revision): revision is RevisionSummary => revision !== null,
    );
  }

  async listRevisionGraph(
    repositoryId: string,
    branchId: string,
    token: string,
  ): Promise<RevisionSummary[]> {
    const metadata = metadataFor(token, repositoryId);
    const revisions = await this.listRevisions(repositoryId, branchId, token);
    const bySignature = new Map(
      revisions.map((revision) => [revision.signature, revision]),
    );
    let pending = [
      ...new Set(
        revisions.flatMap((revision) =>
          revision.parents.filter((parent) => !bySignature.has(parent)),
        ),
      ),
    ];
    while (pending.length > 0) {
      const loaded = await mapWithConcurrency(
        pending,
        8,
        (parent) => this.getRevision(Buffer.from(parent, "hex"), metadata),
      );
      for (const revision of loaded) {
        if (revision) bySignature.set(revision.signature, revision);
      }
      pending = [
        ...new Set(
          loaded.flatMap((revision) =>
            revision
              ? revision.parents.filter((parent) => !bySignature.has(parent))
              : [],
          ),
        ),
      ];
    }
    return [...bySignature.values()].sort(
      (left, right) => right.timestamp - left.timestamp,
    );
  }

  private async getRevision(
    signature: Uint8Array,
    metadata: grpc.Metadata,
  ): Promise<RevisionSummary | null> {
    try {
      const info = await unary<any>(
        this.thinClient,
        "revisionInfo",
        { signature },
        metadata,
      );
      return info.revision ? revisionSummary(info.revision) : null;
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        return null;
      }
      throw error;
    }
  }

  async getRevisionTree(input: {
    repositoryId: string;
    branchId: string;
    revisionNumber?: number;
    path?: string;
    maxDepth?: number;
    includeLastRevision?: boolean;
    token: string;
  }): Promise<TreeNodeSummary[]> {
    const stream = this.thinClient.revisionTree!(
      {
        identifier: {
          branchId: contextToBytes(input.branchId),
          number: input.revisionNumber ?? 0,
        },
        pathPrefix: input.path ?? "",
        maxDepth: input.maxDepth ?? 1,
        includeLastRevision: input.includeLastRevision ?? true,
      },
      metadataFor(input.token, input.repositoryId),
    );
    const nodes: TreeNodeSummary[] = [];
    const revisionTimestamps = new Map<number, number>();
    const revisionMessages = new Map<number, string>();
    const revisionSignatures = new Map<number, string>();
    for await (const value of stream as AsyncIterable<any>) {
      if (value.revision?.revision) {
        revisionTimestamps.set(
          Number(value.revision.index),
          Number(value.revision.revision.timestamp),
        );
        revisionMessages.set(
          Number(value.revision.index),
          value.revision.revision.commitMessage,
        );
        revisionSignatures.set(
          Number(value.revision.index),
          bytesHex(value.revision.revision.signature),
        );
      }
      if (!value.node) {
        continue;
      }
      const node = value.node;
      const address = addressString(node.address);
      const updatedAt = revisionTimestamps.get(
        Number(node.lastRevisionIndex),
      );
      const updatedMessage = revisionMessages.get(
        Number(node.lastRevisionIndex),
      );
      const updatedRevision = revisionSignatures.get(
        Number(node.lastRevisionIndex),
      );
      nodes.push({
        path: node.path,
        type: nodeType(node.nodeType),
        size: Number(node.size),
        ...(address ? { address } : {}),
        executable: Number(node.mode) === 1,
        ...(updatedAt ? { updatedAt } : {}),
        ...(updatedMessage ? { updatedMessage } : {}),
        ...(updatedRevision ? { updatedRevision } : {}),
      });
    }
    if (
      input.revisionNumber === undefined &&
      (input.includeLastRevision ?? true)
    ) {
      await this.attributeTreeNodes(
        input.repositoryId,
        input.branchId,
        input.token,
        nodes,
      );
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    });
  }

  private async attributeTreeNodes(
    repositoryId: string,
    branchId: string,
    token: string,
    nodes: TreeNodeSummary[],
  ): Promise<void> {
    const pending = new Set(nodes.filter((node) => !node.updatedAt));
    if (pending.size === 0) {
      return;
    }
    const revisions = (
      await this.listRevisions(repositoryId, branchId, token)
    ).sort((left, right) => right.number - left.number);
    for (let index = 0; index < revisions.length && pending.size > 0; index++) {
      const revision = revisions[index]!;
      const older = revisions[index + 1];
      const changedPaths = older
        ? (
            await this.getRevisionDiff({
              repositoryId,
              from: older.signature,
              to: revision.signature,
              token,
            })
          ).files.flatMap((file) => [file.path, file.pathFrom])
        : nodes.map((node) => node.path);
      for (const node of pending) {
        if (changedPaths.some((changed) => pathWasChanged(changed, node.path))) {
          node.updatedAt = revision.timestamp;
          node.updatedMessage = revision.message;
          node.updatedRevision = revision.signature;
          pending.delete(node);
        }
      }
    }
  }

  async getRevisionDiff(input: {
    repositoryId: string;
    from: string;
    to: string;
    token: string;
  }): Promise<RevisionDiff> {
    const stream = this.thinClient.revisionDiff!(
      {
        signatureFrom: Buffer.from(input.from, "hex"),
        signatureTo: Buffer.from(input.to, "hex"),
      },
      metadataFor(input.token, input.repositoryId),
    );
    const files: RevisionDiff["files"] = [];
    for await (const value of stream as AsyncIterable<any>) {
      if (!value.change) {
        continue;
      }
      const change = value.change;
      files.push({
        path: change.path,
        action: actionType(change.action),
        type:
          change.nodeType === "FILE" || change.nodeType === 1
            ? "file"
            : change.nodeType === "LINK" || change.nodeType === 2
              ? "link"
              : "directory",
        pathFrom: change.pathFrom,
        addressFrom: change.contentFrom,
        addressTo: change.contentTo,
        automerged: Boolean(change.automerged),
      });
    }
    return { files };
  }

  async getTextDiff(input: {
    repositoryId: string;
    from?: string;
    to: string;
    toAddress?: string;
    path: string;
    token: string;
  }): Promise<TextDiff> {
    const metadata = metadataFor(input.token, input.repositoryId);
    let fromAddress: any = undefined;
    let toAddress = parseAddress(input.toAddress);
    if (input.from) {
      const diffStream = this.thinClient.revisionDiff!(
        {
          signatureFrom: Buffer.from(input.from, "hex"),
          signatureTo: Buffer.from(input.to, "hex"),
        },
        metadata,
      );
      for await (const value of diffStream as AsyncIterable<any>) {
        if (value.change?.path === input.path) {
          fromAddress = value.change.contentFrom;
          toAddress = value.change.contentTo;
          break;
        }
      }
    }
    const maxBytes = 2 * 1024 * 1024;
    const [fromContent, toContent] = await Promise.all([
      fromAddress
        ? this.fetchContentBytes(input.repositoryId, fromAddress, input.token)
        : Promise.resolve(Buffer.alloc(0)),
      toAddress
        ? this.fetchContentBytes(input.repositoryId, toAddress, input.token)
        : Promise.resolve(Buffer.alloc(0)),
    ]);
    const truncated =
      fromContent.byteLength > maxBytes || toContent.byteLength > maxBytes;
    const binary =
      isBinary(fromContent) || isBinary(toContent);
    if (truncated || binary) {
      return {
        binary,
        truncated,
        hasConflicts: false,
        linesAdded: 0,
        linesDeleted: 0,
        text: "",
      };
    }
    let fromText: string;
    let toText: string;
    try {
      fromText = new TextDecoder("utf-8", { fatal: true }).decode(fromContent);
      toText = new TextDecoder("utf-8", { fatal: true }).decode(toContent);
    } catch {
      return {
        binary: true,
        truncated: false,
        hasConflicts: false,
        linesAdded: 0,
        linesDeleted: 0,
        text: "",
      };
    }
    const text = createTwoFilesPatch(
      input.path,
      input.path,
      fromText,
      toText,
      "",
      "",
      { context: 3 },
    );
    let linesAdded = 0;
    let linesDeleted = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
      if (line.startsWith("-") && !line.startsWith("---")) linesDeleted++;
    }
    return {
      binary: false,
      truncated: false,
      hasConflicts: false,
      linesAdded,
      linesDeleted,
      text,
    };
  }

  async getBlob(input: {
    repository: RepositoryRecord;
    address: string;
    token: string;
  }): Promise<BlobResponse> {
    const repositoryHex = uuidToBytes(input.repository.id).toString("hex");
    const response = await fetch(
      `${this.config.loreHttpUrl}/v1/repository/${repositoryHex}/content/${encodeURIComponent(input.address)}`,
      {
        headers: { Authorization: `Bearer ${input.token}` },
      },
    );
    if (!response.ok || !response.body) {
      if (response.status === 404) {
        throw notFound("File content not found");
      }
      throw new AppError(
        "lore_unavailable",
        503,
        `Lore content request failed with status ${response.status}`,
      );
    }
    const contentLength =
      Number(response.headers.get("content-length")) || undefined;
    return {
      body: response.body,
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      ...(contentLength ? { contentLength } : {}),
    };
  }

  private async fetchContentBytes(
    repositoryId: string,
    address: { hash?: Uint8Array; context?: Uint8Array },
    token: string,
  ): Promise<Buffer> {
    const value = addressString(address);
    if (!value) {
      return Buffer.alloc(0);
    }
    const repositoryHex = uuidToBytes(repositoryId).toString("hex");
    const response = await fetch(
      `${this.config.loreHttpUrl}/v1/repository/${repositoryHex}/content/${encodeURIComponent(value)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      if (response.status === 404) {
        throw notFound("File content not found");
      }
      throw new AppError(
        "lore_unavailable",
        503,
        `Lore content request failed with status ${response.status}`,
      );
    }
    return readCappedBody(response, 2 * 1024 * 1024);
  }
}

function pathWasChanged(changed: string, nodePath: string): boolean {
  return (
    changed === nodePath ||
    changed.startsWith(`${nodePath}/`) ||
    nodePath.startsWith(`${changed}/`)
  );
}

function isBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 4096));
  return sample.includes(0);
}

async function readCappedBody(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks, total);
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return Buffer.alloc(limit + 1);
    }
    chunks.push(Buffer.from(value));
  }
}
