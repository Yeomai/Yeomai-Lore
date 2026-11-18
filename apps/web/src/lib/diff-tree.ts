export type DiffTreeNode =
  | {
      type: "file";
      name: string;
      path: string;
    }
  | {
      type: "directory";
      name: string;
      path: string;
      children: DiffTreeNode[];
    };

interface MutableDirectory {
  type: "directory";
  name: string;
  path: string;
  children: Map<string, MutableDirectory | MutableFile>;
}

interface MutableFile {
  type: "file";
  name: string;
  path: string;
}

export function buildDiffFileTree(
  files: Array<{ path: string }>,
): DiffTreeNode[] {
  const root = new Map<string, MutableDirectory | MutableFile>();
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let current = root;
    for (let index = 0; index < segments.length; index++) {
      const name = segments[index]!;
      const itemPath = segments.slice(0, index + 1).join("/");
      const isFile = index === segments.length - 1;
      if (isFile) {
        current.set(name, { type: "file", name, path: itemPath });
        continue;
      }
      let directory = current.get(name);
      if (!directory || directory.type !== "directory") {
        directory = {
          type: "directory",
          name,
          path: itemPath,
          children: new Map(),
        };
        current.set(name, directory);
      }
      current = directory.children;
    }
  }
  return toNodes(root);
}

function toNodes(
  items: Map<string, MutableDirectory | MutableFile>,
): DiffTreeNode[] {
  return [...items.values()]
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .map((item): DiffTreeNode =>
      item.type === "directory"
        ? { ...item, children: toNodes(item.children) }
        : item,
    );
}
