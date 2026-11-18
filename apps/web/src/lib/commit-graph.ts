import type { RevisionSummary } from "@lore-portal/shared";

export const COMMIT_LANE_WIDTH = 18;
export const COMMIT_ROW_HEIGHT = 44;
export const COMMIT_ROW_TOP = 22;
export const COMMIT_GRAPH_PADDING = 14;

export const COMMIT_LANE_COLORS = [
  "#31894b",
  "#cf517d",
  "#a88416",
  "#8f5db7",
  "#2c82c2",
  "#d36b2f",
];

export interface CommitGraphRow extends RevisionSummary {
  lane: number;
  parentLanes: Array<{ signature: string; lane: number }>;
  color: string;
}

export function commitEdgePath(
  fromX: number,
  toX: number,
  fromRow: number,
  toRow: number,
): string {
  const fromY = fromRow * COMMIT_ROW_HEIGHT + COMMIT_ROW_TOP;
  const toY = toRow * COMMIT_ROW_HEIGHT + COMMIT_ROW_TOP;
  if (fromX === toX) {
    return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  }
  const span = toY - fromY;
  const bend = Math.min(COMMIT_ROW_HEIGHT * 0.6, span / 3);
  const startEnd = fromY + bend;
  return [
    `M ${fromX} ${fromY}`,
    `C ${fromX} ${fromY + bend / 2}, ${toX} ${startEnd - bend / 2}, ${toX} ${startEnd}`,
    `L ${toX} ${toY}`,
  ].join(" ");
}

export function buildCommitGraph(
  revisions: RevisionSummary[],
): CommitGraphRow[] {
  const bySignature = new Map(
    revisions.map((revision) => [revision.signature, revision]),
  );
  const childCount = new Map(
    revisions.map((revision) => [revision.signature, 0]),
  );
  for (const revision of revisions) {
    for (const parent of revision.parents) {
      if (childCount.has(parent)) {
        childCount.set(parent, childCount.get(parent)! + 1);
      }
    }
  }
  const ready = revisions
    .filter((revision) => childCount.get(revision.signature) === 0)
    .sort((left, right) => right.timestamp - left.timestamp);
  const ordered: RevisionSummary[] = [];
  while (ready.length > 0) {
    const revision = ready.shift()!;
    ordered.push(revision);
    for (const parentSignature of revision.parents) {
      const remainingChildren = childCount.get(parentSignature);
      if (remainingChildren === undefined) {
        continue;
      }
      const nextCount = remainingChildren - 1;
      childCount.set(parentSignature, nextCount);
      if (nextCount === 0) {
        ready.push(bySignature.get(parentSignature)!);
        ready.sort((left, right) => right.timestamp - left.timestamp);
      }
    }
  }
  if (ordered.length < revisions.length) {
    ordered.push(
      ...revisions
        .filter((revision) => !ordered.includes(revision))
        .sort((left, right) => right.timestamp - left.timestamp),
    );
  }
  const expected: Array<string | null> = [];
  const positioned: Array<{ revision: RevisionSummary; lane: number }> = [];

  for (const revision of ordered) {
    let lane = expected.findIndex(
      (signature) => signature === revision.signature,
    );
    if (lane < 0) {
      lane = expected.findIndex((signature) => signature === null);
      if (lane < 0) {
        lane = expected.length;
        expected.push(null);
      }
    }
    expected.forEach((signature, index) => {
      if (index !== lane && signature === revision.signature) {
        expected[index] = null;
      }
    });

    const parents = revision.parents.filter((parent) =>
      bySignature.has(parent),
    );
    const firstParent = parents[0];
    const firstAlreadyTracked = expected.some(
      (signature, index) => index !== lane && signature === firstParent,
    );
    expected[lane] =
      firstParent && !firstAlreadyTracked ? firstParent : null;

    for (const parent of parents.slice(1)) {
      if (expected.includes(parent)) {
        continue;
      }
      let parentLane = expected.findIndex(
        (signature, index) => index !== lane && signature === null,
      );
      if (parentLane < 0) {
        parentLane = expected.length;
        expected.push(parent);
      } else {
        expected[parentLane] = parent;
      }
    }
    positioned.push({ revision, lane });
  }

  const laneBySignature = new Map(
    positioned.map(({ revision, lane }) => [revision.signature, lane]),
  );
  return positioned.map(({ revision, lane }) => ({
    ...revision,
    lane,
    parentLanes: revision.parents.flatMap((signature) => {
      const parentLane = laneBySignature.get(signature);
      return parentLane === undefined ? [] : [{ signature, lane: parentLane }];
    }),
    color: COMMIT_LANE_COLORS[lane % COMMIT_LANE_COLORS.length]!,
  }));
}
