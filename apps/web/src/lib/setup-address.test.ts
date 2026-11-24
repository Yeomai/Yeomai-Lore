import { describe, expect, it } from "vitest";
import {
  classifySetupAddress,
  deriveLoreAddress,
  deriveUnifiedPublicAddress,
  needsLoreCertificate,
  toUnifiedSetupAddress,
} from "./setup-address";

describe("setup addresses", () => {
  it("classifies the three setup modes", () => {
    expect(classifySetupAddress("localhost:3000")).toBe("local");
    expect(classifySetupAddress("http://127.0.0.1:3000")).toBe("local");
    expect(classifySetupAddress("192.168.1.20:3000")).toBe("ip");
    expect(classifySetupAddress("118.89.28.163:3000")).toBe("ip");
    expect(classifySetupAddress("[::1]:3000")).toBe("local");
    expect(classifySetupAddress("lore.example.com:3000")).toBe("domain");
  });

  it("derives the full initial Lore address", () => {
    expect(deriveLoreAddress("http://localhost:3000")).toBe(
      "lore://localhost:3000",
    );
    expect(deriveLoreAddress("https://lore.example.com")).toBe(
      "lores://lore.example.com",
    );
  });

  it("requires an uploaded certificate only for domain names", () => {
    expect(needsLoreCertificate("lore://lore.example.com:41337")).toBe(true);
    expect(needsLoreCertificate("lores://localhost:41337")).toBe(false);
    expect(needsLoreCertificate("lores://192.168.1.20:41337")).toBe(false);
    expect(needsLoreCertificate("lores://118.89.28.163:3000")).toBe(false);
    expect(needsLoreCertificate("lores://lore.example.com:41337")).toBe(true);
    expect(needsLoreCertificate("grpcs://lore.example.com")).toBe(true);
    expect(needsLoreCertificate("https://lore.example.com")).toBe(true);
  });

  it("derives Web and Lore from one setup address", () => {
    expect(deriveUnifiedPublicAddress("localhost:3000")).toEqual({
      webPublicUrl: "http://localhost:3000",
      lorePublicUrl: "lore://localhost:3000",
    });
    expect(deriveUnifiedPublicAddress("lore.example.com")).toEqual({
      webPublicUrl: "https://lore.example.com",
      lorePublicUrl: "lores://lore.example.com",
    });
    expect(deriveUnifiedPublicAddress("http://192.168.1.20:3000")).toEqual({
      webPublicUrl: "http://192.168.1.20:3000",
      lorePublicUrl: "lore://192.168.1.20:3000",
    });
    expect(deriveUnifiedPublicAddress("192.168.1.20:3000")).toEqual({
      webPublicUrl: "https://192.168.1.20:3000",
      lorePublicUrl: "lores://192.168.1.20:3000",
    });
    expect(toUnifiedSetupAddress("http://localhost:3000")).toBe(
      "localhost:3000",
    );
    expect(toUnifiedSetupAddress("https://lore.example.com")).toBe(
      "lore.example.com",
    );
  });
});
