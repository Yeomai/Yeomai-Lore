import { describe, expect, it } from "vitest";
import { searchFilePaths } from "./file-search";

describe("file path search", () => {
  it("prioritizes file name matches and supports fuzzy path matches", () => {
    const results = searchFilePaths(
      [
        "docs/en/manual/01-quick-start.md",
        "src/shared/lib/moveSource.ts",
        "src/main.tsx",
        "src/services/lore/metadata.ts",
      ],
      "ms",
      10,
    );

    expect(results.map((result) => result.path).slice(0, 3)).toEqual([
      "src/shared/lib/moveSource.ts",
      "src/main.tsx",
      "src/services/lore/metadata.ts",
    ]);
    expect(results[0]?.indices.length).toBe(2);
  });

  it("limits the result set", () => {
    const results = searchFilePaths(
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      "src",
      2,
    );
    expect(results).toHaveLength(2);
  });
});
