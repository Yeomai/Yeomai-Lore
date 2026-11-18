import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { SessionUser } from "@lore-portal/shared";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function getSetupStatus(): Promise<{
  required: boolean;
  defaults: {
    siteName: string;
    webPublicUrl: string;
    lorePublicUrl: string;
    userRegistrationEnabled: boolean;
    username: string;
    email: string;
    smtp: {
      enabled: boolean;
      host: string;
      port: number;
      security: "starttls" | "ssl" | "none";
      username: string;
      password: string;
      fromName: string;
      fromEmail: string;
    };
  } | null;
}> {
  return serverApi("/api/v1/setup");
}

export async function isServiceReady(): Promise<boolean> {
  try {
    const response = await fetch(`${apiInternalUrl}/api/v1/ready`, {
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function serverApi<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const cookieStore = await cookies();
  const response = await fetch(`${apiInternalUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
      cookie: cookieStore.toString(),
    },
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | T
    | null;
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? data.error?.message ?? "Request failed"
        : "Request failed";
    throw new ApiRequestError(message, response.status);
  }
  return data as T;
}

export async function serverApiResponse(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const cookieStore = await cookies();
  const response = await fetch(`${apiInternalUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      cookie: cookieStore.toString(),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ApiRequestError(
      data?.error?.message ?? "Request failed",
      response.status,
    );
  }
  return response;
}

export async function getSession(): Promise<SessionUser | null> {
  const data = await serverApi<{ user: SessionUser | null }>(
    "/api/v1/auth/session",
  );
  return data.user;
}

export async function requirePageUser(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export async function requirePageAdmin(): Promise<SessionUser> {
  const user = await requirePageUser();
  if (user.globalRole !== "admin") {
    redirect("/dashboard");
  }
  return user;
}

export function apiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
