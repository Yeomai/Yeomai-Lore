import { describe, expect, it } from "vitest";
import { isSameHttpAddress } from "./urls";

describe("HTTP address comparison", () => {
  it("treats equivalent HTTP origins as the same address", () => {
    expect(
      isSameHttpAddress("https://example.com", "https://example.com:443"),
    ).toBe(true);
    expect(
      isSameHttpAddress("http://EXAMPLE.com:80", "http://example.com"),
    ).toBe(true);
  });

  it("allows different schemes, ports, and Lore schemes", () => {
    expect(
      isSameHttpAddress("https://example.com", "http://example.com"),
    ).toBe(false);
    expect(
      isSameHttpAddress("https://example.com", "https://example.com:41337"),
    ).toBe(false);
    expect(
      isSameHttpAddress("https://example.com", "lores://example.com:41337"),
    ).toBe(false);
  });
});
