import { describe, expect, it } from "vitest";
import {
  cachedValue,
  shouldRefreshServerCache,
} from "./server-cache";

describe("server cache", () => {
  it("bypasses cache on a full browser reload but not an RSC navigation", () => {
    expect(
      shouldRefreshServerCache(
        new Headers({ "cache-control": "max-age=0" }),
      ),
    ).toBe(true);
    expect(
      shouldRefreshServerCache(new Headers({ pragma: "no-cache" })),
    ).toBe(true);
    expect(
      shouldRefreshServerCache(
        new Headers({ rsc: "1", "cache-control": "max-age=0" }),
      ),
    ).toBe(false);
    expect(shouldRefreshServerCache(new Headers())).toBe(false);
  });

  it("reloads a cached value when force is requested", async () => {
    const key = `test:${crypto.randomUUID()}`;
    let calls = 0;
    const load = async () => ++calls;

    expect(await cachedValue(key, 600_000, load)).toBe(1);
    expect(await cachedValue(key, 600_000, load)).toBe(1);
    expect(
      await cachedValue(key, 600_000, load, { force: true }),
    ).toBe(2);
  });
});
