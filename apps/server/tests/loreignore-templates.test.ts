import { describe, expect, it } from "vitest";
import {
  IGNORE_TEMPLATE_IDS,
  readIgnoreTemplate,
} from "../src/templates/loreignore.ts";

describe("built-in .loreignore templates", () => {
  it("loads project-specific rules and system metadata exclusions", async () => {
    const templates = await Promise.all(
      IGNORE_TEMPLATE_IDS.map((id) => readIgnoreTemplate(id)),
    );

    for (const template of templates) {
      expect(template).toContain(".DS_Store");
      expect(template).toContain(".vscode/");
    }
    expect(templates[0]).toContain("*.sln");
    expect(templates[0]).toContain("Intermediate/");
    expect(templates[1]).toContain("[Ll]ibrary/");
    expect(templates[1]).toContain("*.csproj");
    expect(templates[2]).toContain(".next/");
    expect(templates[2]).toContain("!.env.example");
  });
});
