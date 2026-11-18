import { describe, expect, it } from "vitest";
import { loreProto } from "../src/lore/grpc-client.ts";

describe("vendored Lore protocol", () => {
  it("loads the public services used by the portal", () => {
    expect(loreProto.lore.repository.v1.RepositoryService).toBeTypeOf("function");
    expect(loreProto.lore.revision.v1.RevisionService).toBeTypeOf("function");
    expect(loreProto.lore.thin_client.v1.ThinClientService).toBeTypeOf("function");
    expect(loreProto.lore.user.v1.UserService).toBeTypeOf("function");
    expect(
      loreProto.lore.user.v1.RepositoryRegistryService,
    ).toBeTypeOf("function");
  });
});
