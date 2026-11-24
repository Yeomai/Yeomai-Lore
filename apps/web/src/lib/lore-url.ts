const DEFAULT_PORTS = new Map([
  ["http:", "80"],
  ["https:", "443"],
  ["lore:", "80"],
  ["lores:", "443"],
  ["grpc:", "80"],
  ["grpcs:", "443"],
]);

export function formatLoreAddress(value: string): string {
  try {
    const url = new URL(value);
    if (url.port !== DEFAULT_PORTS.get(url.protocol)) return value;
    url.port = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}
