export function isSameHttpAddress(left: string, right: string): boolean {
  try {
    const first = new URL(left);
    const second = new URL(right);
    if (
      !["http:", "https:"].includes(first.protocol) ||
      first.protocol !== second.protocol
    ) {
      return false;
    }
    return (
      first.hostname.toLowerCase() === second.hostname.toLowerCase() &&
      effectivePort(first) === effectivePort(second)
    );
  } catch {
    return false;
  }
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}
