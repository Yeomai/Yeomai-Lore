export function safeLoginRedirect(
  value: string | string[] | undefined,
): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\")
  ) {
    return "/dashboard";
  }
  try {
    const url = new URL(candidate, "http://portal.local");
    if (url.origin !== "http://portal.local") {
      return "/dashboard";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/dashboard";
  }
}
