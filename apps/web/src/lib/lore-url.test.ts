import { describe, expect, it } from "vitest";
import { formatLoreAddress } from "./lore-url";

describe("formatLoreAddress", () => {
  it("omits default secure ports", () => {
    expect(formatLoreAddress("lores://lore.example.com:443")).toBe(
      "lores://lore.example.com",
    );
    expect(formatLoreAddress("grpcs://lore.example.com:443")).toBe(
      "grpcs://lore.example.com",
    );
  });

  it("keeps non-default ports and invalid input", () => {
    expect(formatLoreAddress("lores://lore.example.com:8443")).toBe(
      "lores://lore.example.com:8443",
    );
    expect(formatLoreAddress("not a url")).toBe("not a url");
  });
});
