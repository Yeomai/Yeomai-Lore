export const FILE_INDEX_MAX_FILES = 200_000;
export const FILE_INDEX_MAX_DIRECTORIES = 10_000;
export const FILE_INDEX_MAX_BYTES = 64 * 1024 * 1024;

export interface RepositoryFileIndex {
  revision: string;
  entries: string[];
  truncated: boolean;
}

interface FileIndexLore {
  getRevisionTree(input: {
    repositoryId: string;
    branchId: string;
    path?: string;
    maxDepth?: number;
    includeLastRevision?: boolean;
    token: string;
  }): Promise<
    Array<{
      path: string;
      type: "directory" | "file" | "link";
    }>
  >;
}

interface CacheEntry {
  expiresAt: number;
  bytes: number;
  value: RepositoryFileIndex;
}

export class RepositoryFileIndexCache {
  private readonly values = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 5,
    private readonly maxBytes = FILE_INDEX_MAX_BYTES,
  ) {}

  get(key: string): RepositoryFileIndex | null {
    const cached = this.values.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return cached.value;
  }

  set(key: string, value: RepositoryFileIndex): void {
    const bytes =
      256 +
      value.entries.reduce((total, entry) => total + entry.length + 16, 0);
    if (bytes > this.maxBytes) return;

    this.values.delete(key);
    this.values.set(key, {
      expiresAt: Date.now() + this.ttlMs,
      bytes,
      value,
    });
    while (
      this.values.size > this.maxEntries ||
      this.totalBytes() > this.maxBytes
    ) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.values.values()) total += entry.bytes;
    return total;
  }
}

export async function buildRepositoryFileIndex(
  lore: FileIndexLore,
  input: {
    repositoryId: string;
    branchId: string;
    revision: string;
    token: string;
  },
): Promise<RepositoryFileIndex> {
  const files = new Set<string>();
  const directories = [""];
  const visitedDirectories = new Set<string>();
  let truncated = false;

  while (directories.length > 0 && files.size < FILE_INDEX_MAX_FILES) {
    const directory = directories.shift()!;
    if (visitedDirectories.has(directory)) continue;
    if (visitedDirectories.size >= FILE_INDEX_MAX_DIRECTORIES) {
      truncated = true;
      break;
    }
    visitedDirectories.add(directory);

    const nodes = await lore.getRevisionTree({
      repositoryId: input.repositoryId,
      branchId: input.branchId,
      path: directory,
      maxDepth: 32,
      includeLastRevision: false,
      token: input.token,
    });
    for (const node of nodes) {
      if (node.type === "file") {
        files.add(node.path);
        if (files.size >= FILE_INDEX_MAX_FILES) {
          truncated = true;
          break;
        }
      } else if (
        node.type === "directory" &&
        node.path.split("/").length >= 31
      ) {
        directories.push(node.path);
      }
    }
  }

  return {
    revision: input.revision,
    entries: [...files].sort(),
    truncated,
  };
}
