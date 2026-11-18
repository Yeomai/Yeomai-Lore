import { describe, expect, it } from "vitest";
import { repositoryLabel } from "./repository-label";

describe("repositoryLabel", () => {
  const repository = {
    ownerUserId: "user-1",
    organizationSlug: "admin",
    slug: "my-project",
  };

  it("hides the owner namespace for the current user's personal repository", () => {
    expect(repositoryLabel(repository, "user-1")).toBe("my-project");
  });

  it("shows another owner's namespace", () => {
    expect(repositoryLabel(repository, "user-2")).toBe("admin/my-project");
  });

  it("shows the organization namespace", () => {
    expect(
      repositoryLabel({ ...repository, ownerUserId: null }, "user-1"),
    ).toBe("admin/my-project");
  });
});
