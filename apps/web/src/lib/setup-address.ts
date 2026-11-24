export interface UnifiedSetupAddress {
  webPublicUrl: string;
  lorePublicUrl: string;
}

export type SetupDeploymentMode = "local" | "ip" | "domain";

export function classifySetupAddress(
  value: string,
): SetupDeploymentMode | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    parsed = new URL(
      hasScheme
        ? trimmed
        : `${isLoopbackAddressInput(trimmed) ? "http" : "https"}://${trimmed}`,
    );
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) {
    return "local";
  }
  const octets = host.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    )
  ) {
    return "ip";
  }
  return host.includes(":") ? "ip" : "domain";
}

export function deriveUnifiedPublicAddress(
  value: string,
): UnifiedSetupAddress | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const candidate = hasScheme
      ? trimmed
      : `${isLoopbackAddressInput(trimmed) ? "http" : "https"}://${trimmed}`;
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  const loreProtocol = parsed.protocol === "https:" ? "lores" : "lore";
  const lorePort =
    (parsed.port && `:${parsed.port}`) ||
    (parsed.protocol === "https:" ? "" : ":80");
  return {
    webPublicUrl: `${parsed.protocol}//${parsed.host}`,
    lorePublicUrl: `${loreProtocol}://${parsed.hostname}${lorePort}`,
  };
}

export function toUnifiedSetupAddress(webAddress: string): string {
  try {
    const parsed = new URL(webAddress);
    const authority = parsed.host;
    return parsed.protocol === "http:" && isLoopbackAddressInput(authority)
      ? authority
      : parsed.protocol === "https:"
        ? authority
        : parsed.origin;
  } catch {
    return webAddress;
  }
}

export function deriveLoreAddress(webAddress: string): string {
  try {
    const parsed = new URL(webAddress);
    const protocol = parsed.protocol === "https:" ? "lores" : "lore";
    const hostname =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
        ? "localhost"
        : parsed.hostname;
    if (protocol === "lores") {
      return parsed.port && parsed.port !== "443"
        ? `${protocol}://${hostname}:${parsed.port}`
        : `${protocol}://${hostname}`;
    }
    return `${protocol}://${hostname}:${parsed.port || "80"}`;
  } catch {
    return "lore://localhost:3000";
  }
}

function isLoopbackAddressInput(value: string): boolean {
  const bracketed = value.match(/^\[([^\]]+)\]/);
  const host = (
    bracketed?.[1] ?? value.split(":")[0] ?? ""
  ).toLowerCase();
  if (host === "localhost" || host === "::1") {
    return true;
  }
  return host === "127.0.0.1" || host.startsWith("127.");
}

export function needsLoreCertificate(loreAddress: string): boolean {
  try {
    const parsed = new URL(loreAddress);
    if (!["lore:", "lores:", "grpcs:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host === "::1") {
      return false;
    }
    return !host.includes(":") &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}
