import { describe, expect, it } from "vitest";
import type { RevisionSummary } from "@lore-portal/shared";
import { buildCommitGraph, commitEdgePath } from "./commit-graph";

function revision(
  signature: string,
  timestamp: number,
  parents: string[] = [],
): RevisionSummary {
  return {
    signature,
    branchId: "branch",
    number: timestamp,
    parents,
    message: signature,
    createdBy: "admin",
    committedBy: "admin",
    timestamp,
  };
}

describe("commit graph", () => {
  it("keeps a merged side branch in its own lane until it rejoins", () => {
    const rows = buildCommitGraph([
      revision("merge", 5, ["develop", "archived"]),
      revision("develop", 4, ["base"]),
      revision("archived", 3, ["base"]),
      revision("base", 2),
    ]);

    expect(
      rows.map(({ signature, lane, activeLaneCount, parentLanes }) => ({
        signature,
        lane,
        activeLaneCount,
        parents: parentLanes.map(({ lane }) => lane),
      })),
    ).toEqual([
      { signature: "merge", lane: 0, activeLaneCount: 2, parents: [0, 1] },
      { signature: "develop", lane: 0, activeLaneCount: 2, parents: [0] },
      { signature: "archived", lane: 1, activeLaneCount: 2, parents: [0] },
      { signature: "base", lane: 0, activeLaneCount: 1, parents: [] },
    ]);
  });

  it("routes lane changes with a smooth cubic curve", () => {
    expect(commitEdgePath(14, 32, 0, 2)).toMatch(
      /^M 14 22 C 14 .+, 32 .+, 32 .+ L 32 110$/,
    );
  });
});
