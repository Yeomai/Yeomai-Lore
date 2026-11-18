import { describe, expect, it } from "vitest";
import { buildDiffFileTree } from "./diff-tree";

describe("diff file tree", () => {
  it("groups changed files by directory", () => {
    expect(
      buildDiffFileTree([
        { path: "README.md" },
        { path: "src/app.ts" },
        { path: "src/lib/util.ts" },
      ]),
    ).toEqual([
      {
        type: "directory",
        name: "src",
        path: "src",
        children: [
          {
            type: "directory",
            name: "lib",
            path: "src/lib",
            children: [
              { type: "file", name: "util.ts", path: "src/lib/util.ts" },
            ],
          },
          { type: "file", name: "app.ts", path: "src/app.ts" },
        ],
      },
      { type: "file", name: "README.md", path: "README.md" },
    ]);
  });
});
