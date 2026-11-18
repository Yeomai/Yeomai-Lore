import { describe, expect, it } from "vitest";
import { contextBytesToString, contextToBytes } from "./ids.ts";

describe("Lore context IDs", () => {
  it("round-trips non-RFC UUID branch contexts", () => {
    const branchId = "e726318b-bc3f-d75a-c873-3a7e030cc35b";
    expect(contextBytesToString(contextToBytes(branchId))).toBe(branchId);
  });
});
