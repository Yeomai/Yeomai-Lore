import { describe, expect, it } from "vitest";
import {
  effectiveRepositoryPermission,
  loreActionsForPermission,
  permissionSatisfies,
} from "./permissions.ts";

describe("repository permissions", () => {
  it("does not grant a global admin implicit repository access", () => {
    expect(
      effectiveRepositoryPermission({
        globalRole: "admin",
        orgRole: null,
        directGrants: [],
        teamGrants: [],
      }),
    ).toBeNull();
  });

  it("lets a global admin use an explicit repository grant", () => {
    expect(
      effectiveRepositoryPermission({
        globalRole: "admin",
        orgRole: null,
        directGrants: [{ permission: "read" }],
        teamGrants: [],
      }),
    ).toBe("read");
  });

  it("uses the strongest direct or team grant", () => {
    expect(
      effectiveRepositoryPermission({
        globalRole: "user",
        orgRole: "member",
        directGrants: [{ permission: "read" }],
        teamGrants: [{ permission: "write" }],
      }),
    ).toBe("write");
  });

  it("does not let an org member inherit repository access", () => {
    expect(
      effectiveRepositoryPermission({
        globalRole: "user",
        orgRole: "member",
        directGrants: [],
        teamGrants: [],
      }),
    ).toBeNull();
  });

  it("enforces the permission hierarchy", () => {
    expect(permissionSatisfies("write", "read")).toBe(true);
    expect(permissionSatisfies("read", "write")).toBe(false);
    expect(permissionSatisfies(null, "read")).toBe(false);
  });

  it("maps read-only access to a read-only Lore token", () => {
    expect(loreActionsForPermission("read")).toEqual(["read"]);
  });
});
