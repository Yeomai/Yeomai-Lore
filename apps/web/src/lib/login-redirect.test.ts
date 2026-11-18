import { describe, expect, it } from "vitest";
import { safeLoginRedirect } from "./login-redirect";

describe("safeLoginRedirect", () => {
  it("preserves a local OAuth device return path", () => {
    expect(safeLoginRedirect("/device?user_code=ABCD-EFGH")).toBe(
      "/device?user_code=ABCD-EFGH",
    );
  });

  it("falls back to the dashboard for external redirects", () => {
    expect(safeLoginRedirect("https://attacker.example")).toBe("/dashboard");
    expect(safeLoginRedirect("//attacker.example")).toBe("/dashboard");
    expect(safeLoginRedirect("\\\\attacker.example")).toBe("/dashboard");
  });
});
