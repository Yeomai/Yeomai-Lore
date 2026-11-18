import { describe, expect, it } from "vitest";
import type { BranchSummary } from "@lore-portal/shared";
import { buildBranchRows } from "./branch-tree";

function branch(
  id: string,
  name: string,
  parentBranchId: string | null,
): BranchSummary {
  return {
    id,
    name,
    creator: "admin",
    latest: id.padEnd(64, "0"),
    deleted: false,
    parentBranchId,
    parentRevision: parentBranchId ? "1".repeat(64) : null,
  };
}

describe("branch tree", () => {
  it("orders parent branches before children and marks their depth", () => {
    const rows = buildBranchRows(
      [
        branch("develop2", "develop2", "develop"),
        branch("develop", "develop", "main"),
        branch("main", "main", null),
      ],
      "main",
    );
    expect(rows.map(({ name, depth, hasChildren }) => ({
      name,
      depth,
      hasChildren,
    }))).toEqual([
      { name: "main", depth: 0, hasChildren: true },
      { name: "develop", depth: 1, hasChildren: true },
      { name: "develop2", depth: 2, hasChildren: false },
    ]);
  });
});
