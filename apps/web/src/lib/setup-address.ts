export interface UnifiedSetupAddress {
  webPublicUrl: string;
  lorePublicUrl: string;
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
      : `${isLocalAddressInput(trimmed) ? "http" : "https"}://${trimmed}`;
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
    return parsed.protocol === "http:" && isLocalAddressInput(authority)
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

function isLocalAddressInput(value: string): boolean {
  const bracketed = value.match(/^\[([^\]]+)\]/);
  const host = (
    bracketed?.[1] ?? value.split(":")[0] ?? ""
  ).toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) {
    return true;
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
    return false;
  }
  const [first = 0, second = 0] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function needsLoreCertificate(loreAddress: string): boolean {
  try {
    const parsed = new URL(loreAddress);
    if (!["lore:", "lores:", "grpcs:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host === "::1" || host.endsWith(".local")) {
      return false;
    }
    const ipv4 = host.match(/^(\d+)\.(\d+)\./);
    if (ipv4) {
      const first = Number(ipv4[1]);
      const second = Number(ipv4[2]);
      return !(
        first === 10 ||
        first === 127 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      );
    }
    return true;
  } catch {
    return false;
  }
}
