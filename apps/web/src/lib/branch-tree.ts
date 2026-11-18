import type { BranchSummary } from "@lore-portal/shared";

export type BranchRow = BranchSummary & {
  depth: number;
  hasChildren: boolean;
};

export function buildBranchRows(
  branches: BranchSummary[],
  defaultBranchId: string,
): BranchRow[] {
  const ids = new Set(branches.map((branch) => branch.id));
  const children = new Map<string | null, BranchSummary[]>();
  for (const branch of branches) {
    const parentId =
      branch.parentBranchId && ids.has(branch.parentBranchId)
        ? branch.parentBranchId
        : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(branch);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => {
      if (left.id === defaultBranchId) return -1;
      if (right.id === defaultBranchId) return 1;
      return left.name.localeCompare(right.name);
    });
  }

  const result: BranchRow[] = [];
  const visited = new Set<string>();
  const visit = (branch: BranchSummary, depth: number) => {
    if (visited.has(branch.id)) return;
    visited.add(branch.id);
    const childBranches = children.get(branch.id) ?? [];
    result.push({
      ...branch,
      depth,
      hasChildren: childBranches.length > 0,
    });
    for (const child of childBranches) {
      visit(child, depth + 1);
    }
  };
  for (const root of children.get(null) ?? []) {
    visit(root, 0);
  }
  for (const branch of branches) {
    visit(branch, 0);
  }
  return result;
}
