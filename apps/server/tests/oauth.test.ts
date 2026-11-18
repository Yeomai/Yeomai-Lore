import { describe, expect, it } from "vitest";
import {
  OAuthProtocolError,
  resourceIdFromAbsoluteResource,
} from "../src/auth/oauth-service.ts";

describe("Lore repository token exchange target", () => {
  it("resolves the repository id from the configured absolute resource", () => {
    const id = "019be4b0-1736-7a42-9f77-46d000000003";
    expect(
      resourceIdFromAbsoluteResource(
        `http://localhost:3000/lore/repositories/${id}`,
        "http://localhost:3000",
      ),
    ).toBe(id);
  });

  it("accepts the 32-hex repository id used by the Lore client", () => {
    expect(
      resourceIdFromAbsoluteResource(
        "http://localhost:3000/lore/repositories/019be4b017367a429f7746d000000003",
        "http://localhost:3000",
      ),
    ).toBe("019be4b0-1736-7a42-9f77-46d000000003");
  });

  it("rejects a resource outside the configured issuer origin", () => {
    expect(() =>
      resourceIdFromAbsoluteResource(
        "https://attacker.example/lore/repositories/019be4b0-1736-7a42-9f77-46d000000003",
        "http://localhost:3000",
      ),
    ).toThrow(OAuthProtocolError);
  });

  it("rejects a malformed repository id", () => {
    expect(() =>
      resourceIdFromAbsoluteResource(
        "http://localhost:3000/lore/repositories/not-a-repository",
        "http://localhost:3000",
      ),
    ).toThrow(OAuthProtocolError);
  });
});
