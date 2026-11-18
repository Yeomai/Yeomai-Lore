"use client";

export async function clientApi<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await response.json().catch(() => null)) as
    | { error?: { message?: string; error_description?: string } }
    | T
    | null;
  if (!response.ok) {
    const error =
      data && typeof data === "object" && "error" in data
        ? typeof data.error === "string"
          ? data.error
          : data.error?.message ?? data.error?.error_description
        : null;
    throw new Error(error ?? "Request failed");
  }
  return data as T;
}
